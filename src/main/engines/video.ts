import { ffmpegPath, probeHwEncoders, run, isMac } from '../tools'
import type { ActionOptions } from '@shared/types'
import type { ActionId } from '@shared/formats'

export interface ProbeInfo {
  duration: number
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
}

export async function probe(src: string): Promise<ProbeInfo> {
  const ff = ffmpegPath()
  if (!ff) throw new Error('ffmpeg를 찾을 수 없습니다.')
  const r = await run(ff, ['-hide_banner', '-i', src])
  const e = r.stderr
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(e)
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0
  const v = /Stream #[^\n]*Video:\s*([a-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(e)
  const a = /Stream #[^\n]*Audio:\s*([a-z0-9_]+)/.exec(e)
  return { duration, vcodec: v?.[1], width: v ? +v[2] : undefined, height: v ? +v[3] : undefined, acodec: a?.[1] }
}

const toSec = (t?: string): number | undefined => {
  if (!t || !t.trim()) return undefined
  const parts = t.trim().split(':').map(Number)
  if (parts.some(isNaN)) return undefined
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

const CRF = { high: 19, medium: 23, low: 28 } as const
const VT_Q = { high: 70, medium: 58, low: 45 } as const

async function videoEncoderArgs(o: ActionOptions, info: ProbeInfo, budgetKbps?: number): Promise<string[]> {
  const hevc = o.codec === 'h265'
  const q = o.vquality ?? 'high'
  if (o.hwaccel) {
    const hw = await probeHwEncoders()
    const pick = (hevc ? ['hevc_videotoolbox', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf'] : ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf']).find((e) => hw.includes(e))
    if (pick) {
      const tag = hevc ? ['-tag:v', 'hvc1'] : []
      if (budgetKbps) return ['-c:v', pick, '-b:v', `${budgetKbps}k`, '-maxrate', `${Math.round(budgetKbps * 1.3)}k`, '-bufsize', `${budgetKbps * 2}k`, ...tag]
      if (pick.includes('videotoolbox')) return ['-c:v', pick, '-q:v', String(VT_Q[q]), ...tag]
      if (pick.includes('nvenc')) return ['-c:v', pick, '-preset', 'p5', '-rc', 'vbr', '-cq', String(CRF[q] + 2), '-b:v', '0', ...tag]
      if (pick.includes('qsv')) return ['-c:v', pick, '-global_quality', String(CRF[q] + 2), ...tag]
      if (pick.includes('amf')) return ['-c:v', pick, '-rc', 'cqp', '-qp_i', String(CRF[q]), '-qp_p', String(CRF[q] + 2), ...tag]
    }
  }
  void info
  const enc = hevc ? ['-c:v', 'libx265', '-tag:v', 'hvc1'] : ['-c:v', 'libx264']
  if (budgetKbps) return [...enc, '-preset', 'medium', '-b:v', `${budgetKbps}k`, '-maxrate', `${Math.round(budgetKbps * 1.3)}k`, '-bufsize', `${budgetKbps * 2}k`]
  return [...enc, '-preset', isMac ? 'medium' : 'medium', '-crf', String(hevc ? CRF[q] + 4 : CRF[q])]
}

/** Build + run an ffmpeg command for the given action. */
export async function convertVideo(action: ActionId, src: string, dst: string, o: ActionOptions, onProgress: (p: number) => void, signal?: AbortSignal): Promise<string> {
  const ff = ffmpegPath()
  if (!ff) throw new Error('ffmpeg를 찾을 수 없습니다.')
  const info = await probe(src)
  const start = toSec(o.start)
  const end = toSec(o.end)
  const pre: string[] = ['-hide_banner', '-y']
  const args: string[] = []
  let note = ''

  if ((action === 'vid.trim' || action === 'vid.gif') && start) pre.push('-ss', String(start))
  pre.push('-i', src)
  if ((action === 'vid.trim' || action === 'vid.gif') && end) args.push('-t', String(Math.max(0.1, end - (start ?? 0))))
  const span = (end ?? info.duration) - (start ?? 0)
  const total = action === 'vid.trim' || action === 'vid.gif' ? Math.max(0.1, span) : info.duration

  const mp4ish = action === 'vid.mp4' || action === 'vid.mov' || action === 'vid.compress' || action === 'vid.resize' || action === 'vid.trim'
  if (mp4ish) {
    const canCopyV = info.vcodec === 'h264' || info.vcodec === 'hevc'
    const canCopyA = !info.acodec || ['aac', 'mp3', 'alac', 'ac3'].includes(info.acodec)
    const wantCopy =
      ((action === 'vid.mp4' || action === 'vid.mov') && o.remux && canCopyV && canCopyA) || (action === 'vid.trim' && o.trimCopy)
    if (wantCopy) {
      args.push('-map', '0:v:0?', '-map', '0:a?', '-c', 'copy')
      if (info.vcodec === 'hevc') args.push('-tag:v', 'hvc1')
      note = '무손실 컨테이너 변환 (재인코딩 없음)'
    } else {
      let budget: number | undefined
      if (action === 'vid.compress' && o.targetMB && o.targetMB > 0 && info.duration > 0) {
        budget = Math.max(150, Math.floor((o.targetMB * 8 * 1024) / info.duration - 128) * 0.97)
      }
      const vf: string[] = []
      if ((action === 'vid.resize' || action === 'vid.compress') && o.height && info.height && o.height < info.height) vf.push(`scale=-2:${o.height}`)
      if (vf.length) args.push('-vf', vf.join(','))
      args.push(...(await videoEncoderArgs(o, info, budget ? Math.round(budget) : undefined)), '-pix_fmt', 'yuv420p')
      args.push('-c:a', 'aac', '-b:a', budget ? '128k' : '192k')
      note = budget ? `목표 ${o.targetMB}MB · ${Math.round(budget)}kbps` : '재인코딩'
    }
    if (dst.endsWith('.mp4') || dst.endsWith('.mov')) args.push('-movflags', '+faststart')
  } else if (action === 'vid.webm') {
    const crf = { high: 28, medium: 33, low: 38 }[o.vquality ?? 'high']
    args.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k')
  } else if (action === 'vid.gif') {
    const fps = o.fps ?? 15
    const w = o.gifWidth ?? 720
    args.push('-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0')
  } else if (action === 'vid.audio' || action.startsWith('aud.')) {
    args.push('-vn')
    const fmt = action === 'vid.audio' ? o.audioFormat ?? 'mp3' : action.slice(4)
    const br = `${o.audioBitrate ?? 192}k`
    if (fmt === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', br)
    else if (fmt === 'm4a') args.push('-c:a', 'aac', '-b:a', br)
    else if (fmt === 'wav') args.push('-c:a', 'pcm_s16le')
    else if (fmt === 'flac') args.push('-c:a', 'flac')
  }

  args.push('-progress', 'pipe:1', '-nostats', dst)
  const r = await run(ff, [...pre, ...args], {
    signal,
    onStdout: (s) => {
      const m = /out_time_(?:us|ms)=(\d+)/.exec(s)
      if (m && total > 0) onProgress(Math.min(0.99, +m[1] / 1e6 / total))
    }
  })
  if (r.code !== 0) {
    const tail = r.stderr.split('\n').filter(Boolean).slice(-4).join(' / ')
    throw new Error(`ffmpeg 실패: ${tail}`)
  }
  return note
}
