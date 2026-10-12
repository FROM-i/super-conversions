import { BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { ACTION_BY_ID, extOf, type ActionId } from '@shared/formats'
import { DEFAULT_OPTIONS } from '@shared/defaults'
import type { ActionOptions, EditDocument, FileResult, Job, QualityReport } from '@shared/types'
import { OutputPlanner, parsePageList } from './output'
import { getSettings, getSignaturePng, saveSettings } from './settings'
import { tmpDir } from './tools'
import { convertImage, imagesToPdf, resolveOutFormat } from './engines/image'
import { convertVideo } from './engines/video'
import { officeConvert } from './engines/office'
import { preflight, postflightPdf, slideCount } from './engines/fonts'
import { applyEdits, compressPdf, encryptPdf, mergePdfs, signPdf, splitPdf } from './engines/pdf'
import { docToHwpFile, hwpSwapFile, hwpToDocxFile, hwpToPdfFile } from './engines/hwp'
import { downloadUrl, siteOf } from './engines/download'
import { rasterizePdf, pdfPageCount } from './render'

const jobs = new Map<string, Job>()
const aborts = new Map<string, AbortController>()

function broadcast(job: Job) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('job:update', job)
}
let throttle: NodeJS.Timeout | null = null
const dirty = new Set<string>()
function touch(job: Job, immediate = false) {
  dirty.add(job.id)
  if (immediate) {
    broadcast(job)
    dirty.delete(job.id)
    return
  }
  if (throttle) return
  throttle = setTimeout(() => {
    throttle = null
    for (const id of dirty) {
      const j = jobs.get(id)
      if (j) broadcast(j)
    }
    dirty.clear()
  }, 120)
}

export const listJobs = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
export function cancelJob(id: string) {
  aborts.get(id)?.abort()
}
export function clearFinished() {
  for (const [id, j] of jobs) if (j.status !== 'running' && j.status !== 'queued') jobs.delete(id)
}

function newJob(action: Job['action'], inputs: string[], options: ActionOptions, title?: string): Job {
  const job: Job = {
    id: randomUUID(),
    action,
    options,
    status: 'queued',
    createdAt: Date.now(),
    outDirs: [],
    title,
    files: inputs.map((input) => ({ input, outputs: [], status: 'queued', progress: 0 }))
  }
  jobs.set(job.id, job)
  touch(job, true)
  return job
}

const stem = (p: string) => basename(p, extname(p))

// ===================================================================================
// Per-file handlers
// ===================================================================================
type Ctx = {
  planner: OutputPlanner
  o: ActionOptions
  progress: (p: number) => void
  signal: AbortSignal
}
type Handler = (src: string, ctx: Ctx) => Promise<{ outputs: string[]; report?: QualityReport; message?: string }>

async function writeRaster(src: string, pdfBytes: Uint8Array, ctx: Ctx, fmt: 'jpg' | 'png'): Promise<string[]> {
  const count = await pdfPageCount(pdfBytes)
  const pages = parsePageList(ctx.o.pages, count)
  const imgs = await rasterizePdf(pdfBytes, pages, ctx.o.dpi ?? 200, fmt === 'jpg' ? 'jpeg' : 'png', (ctx.o.quality ?? 90) / 100)
  const outs: string[] = []
  const pad = String(count).length
  for (const im of imgs) {
    const suffix = imgs.length === 1 && count === 1 ? '' : `_${String(im.page + 1).padStart(Math.max(2, pad), '0')}`
    const dst = await ctx.planner.pathFor(src, fmt, suffix)
    await fs.writeFile(dst, im.data)
    outs.push(dst)
  }
  return outs
}

async function viaTempPdf<T>(make: (tmpPdf: string) => Promise<T>): Promise<{ bytes: Uint8Array; meta: T }> {
  const dir = await tmpDir('sc-pdf-')
  const p = join(dir, 'tmp.pdf')
  try {
    const meta = await make(p)
    return { bytes: new Uint8Array(await fs.readFile(p)), meta }
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const officeToPdf: Handler = async (src, ctx) => {
  ctx.progress(0.05)
  const pre = await preflight(src)
  ctx.progress(0.15)
  const dst = await ctx.planner.pathFor(src, 'pdf')
  const r = await officeConvert(src, dst, 'pdf', ctx.o)
  ctx.progress(0.9)
  const post = await postflightPdf(dst).catch(() => null)
  const slides = await slideCount(src)
  const notes: string[] = []
  if (pre.missing.length) notes.push(`이 PC에 없는 폰트 ${pre.missing.length}종 — 대체 폰트로 표시되었을 수 있습니다.`)
  if (post && post.nonEmbedded.length) notes.push(`PDF에 포함되지 않은 폰트: ${post.nonEmbedded.slice(0, 5).join(', ')}`)
  if (slides && post && slides !== post.pages) notes.push(`슬라이드 ${slides}장 ↔ PDF ${post.pages}쪽 (숨긴 슬라이드/설정 확인)`)
  const fidelity = pre.missing.length || (post && post.nonEmbedded.length) ? (r.fidelity === 'high' ? 'medium' : 'low') : r.fidelity
  return {
    outputs: [dst],
    report: {
      engine: r.engine,
      fidelity,
      usedFonts: pre.used,
      missingFonts: pre.missing,
      totalFonts: post?.total,
      embeddedFonts: post?.embedded,
      nonEmbedded: post?.nonEmbedded,
      pagesIn: slides,
      pagesOut: post?.pages,
      notes
    }
  }
}

const officeTo = (format: 'docx' | 'pptx' | 'xlsx' | 'csv'): Handler => async (src, ctx) => {
  const dst = await ctx.planner.pathFor(src, format)
  ctx.progress(0.1)
  const r = await officeConvert(src, dst, format, ctx.o)
  return { outputs: [dst], report: { engine: r.engine, fidelity: r.fidelity } }
}

const officeToImages = (fmt: 'jpg' | 'png'): Handler => async (src, ctx) => {
  ctx.progress(0.05)
  const { bytes, meta } = await viaTempPdf((p) => officeConvert(src, p, 'pdf', ctx.o))
  ctx.progress(0.6)
  const outs = await writeRaster(src, bytes, ctx, fmt)
  return { outputs: outs, report: { engine: meta.engine, fidelity: meta.fidelity } }
}

const HANDLERS: Partial<Record<ActionId, Handler>> = {
  // ---------- images ----------
  ...Object.fromEntries(
    (['jpg', 'png', 'webp', 'avif', 'tiff'] as const).map((f) => [
      `img.${f}`,
      (async (src, ctx) => {
        const dst = await ctx.planner.pathFor(src, f)
        const before = (await fs.stat(src)).size
        const after = await convertImage(src, dst, f, ctx.o)
        return { outputs: [dst], report: { bytesIn: before, bytesOut: after } }
      }) as Handler
    ])
  ),
  'img.resize': async (src, ctx) => {
    const f = resolveOutFormat(src, ctx.o)
    const dst = await ctx.planner.pathFor(src, f)
    const before = (await fs.stat(src)).size
    const after = await convertImage(src, dst, f, ctx.o)
    const notes = ctx.o.targetKB && after > ctx.o.targetKB * 1024 ? [`목표 ${ctx.o.targetKB}KB에 맞추지 못했습니다.`] : []
    return { outputs: [dst], report: { bytesIn: before, bytesOut: after, notes } }
  },
  'img.sign': async (src, ctx) => {
    const sig = await getSignaturePng(ctx.o.signatureId)
    const f = resolveOutFormat(src, ctx.o)
    const dst = await ctx.planner.pathFor(src, f)
    await convertImage(src, dst, f, { ...ctx.o, resize: 'none' }, { png: sig, o: ctx.o })
    return { outputs: [dst] }
  },
  'img.pdf': async (src, ctx) => {
    const dst = await ctx.planner.pathFor(src, 'pdf')
    await fs.writeFile(dst, await imagesToPdf([src], ctx.o))
    return { outputs: [dst] }
  },

  // ---------- office ----------
  'doc.pdf': officeToPdf,
  'slide.pdf': officeToPdf,
  'sheet.pdf': officeToPdf,
  'doc.docx': officeTo('docx'),
  'slide.pptx': officeTo('pptx'),
  'sheet.xlsx': officeTo('xlsx'),
  'sheet.csv': officeTo('csv'),
  'doc.jpg': officeToImages('jpg'),
  'slide.jpg': officeToImages('jpg'),
  'slide.png': officeToImages('png'),
  'doc.hwp': async (src, ctx) => {
    const target = ctx.o.hwpTarget ?? 'hwpx'
    const dst = await ctx.planner.pathFor(src, target)
    const r = await docToHwpFile(src, dst, target, ctx.o)
    return { outputs: [dst], report: { engine: r.engine, fidelity: r.fidelity, notes: r.notes } }
  },

  // ---------- hwp ----------
  'hwp.pdf': async (src, ctx) => {
    const dst = await ctx.planner.pathFor(src, 'pdf')
    const r = await hwpToPdfFile(src, dst, ctx.o)
    const post = await postflightPdf(dst).catch(() => null)
    return { outputs: [dst], report: { engine: r.engine, fidelity: r.fidelity, notes: r.notes, pagesOut: post?.pages } }
  },
  'hwp.docx': async (src, ctx) => {
    const dst = await ctx.planner.pathFor(src, 'docx')
    const r = await hwpToDocxFile(src, dst, ctx.o)
    return { outputs: [dst], report: { engine: r.engine, fidelity: r.fidelity, notes: r.notes } }
  },
  'hwp.jpg': async (src, ctx) => {
    const { bytes, meta } = await viaTempPdf((p) => hwpToPdfFile(src, p, ctx.o))
    const outs = await writeRaster(src, bytes, ctx, 'jpg')
    return { outputs: outs, report: { engine: meta.engine, fidelity: meta.fidelity, notes: meta.notes } }
  },
  'hwp.hwpx': async (src, ctx) => {
    const target = extOf(src) === 'hwp' ? 'hwpx' : 'hwp'
    const dst = await ctx.planner.pathFor(src, target)
    const r = await hwpSwapFile(src, dst, ctx.o)
    return { outputs: [dst], report: { engine: r.engine, fidelity: r.fidelity, notes: r.notes } }
  },

  // ---------- pdf ----------
  'pdf.jpg': async (src, ctx) => ({ outputs: await writeRaster(src, new Uint8Array(await fs.readFile(src)), ctx, 'jpg') }),
  'pdf.png': async (src, ctx) => ({ outputs: await writeRaster(src, new Uint8Array(await fs.readFile(src)), ctx, 'png') }),
  'pdf.compress': async (src, ctx) => {
    const r = await compressPdf(src, ctx.o)
    const dst = await ctx.planner.pathFor(src, 'pdf')
    await fs.writeFile(dst, r.bytes)
    const notes = r.after >= r.before ? ['이미 최적화된 PDF라 더 줄일 수 없었습니다 (원본 유지).'] : [`이미지 ${r.images}개 재압축`]
    return { outputs: [dst], report: { bytesIn: r.before, bytesOut: r.after, notes } }
  },
  'pdf.split': async (src, ctx) => {
    const parts = await splitPdf(src, ctx.o)
    const outs: string[] = []
    for (const p of parts) {
      const dst = await ctx.planner.pathFor(src, 'pdf', p.label)
      await fs.writeFile(dst, p.bytes)
      outs.push(dst)
    }
    return { outputs: outs }
  },
  'pdf.encrypt': async (src, ctx) => {
    const dst = await ctx.planner.pathFor(src, 'pdf')
    await fs.writeFile(dst, await encryptPdf(src, ctx.o))
    return { outputs: [dst], report: { notes: ['AES-256 암호화'] } }
  },
  'pdf.sign': async (src, ctx) => {
    const sig = await getSignaturePng(ctx.o.signatureId)
    const dst = await ctx.planner.pathFor(src, 'pdf')
    await fs.writeFile(dst, await signPdf(src, sig, ctx.o))
    return { outputs: [dst] }
  }
}

// video + audio handlers share one implementation
const VIDEO_EXT: Partial<Record<ActionId, (src: string, o: ActionOptions) => string>> = {
  'vid.mp4': () => 'mp4',
  'vid.mov': () => 'mov',
  'vid.webm': () => 'webm',
  'vid.gif': () => 'gif',
  'vid.audio': (_s, o) => o.audioFormat ?? 'mp3',
  'vid.compress': () => 'mp4',
  'vid.resize': () => 'mp4',
  'vid.trim': (s, o) => (o.trimCopy ? extOf(s) || 'mp4' : 'mp4'),
  'aud.mp3': () => 'mp3',
  'aud.m4a': () => 'm4a',
  'aud.wav': () => 'wav',
  'aud.flac': () => 'flac'
}
for (const [id, extFn] of Object.entries(VIDEO_EXT) as [ActionId, (s: string, o: ActionOptions) => string][]) {
  HANDLERS[id] = async (src, ctx) => {
    const ext = extFn(src, ctx.o)
    const suffix = id === 'vid.trim' ? '_trim' : id === 'vid.compress' ? '_slim' : id === 'vid.resize' ? `_${ctx.o.height ?? ''}p` : ''
    const dst = await ctx.planner.pathFor(src, ext, suffix)
    const before = (await fs.stat(src)).size
    const note = await convertVideo(id, src, dst, ctx.o, ctx.progress, ctx.signal)
    const after = (await fs.stat(dst)).size
    return { outputs: [dst], report: { bytesIn: before, bytesOut: after, notes: note ? [note] : [] } }
  }
}

const HEAVY = (id: ActionId) => /^(doc|slide|sheet|hwp|vid|aud)\./.test(id)

// ===================================================================================
// Public entry points
// ===================================================================================
export async function startJob(action: ActionId, inputs: string[], options?: ActionOptions): Promise<Job> {
  const def = ACTION_BY_ID[action]
  const o: ActionOptions = { ...DEFAULT_OPTIONS[action], ...(getSettings().presets[action] ?? {}), ...(options ?? {}) }
  saveSettings({ lastAction: action }).catch(() => undefined)
  const multi = def.multiToOne || (action === 'img.pdf' && o.mode === 'merge' && inputs.length > 1)
  const job = newJob(action, multi ? [inputs[0]] : inputs, o, multi ? `${inputs.length}개 → 1개` : undefined)
  void execute(job, action, inputs, o, multi)
  return job
}

async function execute(job: Job, action: ActionId, inputs: string[], o: ActionOptions, multi: boolean) {
  const ac = new AbortController()
  aborts.set(job.id, ac)
  const planner = new OutputPlanner()
  job.status = 'running'
  touch(job, true)

  const runOne = async (fr: FileResult, fn: () => Promise<{ outputs: string[]; report?: QualityReport; message?: string }>) => {
    if (ac.signal.aborted) {
      fr.status = 'cancelled'
      return
    }
    fr.status = 'running'
    touch(job)
    try {
      const r = await fn()
      fr.outputs = r.outputs
      fr.report = r.report
      fr.message = r.message
      fr.status = 'done'
      fr.progress = 1
    } catch (e) {
      fr.status = ac.signal.aborted ? 'cancelled' : 'error'
      fr.message = (e as Error).message
    }
    job.outDirs = planner.dirs
    touch(job)
  }

  if (multi) {
    const fr = job.files[0]
    await runOne(fr, async () => {
      if (action === 'pdf.merge') {
        const dst = await planner.pathNamed(inputs[0], o.name || 'merged', 'pdf')
        await fs.writeFile(dst, await mergePdfs(inputs))
        return { outputs: [dst], message: `${inputs.length}개 PDF 병합` }
      }
      const dst = await planner.pathNamed(inputs[0], o.name || stem(inputs[0]) + '_외' + (inputs.length - 1), 'pdf')
      await fs.writeFile(dst, await imagesToPdf(inputs, o))
      return { outputs: [dst], message: `${inputs.length}장 → PDF` }
    })
  } else {
    const handler = HANDLERS[action]
    if (!handler) {
      for (const fr of job.files) {
        fr.status = 'error'
        fr.message = '지원하지 않는 변환입니다.'
      }
    } else {
      const limit = HEAVY(action) ? 1 : Math.max(1, getSettings().concurrency)
      let next = 0
      const worker = async () => {
        while (next < job.files.length) {
          const fr = job.files[next++]
          await runOne(fr, () =>
            handler(fr.input, {
              planner,
              o,
              signal: ac.signal,
              progress: (p) => {
                fr.progress = p
                touch(job)
              }
            })
          )
        }
      }
      await Promise.all(Array.from({ length: limit }, worker))
    }
  }
  finish(job, ac, planner)
}

function finish(job: Job, ac: AbortController, planner: OutputPlanner) {
  job.outDirs = planner.dirs
  job.status = ac.signal.aborted ? 'cancelled' : job.files.every((f) => f.status === 'done') ? 'done' : job.files.some((f) => f.status === 'done') ? 'done' : 'error'
  aborts.delete(job.id)
  touch(job, true)
}

/** PDF editor save. */
export async function startEditJob(model: EditDocument): Promise<Job> {
  const job = newJob('pdf.edit', [model.sources[0]], {}, model.outputName)
  const ac = new AbortController()
  const planner = new OutputPlanner()
  job.status = 'running'
  touch(job, true)
  const fr = job.files[0]
  try {
    const bytes = await applyEdits(model)
    const dst = await planner.pathNamed(model.sources[0], model.outputName || stem(model.sources[0]), 'pdf')
    await fs.writeFile(dst, bytes)
    fr.outputs = [dst]
    fr.status = 'done'
    fr.progress = 1
    fr.message = `${model.pages.length}쪽 · 주석 ${model.annotations.length}개`
  } catch (e) {
    fr.status = 'error'
    fr.message = (e as Error).message
  }
  finish(job, ac, planner)
  return job
}

/** Video downloads: one paste = one job = one V folder under the download dir. */
export async function startDownloadJob(urls: string[]): Promise<Job> {
  const job = newJob('download', urls, {}, `${urls.length}개 링크`)
  const ac = new AbortController()
  aborts.set(job.id, ac)
  const base = getSettings().downloadDir
  const planner = new OutputPlanner(base)
  job.status = 'running'
  touch(job, true)
  void (async () => {
    // dirFor() needs a "source" path; any path inside base works since base is overridden
    const dir = await planner.dirFor(join(base, 'x'))
    for (const fr of job.files) {
      if (ac.signal.aborted) {
        fr.status = 'cancelled'
        continue
      }
      fr.status = 'running'
      fr.message = siteOf(fr.input)
      touch(job)
      try {
        fr.outputs = await downloadUrl(
          fr.input,
          dir,
          (p, note) => {
            fr.progress = p
            if (note) fr.message = note
            touch(job)
          },
          ac.signal
        )
        fr.status = 'done'
        fr.progress = 1
        fr.message = siteOf(fr.input)
      } catch (e) {
        fr.status = ac.signal.aborted ? 'cancelled' : 'error'
        fr.message = (e as Error).message
      }
      job.outDirs = [dir]
      touch(job)
    }
    finish(job, ac, planner)
  })()
  return job
}


