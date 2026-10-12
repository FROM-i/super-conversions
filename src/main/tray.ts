import { app, Menu, Tray, nativeImage } from 'electron'
import { resourcePath, isMac } from './tools'
import { getSettings, saveSettings } from './settings'
import { startLibrary, stopLibrary } from './library'

let tray: Tray | null = null

export function ensureTray(openView: (view?: string) => void) {
  if (tray) return refreshTray(openView)
  const icon = nativeImage.createFromPath(resourcePath('icons', isMac ? 'trayTemplate.png' : 'tray.png'))
  if (isMac) icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Super Conversions')
  if (!isMac) tray.on('click', () => openView())
  refreshTray(openView)
}

export function refreshTray(openView: (view?: string) => void) {
  if (!tray) return
  const s = getSettings()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Super Conversions 열기', click: () => openView() },
      { label: '스크린샷 라이브러리', click: () => openView('library') },
      { type: 'separator' },
      {
        label: '스크린샷 자동 수집',
        type: 'checkbox',
        checked: s.libraryEnabled,
        click: async (item) => {
          await saveSettings({ libraryEnabled: item.checked })
          item.checked ? await startLibrary() : stopLibrary()
          refreshTray(openView)
        }
      },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() }
    ])
  )
}

export function destroyTray() {
  tray?.destroy()
  tray = null
}

/** Keep running in the tray when the window closes (so screenshots keep being collected). */
export const keepAlive = () => {
  const s = getSettings()
  return s.libraryEnabled && s.closeToTray
}

export function applyLoginItem() {
  const s = getSettings()
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] })
}
