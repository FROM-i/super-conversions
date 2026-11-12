// sc-media://<encoded path> — streams local video to the preview <video> with HTTP Range support,
// so seeking works in large files without loading them into memory.
import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'stream'
import { extname } from 'path'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav'
}

export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'sc-media', privileges: { standard: false, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } }])
}

export const mediaUrl = (path: string) => `sc-media://f/${encodeURIComponent(path)}`

export function handleMediaScheme() {
  protocol.handle('sc-media', async (req) => {
    try {
      const path = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
      const st = await fs.stat(path)
      const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
      const range = req.headers.get('range')
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1
        if (!m?.[1] && m?.[2]) {
          start = Math.max(0, st.size - parseInt(m[2], 10))
          end = st.size - 1
        }
        end = Math.min(end, st.size - 1)
        const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
        return new Response(body, {
          status: 206,
          headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' }
        })
      }
      const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
      return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
