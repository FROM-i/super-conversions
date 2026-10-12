// Offscreen Chromium helpers: PDF rasterisation (pdf.js), HWP layout (hwp.js) and HTML → PDF printing.
import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { tmpDir } from './tools'

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
ipcMain.on('render:reply', (_e, id: string, ok: boolean, payload: unknown) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  ok ? p.resolve(payload) : p.reject(new Error(String(payload)))
})

function loadRenderer(win: BrowserWindow, hash: string) {
  if (process.env['ELECTRON_RENDERER_URL']) return win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  return win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

function makeWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, offscreen: false, backgroundThrottling: false }
  })
}

let worker: BrowserWindow | null = null
let workerReady: Promise<void> | null = null
async function getWorker(): Promise<BrowserWindow> {
  if (worker && !worker.isDestroyed()) {
    await workerReady
    return worker
  }
  worker = makeWindow()
  workerReady = new Promise<void>((res) => {
    const onReady = (e: Electron.IpcMainEvent) => {
      if (e.sender === worker?.webContents) {
        ipcMain.removeListener('render:ready', onReady)
        res()
      }
    }
    ipcMain.on('render:ready', onReady)
  })
  await loadRenderer(worker, 'render')
  await workerReady
  return worker
}

function ask<T>(win: BrowserWindow, req: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
  const id = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id)
      reject(new Error('렌더링 시간 초과'))
    }, timeoutMs)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t)
        resolve(v as T)
      },
      reject: (e) => {
        clearTimeout(t)
        reject(e)
      }
    })
    win.webContents.send('render:request', id, req)
  })
}

/** Rasterise PDF pages. Returns encoded images in page order. */
export async function rasterizePdf(bytes: Uint8Array, pages: number[] | 'all', dpi: number, format: 'png' | 'jpeg', quality = 0.9): Promise<{ page: number; data: Uint8Array }[]> {
  const w = await getWorker()
  return ask(w, { kind: 'pdf-raster', bytes, pages, scale: dpi / 72, format, quality }, 600_000)
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const w = await getWorker()
  return ask(w, { kind: 'pdf-count', bytes })
}

/** Lay out an HWP (v5) file with hwp.js in a fresh window and print it to PDF. */
export async function hwpToPdf(bytes: Uint8Array): Promise<Buffer> {
  const win = makeWindow()
  try {
    const ready = new Promise<void>((res) => {
      const onReady = (e: Electron.IpcMainEvent) => {
        if (e.sender === win.webContents) {
          ipcMain.removeListener('render:ready', onReady)
          res()
        }
      }
      ipcMain.on('render:ready', onReady)
    })
    await loadRenderer(win, 'render')
    await ready
    await ask(win, { kind: 'hwp-mount', bytes }, 120_000)
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
  } finally {
    win.destroy()
  }
}

/** Print standalone HTML to PDF (A4 via @page CSS). */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const dir = await tmpDir('sc-html-')
  const file = join(dir, 'doc.html')
  await fs.writeFile(file, html, 'utf8')
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } })
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
  } finally {
    win.destroy()
    fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function disposeRenderWorker() {
  if (worker && !worker.isDestroyed()) worker.destroy()
  worker = null
}
