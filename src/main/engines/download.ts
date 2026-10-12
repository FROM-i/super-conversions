import { promises as fs } from 'fs'
import { join } from 'path'
import { ensureYtdlp, ffmpegPath, run } from '../tools'
import { getSettings } from '../settings'
import type { UrlInfo } from '@shared/types'

export const siteOf = (url: string): string => {
  const h = (() => {
    try {
      return new URL(url).hostname.replace(/^www\.|^m\./, '')
    } catch {
      return ''
    }
  })()
  if (/youtu\.?be/.test(h)) return 'YouTube'
  if (/pinterest|pin\.it/.test(h)) return 'Pinterest'
  if (/instagram/.test(h)) return 'Instagram'
  if (/threads\.(net|com)/.test(h)) return 'Threads'
  if (/tiktok/.test(h)) return 'TikTok'
  if (/vimeo/.test(h)) return 'Vimeo'
  if (/x\.com|twitter/.test(h)) return 'X'
  return h || 'Web'
}

export const extractUrls = (text: string): string[] => [...new Set((text.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map((u) => u.replace(/[),.]+$/, '')))]

const cookieArgs = (): string[] => {
  const b = getSettings().cookiesBrowser
  return b && b !== 'none' ? ['--cookies-from-browser', b] : []
}

export async function probeUrl(url: string): Promise<UrlInfo> {
  const site = siteOf(url)
  try {
    const bin = await ensureYtdlp()
    const r = await run(bin, ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(), url], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new Error(r.stderr.split('\n').filter(Boolean).pop() ?? 'probe failed')
    const j = JSON.parse(r.stdout) as { title?: string; thumbnail?: string; duration?: number }
    return { url, site, title: j.title, thumbnail: j.thumbnail, duration: j.duration }
  } catch (e) {
    if (site === 'Threads') return { url, site, title: 'Threads 게시물' }
    return { url, site, error: friendly(String((e as Error).message)) }
  }
}

const friendly = (msg: string): string => {
  if (/login|cookies|rate-limit|private/i.test(msg)) return '로그인이 필요한 콘텐츠입니다. 설정 › 다운로드에서 쿠키를 가져올 브라우저를 지정해 주세요.'
  if (/Unsupported URL/i.test(msg)) return '지원하지 않는 링크입니다.'
  if (/Sign in to confirm/i.test(msg)) return 'YouTube가 로그인 확인을 요구합니다. 설정에서 브라우저 쿠키를 지정해 주세요.'
  return msg.replace(/^ERROR:\s*/, '').slice(0, 240)
}

/** Download one URL into `dir`. Returns the produced file paths. */
export async function downloadUrl(url: string, dir: string, onProgress: (p: number, note?: string) => void, signal?: AbortSignal): Promise<string[]> {
  const bin = await ensureYtdlp((s) => onProgress(0, s))
  const fmt = getSettings().downloadFormat
  const ff = ffmpegPath()
  const before = new Set(await fs.readdir(dir))
  const args = ['--no-playlist', '--newline', '--no-mtime', '--restrict-filenames', '-o', join(dir, '%(title).80B [%(id)s].%(ext)s'), ...cookieArgs()]
  if (ff) args.push('--ffmpeg-location', ff)
  if (fmt === 'audio') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0')
  else {
    const cap = fmt === '1080' ? '[height<=1080]' : fmt === '720' ? '[height<=720]' : ''
    args.push('-f', `bv*${cap}[vcodec^=avc1]+ba[ext=m4a]/bv*${cap}+ba/b${cap}/b`, '--merge-output-format', 'mp4', '--remux-video', 'mp4')
  }
  args.push(url)
  let lastErr = ''
  const r = await run(bin, args, {
    signal,
    onStdout: (s) => {
      for (const line of s.split('\n')) {
        const m = /\[download\]\s+([\d.]+)%/.exec(line)
        if (m) onProgress(Math.min(0.99, parseFloat(m[1]) / 100))
        if (/\[Merger\]|\[VideoRemuxer\]|\[ExtractAudio\]/.test(line)) onProgress(0.99, '합치는 중…')
      }
    },
    onStderr: (s) => (lastErr = s)
  })
  const produced = (await fs.readdir(dir)).filter((f) => !before.has(f) && !/\.(part|ytdl|temp)$/.test(f) && !/\.f\d+\./.test(f))
  if (r.code === 0 && produced.length) return produced.map((f) => join(dir, f))
  if (siteOf(url) === 'Threads') return threadsFallback(url, dir, onProgress)
  throw new Error(friendly(lastErr || r.stderr || 'download failed'))
}

/** Threads: yt-dlp support is spotty — read the public page and pull the video URL directly. */
async function threadsFallback(url: string, dir: string, onProgress: (p: number, note?: string) => void): Promise<string[]> {
  onProgress(0.05, 'Threads 페이지 분석 중…')
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'ko,en;q=0.8' } })
  const html = await res.text()
  const cands: string[] = []
  for (const m of html.matchAll(/"video_versions":\[\{[^\]]*?"url":"([^"]+)"/g)) cands.push(m[1])
  for (const m of html.matchAll(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/g)) cands.push(m[1])
  const vid = cands.map((u) => u.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&'))[0]
  if (!vid) throw new Error('Threads 영상 주소를 찾지 못했습니다. 비공개 게시물이거나 이미지 게시물일 수 있습니다.')
  const id = /\/post\/([^/?#]+)/.exec(url)?.[1] ?? String(Date.now())
  const dst = join(dir, `threads_${id}.mp4`)
  const v = await fetch(vid)
  if (!v.ok || !v.body) throw new Error(`Threads 영상 다운로드 실패 (${v.status})`)
  const total = Number(v.headers.get('content-length') ?? 0)
  const chunks: Buffer[] = []
  let got = 0
  const reader = v.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    got += value.length
    if (total) onProgress(Math.min(0.99, got / total))
  }
  await fs.writeFile(dst, Buffer.concat(chunks))
  return [dst]
}
