import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ActionId } from '@shared/formats'
import type { ActionOptions, EditDocument, EngineStatus, Job, LibraryItem, Settings, UpdateState, UrlInfo } from '@shared/types'
import type { RenameItem, RenameRule, RenamePlanRow } from '@shared/rename'

export interface RenameResult {
  ok: boolean
  renamed: { from: string; to: string }[]
  errors: { from: string; error: string }[]
  plan?: RenamePlanRow[]
}

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
  // library
  libraryList: (): Promise<{ dir: string; items: LibraryItem[] }> => ipcRenderer.invoke('library:list'),
  libraryFolders: (): Promise<{ path: string; nameFilter: boolean; label: string }[]> => ipcRenderer.invoke('library:folders'),
  libraryImport: (paths: string[]): Promise<number> => ipcRenderer.invoke('library:import', paths),
  libraryOpen: () => ipcRenderer.invoke('library:open'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('library:pickFolder'),
  onLibrary: (cb: () => void) => on<[]>('library:changed', cb),
  onView: (cb: (view: string) => void) => on<[string]>('main:view', cb),
  thumbCached: (p: string, size?: number): Promise<string | null> => ipcRenderer.invoke('files:thumbCached', p, size),
  imageSize: (p: string): Promise<{ width: number; height: number } | null> => ipcRenderer.invoke('files:imageSize', p),
  trash: (paths: string[]) => ipcRenderer.invoke('files:trash', paths),
  copyImage: (p: string) => ipcRenderer.invoke('files:copyImage', p),
  startDrag: (paths: string[]) => ipcRenderer.send('files:startDrag', paths),
  exists: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('files:exists', paths),
  // rename
  renameBatch: (items: RenameItem[], rule: RenameRule): Promise<RenameResult> => ipcRenderer.invoke('files:renameBatch', items, rule),
  renameOne: (from: string, newName: string): Promise<RenameResult> => ipcRenderer.invoke('files:renameOne', from, newName),
  renameUndo: (): Promise<RenameResult> => ipcRenderer.invoke('files:renameUndo'),
  // render worker
  onRenderRequest: (cb: (id: string, req: Record<string, unknown>) => void) => on<[string, Record<string, unknown>]>('render:request', cb),
  renderReply: (id: string, ok: boolean, payload: unknown) => ipcRenderer.send('render:reply', id, ok, payload),
  renderReady: () => ipcRenderer.send('render:ready')
}

export type ScApi = typeof api
contextBridge.exposeInMainWorld('sc', api)
