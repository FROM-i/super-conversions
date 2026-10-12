// Screenshot library: watches the OS screenshot locations (and optionally the clipboard)
// and collects every new capture into one folder that the app browses.
import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron'
import { promises as fs, existsSync, watch, FSWatcher } from 'fs'
import { join, basename, extname } from 'path'
import os from 'os'
import { createHash } from 'crypto'
import sharp from 'sharp'
import { getSettings } from './settings'
import { isMac, isWin, run } from './tools'
import type { LibraryItem } from '@shared/types'

const IMG = /\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp|avif)$/i
// names macOS / Windows / common tools give screenshots
const SHOT_NAME = /^(스크린샷|화면 캡처|Screenshot|Screen ?Shot|Capture|캡처|CleanShot|Snipaste|Greenshot|Lightshot)/i

export function defaultLibraryDir(): string {
  return join(app.getPath('pictures'), 'SUPER CONVERSIONS Library')
}
export function libraryDir(): string {
  return getSettings().libraryDir || defaultLibraryDir()
}

/** OS screenshot folders. `nameFilter` = only pick files that look like screenshots (shared folders such as Desktop). */
export async function detectShotFolders(): Promise<{ path: string; nameFilter: boolean; label: string }[]> {
  const out: { path: string; nameFilter: boolean; label: string }[] = []
  if (isMac) {
    let loc = ''
    try {
      loc = (await run('defaults', ['read', 'com.apple.screencapture', 'location'], { timeoutMs: 3000 })).stdout.trim().replace(/^~/, os.homedir())
    } catch {
      /* not set → Desktop */
    }
    const desktop = app.getPath('desktop')
    if (loc && existsSync(loc) && loc !== desktop) out.push({ path: loc, nameFilter: false, label: '스크린샷 저장 위치' })
    out.push({ path: desktop, nameFilter: true, label: '데스크탑' })
  } else if (isWin) {
    const cands = [join(app.getPath('pictures'), 'Screenshots'), join(os.homedir(), 'OneDrive', 'Pictures', 'Screenshots'), join(os.homedir(), 'OneDrive', '사진', 'Screenshots'), join(os.homedir(), 'Pictures', 'Screenshots')]
    const seen = new Set<string>()
    for (const c of cands) if (existsSync(c) && !seen.has(c.toLowerCase())) (seen.add(c.toLowerCase()), out.push({ path: c, nameFilter: false, label: '사진 › Screenshots' }))
    out.push({ path: app.getPath('desktop'), nameFilter: true, label: '바탕화면' })
  } else {
    const p = join(app.getPath('pictures'), 'Screenshots')
    if (existsSync(p)) out.push({ path: p, nameFilter: false, label: 'Pictures/Screenshots' })
    out.push({ path: app.getPath('pictures'), nameFilter: true, label: 'Pictures' })
  }
  for (const extra of getSettings().libraryExtraFolders ?? []) if (existsSync(extra)) out.push({ path: extra, nameFilter: false, label: basename(extra) })
  return out
}

// ------------------------------------------------------------ collecting
const watchers: FSWatcher[] = []
const inFlight = new Set<string>()
let clipTimer: NodeJS.Timeout | null = null
let lastClipHash = ''

function notify() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('library:changed')
}

async function waitStable(p: string): Promise<boolean> {
  let last = -1
  for (let i = 0; i < 20; i++) {
    try {
      const s = await fs.stat(p)
      if (s.size > 0 && s.size === last) return true
      last = s.size
    } catch {
      return false
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return true
}

async function uniqueIn(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = basename(name, ext)
  let p = join(dir, name)
  for (let n = 2; existsSync(p); n++) p = join(dir, `${stem} (${n})${ext}`)
  return p
}

async function collect(src: string) {
  if (inFlight.has(src)) return
  inFlight.add(src)
  try {
    if (!(await waitStable(src))) return
    const dir = libraryDir()
    await fs.mkdir(dir, { recursive: true })
    const dst = await uniqueIn(dir, basename(src))
    const st = await fs.stat(src)
    if (getSettings().libraryCollectMode === 'copy') await fs.copyFile(src, dst)
    else {
      try {
        await fs.rename(src, dst)
      } catch {
        await fs.copyFile(src, dst) // across volumes (e.g. OneDrive)
        await fs.unlink(src).catch(() => undefined)
      }
    }
    await fs.utimes(dst, st.atime, st.mtime).catch(() => undefined) // keep capture time
    notify()
  } catch {
    /* ignore single failures */
  } finally {
    setTimeout(() => inFlight.delete(src), 2000)
  }
}

export async function startLibrary() {
  stopLibrary()
  const s = getSettings()
  if (!s.libraryEnabled) return
  await fs.mkdir(libraryDir(), { recursive: true }).catch(() => undefined)
  const startedAt = Date.now()
  for (const f of await detectShotFolders()) {
    if (f.path === libraryDir()) continue
    try {
      const w = watch(f.path, { persistent: false }, (_ev, name) => {
        if (!name) return
        const file = String(name)
        if (file.startsWith('.') || !IMG.test(file)) return
        if (f.nameFilter && !SHOT_NAME.test(file)) return
        const full = join(f.path, file)
        setTimeout(async () => {
          try {
            const st = await fs.stat(full)
            if (st.birthtimeMs >= startedAt - 5000 || st.mtimeMs >= startedAt - 5000) collect(full)
          } catch {
            /* removed */
          }
        }, 250)
      })
      watchers.push(w)
    } catch {
      /* folder not watchable */
    }
  }
  if (s.libraryClipboard) {
    lastClipHash = 'init'
    pollClipboard()
    clipTimer = setInterval(pollClipboard, 1500)
  }
}

export function stopLibrary() {
  for (const w of watchers.splice(0)) w.close()
  if (clipTimer) clearInterval(clipTimer)
  clipTimer = null
}

/** Electron 44 clipboard is async/W3C-style: read the PNG payload if there is one. */
async function readClipboardPng(): Promise<Buffer | null> {
  try {
    if (!(await clipboard.has('image/png'))) return null
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue
      const blob = (await item.getType('image/png')) as Blob
      return Buffer.from(await blob.arrayBuffer())
    }
  } catch {
    /* clipboard busy */
  }
  return null
}

let suppressUntil = 0
export function suppressClipboardOnce() {
  suppressUntil = Date.now() + 4000
}

let polling = false
async function pollClipboard() {
  if (polling) return
  polling = true
  try {
    const png = await readClipboardPng()
    if (!png) return
    const h = createHash('sha1').update(png).digest('hex')
    if (h === lastClipHash) return
    const first = lastClipHash === 'init'
    lastClipHash = h
    if (first || Date.now() < suppressUntil) return // ignore what was already there / our own copies
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const name = `스크린샷 ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.png`
    const dir = libraryDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(await uniqueIn(dir, name), png)
    notify()
  } finally {
    polling = false
  }
}

export async function writeClipboardImage(path: string) {
  suppressClipboardOnce()
  const png = await sharp(path).png().toBuffer()
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

// ------------------------------------------------------------ browsing
export async function listLibrary(): Promise<{ dir: string; items: LibraryItem[] }> {
  const dir = libraryDir()
  await fs.mkdir(dir, { recursive: true })
  const items: LibraryItem[] = []
  for (const f of await fs.readdir(dir)) {
    if (f.startsWith('.') || !IMG.test(f)) continue
    try {
      const st = await fs.stat(join(dir, f))
      if (st.isFile()) items.push({ path: join(dir, f), name: f, size: st.size, mtime: st.mtimeMs, ctime: Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs) })
    } catch {
      /* raced */
    }
  }
  items.sort((a, b) => b.ctime - a.ctime)
  return { dir, items }
}

export async function importToLibrary(paths: string[], move = false): Promise<number> {
  const dir = libraryDir()
  await fs.mkdir(dir, { recursive: true })
  let n = 0
  for (const p of paths) {
    if (!IMG.test(p)) continue
    const dst = await uniqueIn(dir, basename(p))
    if (move) await fs.rename(p, dst).catch(async () => (await fs.copyFile(p, dst), await fs.unlink(p)))
    else await fs.copyFile(p, dst)
    n++
  }
  notify()
  return n
}

// cached thumbnails (path + mtime → webp in userData/thumbs)
export async function cachedThumb(path: string, size = 360): Promise<string | null> {
  try {
    const st = await fs.stat(path)
    const key = createHash('sha1').update(`${path}|${st.mtimeMs}|${size}`).digest('hex')
    const dir = join(app.getPath('userData'), 'thumbs')
    const file = join(dir, key + '.webp')
    let buf: Buffer
    if (existsSync(file)) buf = await fs.readFile(file)
    else {
      buf = await sharp(path, { pages: 1 }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer()
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(file, buf)
    }
    return `data:image/webp;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export async function imageSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(path).metadata()
    return { width: m.width ?? 0, height: m.height ?? 0 }
  } catch {
    return null
  }
}
