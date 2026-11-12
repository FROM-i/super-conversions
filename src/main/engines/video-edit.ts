// Simple editor backend: cut / join / speed → one MP4, plus preview helpers (proxy, filmstrip).
import { app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { ffmpegPath, run } from '../tools'
import { videoEncoderArgs } from './video'
import type { EditSegment, ExportLevel, VideoClipInfo } from '@shared/types'

const ff = () => {
  const p = ffmpegPath()
  if (!p) throw new Error('ffmpeg를 찾을 수 없습니다.')
  return p
}

export async function clipInfo(path: string): Promise<VideoClipInfo> {
  const r = await run(ff(), ['-hide_banner', '-i', path])
  const e = r.stderr
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(e)
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0
  const v = /Stream #[^\n]*Video:\s*([a-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(e)
  const fpsM = /Stream #[^\n]*Video:[^\n]*?([\d.]+) fps/.exec(e)
  const rot = /rotation of (-?[\d.]+) degrees|rotate\s*:\s*(-?\d+)/.exec(e)
  let w = v ? +v[2] : 0
  let h = v ? +v[3] : 0
  const angle = rot ? Math.abs(parseFloat(rot[1] ?? rot[2])) % 180 : 0
  if (angle === 90) [w, h] = [h, w] // phone videos: display orientation
  if (!v) throw new Error('영상 트랙이 없는 파일입니다.')
  return { path, duration, width: w, height: h, fps: fpsM ? parseFloat(fpsM[1]) : 30, hasAudio: /Stream #[^\n]*Audio:/.test(e), vcodec: v[1] }
}

const cacheDir = async (sub: string) => {
  const d = join(app.getPath('userData'), sub)
  await fs.mkdir(d, { recursive: true })
  return d
}
const keyOf = async (path: string, extra = '') => {
  const st = await fs.stat(path)
  return createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 20)
}

/** Filmstrip sprite: N frames tiled horizontally (cached). */
export async function filmstrip(path: string, duration: number, frames = 24): Promise<{ url: string; frames: number } | null> {
  try {
    const out = join(await cacheDir('filmstrips'), (await keyOf(path, `fs${frames}`)) + '.jpg')
    if (!existsSync(out)) {
      const rate = Math.max(0.01, frames / Math.max(0.1, duration))
      await run(ff(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', `fps=${rate.toFixed(4)},scale=-2:72,tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', out], { timeoutMs: 120_000 })
    }
    if (!existsSync(out)) return null
    return { url: `data:image/jpeg;base64,${(await fs.readFile(out)).toString('base64')}`, frames }
  } catch {
    return null
  }
}

/** H.264 preview copy for files Chromium can't play (AVI, WMV, some MKV/HEVC). Same timing as the source. */
export async function previewProxy(path: string, onProgress?: (p: number) => void): Promise<string> {
  const out = join(await cacheDir('proxies'), (await keyOf(path, 'proxy')) + '.mp4')
  if (existsSync(out)) return out
  const info = await clipInfo(path)
  const tmp = out + '.part.mp4'
  const r = await run(
    ff(),
    ['-hide_banner', '-y', '-i', path, '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp],
    {
      onStdout: (s) => {
        const m = /out_time_(?:us|ms)=(\d+)/.exec(s)
        if (m && info.duration) onProgress?.(Math.min(0.99, +m[1] / 1e6 / info.duration))
      }
    }
  )
  if (r.code !== 0) throw new Error('미리보기용 변환 실패')
  await fs.rename(tmp, out)
  return out
}

// ------------------------------------------------------------ export
export const LEVELS: Record<ExportLevel, { label: string; vq: 'high' | 'medium' | 'low'; crf: number; maxH: number; abr: number }> = {
  high: { label: '고화질', vq: 'high', crf: 18, maxH: 0, abr: 192 },
  balanced: { label: '균형', vq: 'medium', crf: 22, maxH: 0, abr: 160 },
  light: { label: 'SNS·메신저', vq: 'low', crf: 26, maxH: 1080, abr: 128 },
  tiny: { label: '아주 작게', vq: 'low', crf: 30, maxH: 720, abr: 96 }
}

/** atempo accepts 0.5–2 per instance → chain for 0.25 / 4 etc. */
export function atempoChain(speed: number): string {
  const parts: string[] = []
  let s = speed
  while (s > 2) {
    parts.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-3) parts.push(`atempo=${+s.toFixed(4)}`)
  return parts.join(',') || 'anull'
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export async function renderEdit(segments: EditSegment[], level: ExportLevel, height: number, dst: string, onProgress: (p: number) => void, signal?: AbortSignal): Promise<{ duration: number; width: number; height: number }> {
  if (!segments.length) throw new Error('타임라인이 비어 있습니다.')
  const infos = new Map<string, VideoClipInfo>()
  for (const s of segments) if (!infos.has(s.path)) infos.set(s.path, await clipInfo(s.path))
  const first = infos.get(segments[0].path)!
  const L = LEVELS[level]
  // output frame: first clip's orientation, capped by the chosen height / level
  let H = first.height
  const capH = Math.min(...[height, L.maxH].filter((x) => x > 0), Infinity)
  const short = Math.min(first.width, first.height)
  if (capH !== Infinity && short > capH) H = Math.round((first.height * capH) / short)
  const W = even((first.width * H) / first.height)
  H = even(H)
  const fps = Math.min(60, Math.max(24, Math.round(first.fps || 30)))

  const args: string[] = ['-hide_banner', '-y']
  const filters: string[] = []
  let total = 0
  segments.forEach((s, i) => {
    const len = Math.max(0.05, s.end - s.start)
    args.push('-ss', s.start.toFixed(3), '-t', len.toFixed(3), '-i', s.path)
    const out = len / s.speed
    total += out
    filters.push(
      `[${i}:v]setpts=(PTS-STARTPTS)/${s.speed},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    )
    const info = infos.get(s.path)!
    if (info.hasAudio && !s.muted) filters.push(`[${i}:a]asetpts=PTS-STARTPTS,${atempoChain(s.speed)},aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${out.toFixed(3)}[a${i}]`)
    else filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${out.toFixed(3)}[a${i}]`)
  })
  filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[vout][aout]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]')

  const enc = await videoEncoderArgs({ vquality: L.vq, codec: 'h264', hwaccel: true }, { duration: total })
  // software path: use our level CRF instead of the generic mapping
  const sw = enc.includes('libx264')
  args.push(...(sw ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(L.crf)] : enc), '-pix_fmt', 'yuv420p', '-r', String(fps))
  args.push('-c:a', 'aac', '-b:a', `${L.abr}k`, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', dst)

  const r = await run(ff(), args, {
    signal,
    onStdout: (s) => {
      const m = /out_time_(?:us|ms)=(\d+)/.exec(s)
      if (m && total > 0) onProgress(Math.min(0.99, +m[1] / 1e6 / total))
    }
  })
  if (r.code !== 0) throw new Error(`영상 내보내기 실패: ${r.stderr.split('\n').filter(Boolean).slice(-3).join(' / ')}`)
  return { duration: total, width: W, height: H }
}
