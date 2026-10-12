import { app, BrowserWindow, ipcMain, dialog, shell, screen, nativeImage, nativeTheme, Menu } from 'electron'
import { join } from 'path'
import { promises as fs, statSync } from 'fs'
import sharp from 'sharp'
import { initUpdater, setUpdaterEnabled } from './updater'
import { categoryOf, type ActionId } from '@shared/formats'
import type { ActionOptions, EditDocument, EngineStatus, Settings } from '@shared/types'
import { getSettings, saveSettings, addSignature, removeSignature, getSignaturePng } from './settings'
import { startJob, startEditJob, startDownloadJob, cancelJob, listJobs, clearFinished } from './jobs'
import { detectOffice, officeWorker } from './engines/office'
import { probeUrl, extractUrls } from './engines/download'
import { pageInfo } from './engines/pdf'
import { ffmpegPath, findSoffice, probeHwEncoders, ytdlpBin, updateYtdlp, isMac, isWin } from './tools'
import { setShellIntegration } from './integration'
import { disposeRenderWorker } from './render'
import { existsSync } from 'fs'

let main: BrowserWindow | null = null
let overlay: BrowserWindow | null = null
let pendingShellFiles: string[] = []
let shellTimer: NodeJS.Timeout | null = null

// ---------------------------------------------------------------- single instance + shell args
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv)
    if (files.length) queueShellFiles(files)
    else focusMain()
  })
}

function filesFromArgv(argv: string[]): string[] {
  const i = argv.indexOf('--sc-grid')
  const cands = i >= 0 ? argv.slice(i + 1) : argv.slice(app.isPackaged ? 1 : 2)
  return cands.filter((a) => a && !a.startsWith('-') && existsSync(a))
}

/** Explorer launches one process per selected file — collect them for a moment, then open one grid. */
function queueShellFiles(files: string[]) {
  pendingShellFiles.push(...files)
  if (shellTimer) clearTimeout(shellTimer)
  shellTimer = setTimeout(async () => {
    const all = await expandPaths([...new Set(pendingShellFiles)])
    pendingShellFiles = []
    if (all.length) openOverlay(all)
  }, 350)
}

app.on('open-file', (e, path) => {
  e.preventDefault()
  if (app.isReady()) queueShellFiles([path])
  else pendingShellFiles.push(path)
})

// ---------------------------------------------------------------- windows
function loadRenderer(win: BrowserWindow, hash: string) {
  if (process.env['ELECTRON_RENDERER_URL']) return win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  return win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

const bg = () => (nativeTheme.shouldUseDarkColors ? '#121212' : '#F0EEE9')

function createMain() {
  main = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: bg(),
    title: 'Super Conversions',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    ...(isWin ? { titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#F0EEE9' : '#111111', height: 52 } } : {}),
    icon: nativeImage.createFromPath(join(__dirname, '../../build/icon.png')),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  main.once('ready-to-show', () => main?.show())
  main.on('closed', () => {
    main = null
    if (!isMac && !(overlay && !overlay.isDestroyed())) app.quit() // hidden render worker must not keep us alive
  })
  loadRenderer(main, 'main')
}

function focusMain() {
  if (!main) createMain()
  else {
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  }
}

function openOverlay(files: string[]) {
  const size = 432
  const pt = screen.getCursorScreenPoint()
  const wa = screen.getDisplayNearestPoint(pt).workArea
  const x = Math.min(Math.max(wa.x, pt.x - size / 2), wa.x + wa.width - size)
  const y = Math.min(Math.max(wa.y, pt.y - size / 2), wa.y + wa.height - size)
  if (overlay && !overlay.isDestroyed()) {
    overlay.removeAllListeners('closed')
    overlay.destroy()
  }
  overlay = new BrowserWindow({
    x: Math.round(x),
    y: Math.round(y),
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  overlay.once('ready-to-show', () => {
    overlay?.show()
    overlay?.focus()
  })
  overlay.on('blur', () => {
    // close when the user clicks elsewhere, unless a job is running in it
    setTimeout(() => overlay?.webContents.send('overlay:blur'), 50)
  })
  overlay.on('closed', () => {
    overlay = null
    if (!main) app.quit()
  })
  overlay.webContents.once('did-finish-load', () => overlay?.webContents.send('overlay:files', files))
  loadRenderer(overlay, 'overlay')
}

// ---------------------------------------------------------------- helpers
const SKIP_DIRS = new Set(['SUPER CONVERSIONS', 'node_modules', '.git'])
async function expandPaths(paths: string[], depth = 4): Promise<string[]> {
  const out: string[] = []
  const walk = async (p: string, d: number) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      if (d <= 0) return
      const name = p.split(/[\\/]/).pop() ?? ''
      if (SKIP_DIRS.has(name) || name.startsWith('.')) return
      for (const f of (await fs.readdir(p)).sort()) await walk(join(p, f), d - 1)
    } else if (categoryOf(p)) out.push(p)
  }
  for (const p of paths) await walk(p, depth)
  return [...new Set(out)]
}

async function engineStatus(): Promise<EngineStatus> {
  const off = await detectOffice(true)
  return {
    platform: process.platform,
    office: { word: off.word, excel: off.excel, powerpoint: off.powerpoint },
    hancom: off.hancom,
    libreoffice: findSoffice(),
    ffmpeg: ffmpegPath(),
    ytdlp: existsSync(ytdlpBin()) ? ytdlpBin() : null,
    hwEncoders: await probeHwEncoders()
  }
}

async function thumbnail(path: string): Promise<string | null> {
  const cat = categoryOf(path)
  try {
    if (cat === 'image' && !/\.(psd|heic|heif)$/i.test(path)) {
      const b = await sharp(path, { pages: 1 }).rotate().resize(320, 320, { fit: 'inside' }).webp({ quality: 70 }).toBuffer()
      return `data:image/webp;base64,${b.toString('base64')}`
    }
    if (isMac || isWin) {
      const img = await nativeImage.createThumbnailFromPath(path, { width: 320, height: 320 })
      if (!img.isEmpty()) return img.toDataURL()
    }
  } catch {
    /* no thumbnail */
  }
  return null
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    if (patch.autoUpdateApp !== undefined) setUpdaterEnabled(patch.autoUpdateApp)
    return saveSettings(patch)
  })
  ipcMain.handle('engines:status', () => engineStatus())
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged }))

  ipcMain.handle('files:pick', async (_e, kind: 'files' | 'folder') => {
    const win = BrowserWindow.getFocusedWindow() ?? main!
    const r = await dialog.showOpenDialog(win, {
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : expandPaths(r.filePaths)
  })
  ipcMain.handle('files:expand', (_e, paths: string[]) => expandPaths(paths))
  ipcMain.handle('files:thumb', (_e, path: string) => thumbnail(path))
  ipcMain.handle('files:read', async (_e, path: string) => new Uint8Array(await fs.readFile(path)))
  ipcMain.handle('files:stat', async (_e, path: string) => {
    const s = await fs.stat(path)
    return { size: s.size, mtime: s.mtimeMs }
  })
  ipcMain.handle('files:pickPdf', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? main!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('files:pickImage', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? main!, { properties: ['openFile'], filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'gif', 'bmp', 'tif', 'tiff'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const png = await sharp(r.filePaths[0]).rotate().png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  })
  ipcMain.handle('shell:open', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('shell:external', (_e, url: string) => /^https:\/\//.test(url) && shell.openExternal(url))

  ipcMain.handle('job:start', (_e, action: ActionId, files: string[], options?: ActionOptions) => startJob(action, files, options))
  ipcMain.handle('job:edit', (_e, model: EditDocument) => startEditJob(model))
  ipcMain.handle('job:download', (_e, urls: string[]) => startDownloadJob(urls))
  ipcMain.handle('job:cancel', (_e, id: string) => cancelJob(id))
  ipcMain.handle('job:list', () => listJobs())
  ipcMain.handle('job:clear', () => clearFinished())
  ipcMain.handle('url:probe', (_e, url: string) => probeUrl(url))
  ipcMain.handle('url:extract', (_e, text: string) => extractUrls(text))
  ipcMain.handle('pdf:pageInfo', (_e, path: string) => pageInfo(path))

  ipcMain.handle('sig:add', async (_e, name: string, kind: 'signature' | 'seal', dataUrl: string, removeBg: boolean) =>
    addSignature(name, kind, Buffer.from(dataUrl.replace(/^data:[^,]+,/, ''), 'base64'), removeBg)
  )
  ipcMain.handle('sig:remove', (_e, id: string) => removeSignature(id))
  ipcMain.handle('sig:get', async (_e, id?: string) => {
    try {
      return `data:image/png;base64,${(await getSignaturePng(id)).toString('base64')}`
    } catch {
      return null
    }
  })

  ipcMain.handle('shell:integration', async (_e, enable: boolean) => {
    const r = await setShellIntegration(enable)
    if (r.ok) await saveSettings({ shellIntegration: enable })
    return r
  })

  ipcMain.handle('overlay:close', () => {
    if (overlay && !overlay.isDestroyed()) overlay.close()
  })
  ipcMain.handle('overlay:openMain', (_e, files: string[], action?: ActionId) => {
    focusMain()
    if (overlay && !overlay.isDestroyed()) overlay.close()
    const send = () => main?.webContents.send('main:load', files, action)
    if (main?.webContents.isLoading()) main.webContents.once('did-finish-load', send)
    else send()
  })
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(async () => {
  if (isMac) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  else Menu.setApplicationMenu(null)
  registerIpc()
  initUpdater(getSettings().autoUpdateApp)
  const st = process.argv.indexOf('--sc-selftest')
  if (st >= 0) {
    const { runSelfTest } = await import('./selftest')
    const ok = await runSelfTest(process.argv[st + 1] || join(app.getPath('temp'), 'sc-selftest')).catch((e) => (console.error(e), false))
    disposeRenderWorker()
    await officeWorker?.shutdown()
    app.exit(ok ? 0 : 1)
    return
  }
  const launchFiles = [...pendingShellFiles, ...filesFromArgv(process.argv)]
  pendingShellFiles = []
  if (launchFiles.length && process.argv.includes('--sc-grid')) {
    openOverlay(await expandPaths(launchFiles))
  } else {
    createMain()
    if (launchFiles.length) {
      const files = await expandPaths(launchFiles)
      main!.webContents.once('did-finish-load', () => main?.webContents.send('main:load', files))
    }
  }
  if (process.env.SC_SHOT && !app.isPackaged) devShots(process.env.SC_SHOT, process.env.SC_DEMO_FILES?.split('|') ?? [])
  if (getSettings().autoUpdateDownloader) updateYtdlp().catch(() => undefined)
  app.on('activate', () => {
    if (!main) createMain()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
app.on('before-quit', () => {
  disposeRenderWorker()
  officeWorker?.shutdown()
})

// ---------------------------------------------------------------- dev: scripted screenshots
async function devShots(dir: string, files: string[]) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const shot = async (name: string) => {
    const img = await main!.webContents.capturePage()
    await fs.writeFile(join(dir, name + '.png'), img.toPNG())
  }
  const js = (code: string) => main!.webContents.executeJavaScript(code)
  await wait(5000)
  await shot('01-empty')
  main!.webContents.send('main:load', files)
  await wait(2500)
  await shot('02-board')
  await js(`(() => { const t = document.querySelectorAll('.tile')[1]; const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 80, clientY: r.top + 80 })) })()`)
  await wait(900)
  await shot('03-grid')
  await js(`document.querySelectorAll('.grid-menu .cell')[0].click()`)
  await wait(700)
  await shot('04-options')
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))`)
  await wait(300)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))`)
  await wait(900)
  await shot('05-grid-mixed')
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  const pdf = files.find((f) => f.endsWith('.pdf'))
  if (pdf) {
    await js(`window.dispatchEvent(new CustomEvent('sc-open-editor', { detail: ${JSON.stringify(pdf)} }))`)
    await wait(3000)
    await shot('06-editor')
  }
  await js(`document.querySelectorAll('.rail button')[1].click()`)
  await wait(600)
  await shot('07-download')
  await js(`document.querySelectorAll('.rail button')[4].click()`)
  await wait(900)
  await shot('08-settings')
  app.exit(0)
}
