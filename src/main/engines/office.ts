import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import os from 'os'
import { isMac, isWin, run, findSoffice, scriptPath, tmpDir } from '../tools'
import { extOf } from '@shared/formats'
import type { ActionOptions } from '@shared/types'

// =============== Windows: persistent PowerShell COM worker ===============
class OfficeWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private idle: NodeJS.Timeout | null = null

  private start() {
    if (this.proc) return
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('office-worker.ps1')], { windowsHide: true })
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', (d: string) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/^﻿/, '').trim()
        this.buf = this.buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        try {
          const msg = JSON.parse(line) as { id: number; ok: boolean; error?: string; result?: unknown }
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Office 변환 실패'))
        } catch {
          /* ignore noise */
        }
      }
    })
    ps.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('Office 작업 프로세스가 종료되었습니다.'))
      this.pending.clear()
      this.proc = null
    })
    this.proc = ps
  }

  call<T = unknown>(op: string, payload: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<T> {
    this.start()
    if (this.idle) clearTimeout(this.idle)
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Office 응답 시간 초과 — 대화상자가 떠 있는지 확인해 주세요.'))
        this.kill()
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          this.armIdle()
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(t)
          this.armIdle()
          reject(e)
        }
      })
      this.proc!.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n')
    })
  }

  private armIdle() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.shutdown(), 90_000)
  }

  async shutdown() {
    if (!this.proc) return
    try {
      await this.call('quit', {}, 15_000)
    } catch {
      /* ignore */
    }
    this.kill()
  }
  kill() {
    this.proc?.kill()
    this.proc = null
  }
}
export const officeWorker = isWin ? new OfficeWorker() : null

// =============== Detection ===============
export interface OfficeAvail {
  word: boolean
  excel: boolean
  powerpoint: boolean
  hancom: boolean
}
let availCache: OfficeAvail | null = null
export async function detectOffice(force = false): Promise<OfficeAvail> {
  if (availCache && !force) return availCache
  let a: OfficeAvail = { word: false, excel: false, powerpoint: false, hancom: false }
  try {
    if (isWin && officeWorker) a = await officeWorker.call<OfficeAvail>('detect', {}, 30_000)
    else if (isMac) {
      const has = (n: string) => existsSync(`/Applications/${n}.app`)
      a = {
        word: has('Microsoft Word'),
        excel: has('Microsoft Excel'),
        powerpoint: has('Microsoft PowerPoint'),
        hancom: false // Hancom for Mac has no stable scripting interface
      }
    }
  } catch {
    /* none */
  }
  availCache = a
  return a
}

// =============== macOS: AppleScript via sandbox-container staging ===============
const MAC_APPS = {
  word: { name: 'Microsoft Word', container: 'com.microsoft.Word' },
  excel: { name: 'Microsoft Excel', container: 'com.microsoft.Excel' },
  powerpoint: { name: 'Microsoft PowerPoint', container: 'com.microsoft.Powerpoint' }
} as const

async function macOffice(app: keyof typeof MAC_APPS, src: string, dst: string, format: string, o: ActionOptions) {
  // Office for Mac is sandboxed: writing into its own container avoids "Grant File Access" prompts.
  const meta = MAC_APPS[app]
  const stage = join(os.homedir(), 'Library', 'Containers', meta.container, 'Data', 'tmp', 'super-conversions')
  await fs.mkdir(stage, { recursive: true })
  const inCopy = join(stage, `in-${Date.now()}${extname(src)}`)
  const outTmp = join(stage, `out-${Date.now()}.${format}`)
  await fs.copyFile(src, inCopy)
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  let script = ''
  if (app === 'powerpoint') {
    const fmt = format === 'pdf' ? 'save as PDF' : 'save as Open XML presentation'
    script = `
tell application "Microsoft PowerPoint"
  open POSIX file "${esc(inCopy)}"
  set p to active presentation
  save p in POSIX file "${esc(outTmp)}" as ${fmt}
  close p saving no
end tell`
  } else if (app === 'word') {
    const fmt = format === 'pdf' ? 'format PDF' : 'format document'
    script = `
set outPath to (POSIX file "${esc(outTmp)}") as string
tell application "Microsoft Word"
  open POSIX file "${esc(inCopy)}"
  set d to active document
  save as d file name outPath file format ${fmt}
  close d saving no
end tell`
  } else {
    const fmt = format === 'pdf' ? 'PDF file format' : format === 'csv' ? 'CSV file format' : 'Excel XML file format'
    const fit =
      format === 'pdf' && o.sheetFit && o.sheetFit !== 'original'
        ? `
  repeat with ws in worksheets of wb
    try
      set zoom of page setup object of ws to false
      set fit to pages wide of page setup object of ws to 1
      ${o.sheetFit === 'onepage' ? 'set fit to pages tall of page setup object of ws to 1' : 'set fit to pages tall of page setup object of ws to false'}
    end try
  end repeat`
        : ''
    script = `
set outPath to (POSIX file "${esc(outTmp)}") as string
tell application "Microsoft Excel"
  open POSIX file "${esc(inCopy)}"
  set wb to active workbook
  ${fit}
  save workbook as wb filename outPath file format ${fmt} with overwrite
  close wb saving no
end tell`
  }
  try {
    const r = await run('osascript', ['-e', script], { timeoutMs: 300_000 })
    if (r.code !== 0) throw new Error(`${meta.name} 자동화 실패: ${r.stderr.trim()}`)
    if (!existsSync(outTmp)) throw new Error(`${meta.name}가 결과 파일을 만들지 못했습니다.`)
    await fs.copyFile(outTmp, dst)
  } finally {
    await fs.rm(inCopy, { force: true })
    await fs.rm(outTmp, { force: true })
  }
}

// =============== LibreOffice fallback ===============
export async function libreConvert(src: string, dst: string, format: string, o: ActionOptions): Promise<void> {
  const soffice = findSoffice()
  if (!soffice) throw new Error('Office가 없고 LibreOffice도 설치되어 있지 않습니다. 설정 › 변환 엔진에서 LibreOffice를 설치하거나 경로를 지정해 주세요.')
  const out = await tmpDir('sc-lo-')
  const profile = await tmpDir('sc-lo-profile-')
  const ext = extOf(src)
  let filter = format
  if (format === 'pdf') {
    const opts: Record<string, { type: string; value: string }> = {
      ExportNotes: { type: 'boolean', value: 'false' },
      EmbedStandardFonts: { type: 'boolean', value: 'true' },
      Quality: { type: 'long', value: '95' },
      ReduceImageResolution: { type: 'boolean', value: 'false' }
    }
    const isSheet = ['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(ext)
    if (isSheet && o.sheetFit === 'onepage') opts.SinglePageSheets = { type: 'boolean', value: 'true' }
    const exp = isSheet ? 'calc_pdf_Export' : ['ppt', 'pptx', 'odp', 'pps', 'ppsx'].includes(ext) ? 'impress_pdf_Export' : 'writer_pdf_Export'
    filter = `pdf:${exp}:${JSON.stringify(opts)}`
  } else if (format === 'docx') filter = 'docx:MS Word 2007 XML'
  else if (format === 'pptx') filter = 'pptx:Impress MS PowerPoint 2007 XML'
  else if (format === 'xlsx') filter = 'xlsx:Calc MS Excel 2007 XML'
  else if (format === 'csv') filter = 'csv:Text - txt - csv (StarCalc):44,34,76,1'
  const profileUrl = 'file:///' + profile.replace(/\\/g, '/').replace(/^\//, '')
  const r = await run(soffice, [`-env:UserInstallation=${profileUrl}`, '--headless', '--norestore', '--convert-to', filter, '--outdir', out, src], { timeoutMs: 600_000 })
  const produced = join(out, basename(src, extname(src)) + '.' + format)
  if (!existsSync(produced)) throw new Error(`LibreOffice 변환 실패: ${(r.stderr || r.stdout).trim().slice(-300)}`)
  await fs.copyFile(produced, dst)
  await fs.rm(out, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
}

// =============== Public API ===============
export type OfficeKind = 'word' | 'excel' | 'powerpoint'
export const kindOf = (src: string): OfficeKind => {
  const e = extOf(src)
  if (['ppt', 'pptx', 'odp', 'pps', 'ppsx'].includes(e)) return 'powerpoint'
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(e)) return 'excel'
  return 'word'
}

/** Convert with the best engine available. Returns which engine produced the file. */
export async function officeConvert(src: string, dst: string, format: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv', o: ActionOptions): Promise<{ engine: string; fidelity: 'high' | 'medium' }> {
  const kind = kindOf(src)
  const avail = await detectOffice()
  const pref = o.engine && o.engine !== 'auto' ? o.engine : 'auto'
  const canOffice = avail[kind] && pref !== 'libreoffice'
  const errors: string[] = []
  if (canOffice) {
    try {
      if (isWin && officeWorker) {
        const op = kind === 'powerpoint' ? 'ppt' : kind
        await officeWorker.call(op, {
          src,
          dst,
          format,
          fit: o.sheetFit ?? 'width',
          orientation: o.orientation ?? 'original',
          bitmapMissingFonts: o.bitmapMissingFonts ?? true
        })
      } else if (isMac) {
        await macOffice(kind, src, dst, format, o)
      }
      if (existsSync(dst)) return { engine: `Microsoft ${kind === 'powerpoint' ? 'PowerPoint' : kind === 'excel' ? 'Excel' : 'Word'}`, fidelity: 'high' }
    } catch (e) {
      errors.push((e as Error).message)
      if (pref === 'office') throw e
    }
  }
  try {
    await libreConvert(src, dst, format, o)
    return { engine: 'LibreOffice', fidelity: 'medium' }
  } catch (e) {
    errors.push((e as Error).message)
    throw new Error(errors.join(' / '))
  }
}
