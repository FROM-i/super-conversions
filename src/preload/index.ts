import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ActionId } from '@shared/formats'
import type { ActionOptions, EditDocument, EngineStatus, Job, Settings, UpdateState, UrlInfo } from '@shared/types'

const on = <A extends unknown[]>(ch: string, cb: (...a: A) => void) => {
  const fn = (_e: unknown, ...a: unknown[]) => cb(...(a as A))
  ipcRenderer.on(ch, fn)
  return () => ipcRenderer.removeListener(ch, fn)
}

const api = {
  // settings / app
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (p: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:save', p),
  engineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke('engines:status'),
  appInfo: (): Promise<{ version: string; platform: string; packaged: boolean }> => ipcRenderer.invoke('app:info'),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  checkUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb: (s: UpdateState) => void) => on<[UpdateState]>('update:state', cb),
  // files
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  pick: (kind: 'files' | 'folder'): Promise<string[]> => ipcRenderer.invoke('files:pick', kind),
  pickPdf: (): Promise<string[]> => ipcRenderer.invoke('files:pickPdf'),
  pickImage: (): Promise<string | null> => ipcRenderer.invoke('files:pickImage'),
  expand: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('files:expand', paths),
  thumb: (p: string): Promise<string | null> => ipcRenderer.invoke('files:thumb', p),
  read: (p: string): Promise<Uint8Array> => ipcRenderer.invoke('files:read', p),
  stat: (p: string): Promise<{ size: number; mtime: number }> => ipcRenderer.invoke('files:stat', p),
  open: (p: string) => ipcRenderer.invoke('shell:open', p),
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  external: (url: string) => ipcRenderer.invoke('shell:external', url),
  // jobs
  start: (action: ActionId, files: string[], options?: ActionOptions): Promise<Job> => ipcRenderer.invoke('job:start', action, files, options),
  startEdit: (model: EditDocument): Promise<Job> => ipcRenderer.invoke('job:edit', model),
  startDownload: (urls: string[]): Promise<Job> => ipcRenderer.invoke('job:download', urls),
  cancel: (id: string) => ipcRenderer.invoke('job:cancel', id),
  jobs: (): Promise<Job[]> => ipcRenderer.invoke('job:list'),
  clearJobs: () => ipcRenderer.invoke('job:clear'),
  onJob: (cb: (j: Job) => void) => on<[Job]>('job:update', cb),
  probeUrl: (u: string): Promise<UrlInfo> => ipcRenderer.invoke('url:probe', u),
  extractUrls: (t: string): Promise<string[]> => ipcRenderer.invoke('url:extract', t),
  pdfPageInfo: (p: string): Promise<{ width: number; height: number; rotation: number }[]> => ipcRenderer.invoke('pdf:pageInfo', p),
  // signatures
  addSignature: (name: string, kind: 'signature' | 'seal', dataUrl: string, removeBg: boolean): Promise<Settings> => ipcRenderer.invoke('sig:add', name, kind, dataUrl, removeBg),
  removeSignature: (id: string): Promise<Settings> => ipcRenderer.invoke('sig:remove', id),
  getSignature: (id?: string): Promise<string | null> => ipcRenderer.invoke('sig:get', id),
  shellIntegration: (enable: boolean): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('shell:integration', enable),
  // overlay + main
  onOverlayFiles: (cb: (files: string[]) => void) => on<[string[]]>('overlay:files', cb),
  onOverlayBlur: (cb: () => void) => on<[]>('overlay:blur', cb),
  overlayClose: () => ipcRenderer.invoke('overlay:close'),
  overlayOpenMain: (files: string[], action?: ActionId) => ipcRenderer.invoke('overlay:openMain', files, action),
  onMainLoad: (cb: (files: string[], action?: ActionId) => void) => on<[string[], ActionId | undefined]>('main:load', cb),
  // render worker
  onRenderRequest: (cb: (id: string, req: Record<string, unknown>) => void) => on<[string, Record<string, unknown>]>('render:request', cb),
  renderReply: (id: string, ok: boolean, payload: unknown) => ipcRenderer.send('render:reply', id, ok, payload),
  renderReady: () => ipcRenderer.send('render:ready')
}

export type ScApi = typeof api
contextBridge.exposeInMainWorld('sc', api)
