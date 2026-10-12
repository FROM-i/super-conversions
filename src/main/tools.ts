import { app } from 'electron'
import { spawn, SpawnOptions } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import os from 'os'
import { getSettings } from './settings'

export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'

/** Paths inside app.asar must be read from app.asar.unpacked for executables. */
export const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

export function resourcePath(...parts: string[]): string {
  // packaged: <resources>/resources/...; dev: <repo>/resources/...
  const base = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  return join(base, ...parts)
}
export function scriptPath(name: string): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'scripts') : join(app.getAppPath(), 'src', 'main', 'scripts')
  return join(base, name)
}

export function ffmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = unpacked(require('ffmpeg-static') as string)
    if (p && existsSync(p)) return p
  } catch {
    /* ignore */
  }
  return null
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & {
    onStdout?: (s: string) => void
    onStderr?: (s: string) => void
    timeoutMs?: number
    signal?: AbortSignal
  } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'))
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stdout += s
      opts.onStdout?.(s)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stderr += s
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
      opts.onStderr?.(s)
    })
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ---------- LibreOffice ----------
export function findSoffice(): string | null {
  const custom = getSettings().sofficePath
  if (custom && existsSync(custom)) return custom
  const cands: string[] = []
  if (isWin) {
    for (const pf of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (pf) cands.push(join(pf, 'LibreOffice', 'program', 'soffice.exe'))
    }
  } else if (isMac) {
    cands.push('/Applications/LibreOffice.app/Contents/MacOS/soffice', join(os.homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'))
  } else {
    cands.push('/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/snap/bin/libreoffice')
  }
  return cands.find((c) => existsSync(c)) ?? null
}

// ---------- Hardware encoders (probed once) ----------
let hwCache: string[] | null = null
export async function probeHwEncoders(): Promise<string[]> {
  if (hwCache) return hwCache
  const ff = ffmpegPath()
  if (!ff) return (hwCache = [])
  const cands = isMac ? ['h264_videotoolbox', 'hevc_videotoolbox'] : isWin ? ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'] : ['h264_nvenc', 'h264_vaapi']
  const ok: string[] = []
  for (const enc of cands) {
    try {
      const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-c:v', enc, '-f', 'null', '-'], { timeoutMs: 8000 })
      if (r.code === 0) ok.push(enc)
    } catch {
      /* not available */
    }
  }
  hwCache = ok
  return ok
}

// ---------- yt-dlp (downloaded on first use, self-updating) ----------
export const ytdlpBin = () => join(app.getPath('userData'), 'bin', isWin ? 'yt-dlp.exe' : 'yt-dlp')

export async function ensureYtdlp(onStatus?: (s: string) => void): Promise<string> {
  const bin = ytdlpBin()
  if (existsSync(bin)) return bin
  const asset = isWin ? 'yt-dlp.exe' : isMac ? 'yt-dlp_macos' : 'yt-dlp'
  onStatus?.('다운로드 엔진(yt-dlp) 설치 중…')
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`yt-dlp 다운로드 실패 (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.mkdir(join(app.getPath('userData'), 'bin'), { recursive: true })
  await fs.writeFile(bin, buf, { mode: 0o755 })
  return bin
}

export async function updateYtdlp(): Promise<void> {
  const bin = ytdlpBin()
  if (!existsSync(bin)) return
  const stamp = join(app.getPath('userData'), 'bin', '.last-update')
  try {
    const st = await fs.stat(stamp)
    if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) return
  } catch {
    /* first time */
  }
  await run(bin, ['-U'], { timeoutMs: 120_000 }).catch(() => undefined)
  await fs.writeFile(stamp, String(Date.now()))
}

export async function tmpDir(prefix = 'sc-'): Promise<string> {
  return fs.mkdtemp(join(os.tmpdir(), prefix))
}
