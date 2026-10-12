// GitHub Releases auto-update: check on launch + every 4h, download in background,
// tell the UI when a version is ready, install on user request (or on next quit).
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let timer: NodeJS.Timeout | null = null

function emit(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', state)
}

export function initUpdater(enabled: boolean) {
  ipcMain.handle('update:state', () => state)
  ipcMain.handle('update:check', () => check(true))
  ipcMain.handle('update:install', () => {
    if (state.status === 'ready') autoUpdater.quitAndInstall(false, true)
  })
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => emit({ status: 'checking' }))
  autoUpdater.on('update-available', (i) => emit({ status: 'downloading', version: i.version, progress: 0, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : undefined }))
  autoUpdater.on('update-not-available', () => emit({ status: 'latest' }))
  autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', progress: p.percent / 100 }))
  autoUpdater.on('update-downloaded', (i) => emit({ status: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => emit({ status: 'error', message: friendly(e?.message ?? String(e)) }))

  if (enabled) {
    setTimeout(() => check(false), 8_000)
    timer = setInterval(() => check(false), 4 * 3600 * 1000)
  }
}

export function setUpdaterEnabled(enabled: boolean) {
  if (!app.isPackaged) return
  if (timer) clearInterval(timer)
  timer = enabled ? setInterval(() => check(false), 4 * 3600 * 1000) : null
}

async function check(manual: boolean): Promise<UpdateState> {
  if (!app.isPackaged) return { ...state, status: 'error', message: '개발 모드에서는 업데이트를 확인하지 않습니다.' }
  if (state.status === 'downloading' || state.status === 'ready') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    if (manual) emit({ status: 'error', message: friendly((e as Error).message) })
  }
  return state
}

const friendly = (m: string) => {
  if (/404|Cannot find latest/i.test(m)) return '아직 배포된 릴리스가 없습니다.'
  if (/code signature|not signed|ShipIt/i.test(m)) return 'macOS 자동 설치에는 서명된 빌드가 필요합니다. Releases에서 직접 내려받아 주세요.'
  if (/net::|ENOTFOUND|ETIMEDOUT/i.test(m)) return '네트워크에 연결할 수 없습니다.'
  return m.slice(0, 200)
}
