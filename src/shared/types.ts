import type { ActionId } from './formats'

export type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'

export interface ImageOptions {
  quality: number // 1-100
  resize: 'none' | 'long' | 'width' | 'height' | 'percent' | 'exact'
  size?: number // px (long/width/height) or percent
  width?: number
  height?: number
  fit?: 'cover' | 'contain' | 'fill'
  targetKB?: number // try to fit under this size
  keepFormat?: boolean // img.resize: keep source format
  format?: 'jpg' | 'png' | 'webp' | 'avif' | 'tiff' // for img.resize when not keepFormat
  stripMeta: boolean
  background: string // for flattening transparency → JPG
}

export interface StampOptions {
  signatureId?: string
  anchor: Anchor
  sizePct: number // signature width as % of image/page width
  marginPct: number
  opacity: number // 0-1
  stampPages?: 'last' | 'first' | 'all' | 'custom' // pdf only
  pageList?: string // "1,3-5"
}

export interface ImagesToPdfOptions {
  mode: 'merge' | 'each'
  pageSize: 'original' | 'a4' | 'a4-landscape'
  marginMm: number
  name?: string
}

export interface OfficeOptions {
  engine: 'auto' | 'office' | 'libreoffice' | 'hancom' | 'builtin'
  sheetFit: 'original' | 'onepage' | 'width'
  orientation: 'original' | 'portrait' | 'landscape'
  bitmapMissingFonts: boolean
  dpi: number // for → image
  quality: number
}

export interface PdfRasterOptions {
  dpi: number
  pages: string // "all" | "1-3,5"
  quality: number
}

export interface PdfCompressOptions {
  level: 'low' | 'medium' | 'high'
}

export interface PdfMergeOptions {
  name: string
}

export interface PdfSplitOptions {
  splitMode: 'each' | 'ranges' | 'every'
  ranges?: string
  every?: number
}

export interface PdfEncryptOptions {
  userPassword: string
  ownerPassword?: string
  allowPrint: boolean
  allowCopy: boolean
  allowEdit: boolean
}

export interface VideoOptions {
  vquality: 'high' | 'medium' | 'low'
  codec: 'h264' | 'h265'
  hwaccel: boolean
  remux: boolean // allow lossless container swap when possible
  height?: number // resize
  audioFormat?: 'mp3' | 'm4a' | 'wav'
  audioBitrate?: number // kbps
  targetMB?: number // compress
  start?: string // trim / gif
  end?: string
  fps?: number // gif
  gifWidth?: number
  trimCopy?: boolean
}

export type ActionOptions = Partial<
  ImageOptions & StampOptions & ImagesToPdfOptions & OfficeOptions & PdfRasterOptions & PdfCompressOptions &
    PdfMergeOptions & PdfSplitOptions & PdfEncryptOptions & VideoOptions
> & { hwpTarget?: 'hwp' | 'hwpx' }

// ---------- PDF editor document model ----------
export interface EditPageRef {
  src: number // index into sources
  index: number // page index in that source (-1 = blank page)
  rotate: number // extra rotation 0/90/180/270 (clockwise)
  width?: number // for blank pages (pt)
  height?: number
  raster?: string // base64 PNG — page flattened (redaction applied), display-oriented
}

export type AnnoType = 'text' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'highlight' | 'whiteout' | 'redact' | 'image' | 'signature' | 'pen'

export interface Annotation {
  id: string
  type: AnnoType
  page: number // index in pages[]
  // display-space points (page as shown, top-left origin)
  x: number
  y: number
  w: number
  h: number
  color?: string
  fill?: string
  strokeWidth?: number
  opacity?: number
  text?: string
  fontSize?: number
  bold?: boolean
  image?: string // base64 PNG/JPG
  points?: number[] // pen: flat [x,y,...] in display space; line/arrow: [x1,y1,x2,y2]
}

export interface EditDocument {
  sources: string[]
  pages: EditPageRef[]
  annotations: Annotation[]
  outputName?: string
}

// ---------- Settings ----------
export interface SignatureMeta {
  id: string
  name: string
  kind: 'signature' | 'seal'
  createdAt: number
  width: number
  height: number
}

export interface Settings {
  outputFolderName: string
  downloadDir: string
  officeEngine: 'auto' | 'office' | 'libreoffice'
  sofficePath: string
  preflightFonts: boolean
  fontAliases: Record<string, string>
  presets: Partial<Record<ActionId, ActionOptions>>
  cookiesBrowser: 'none' | 'chrome' | 'edge' | 'firefox' | 'safari' | 'whale' | 'brave'
  downloadFormat: 'best' | '1080' | '720' | 'audio'
  autoUpdateDownloader: boolean
  autoUpdateApp: boolean
  theme: 'system' | 'light' | 'dark'
  signatures: SignatureMeta[]
  defaultSignatureId?: string
  shellIntegration: boolean
  overlayRunsImmediately: boolean
  lastAction?: ActionId
  concurrency: number
  // screenshot library
  libraryEnabled: boolean
  libraryDir: string
  libraryCollectMode: 'move' | 'copy'
  libraryClipboard: boolean
  libraryExtraFolders: string[]
  launchAtLogin: boolean
  closeToTray: boolean
}

export interface LibraryItem {
  path: string
  name: string
  size: number
  mtime: number
  ctime: number
}

// ---------- Jobs ----------
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface FileResult {
  input: string
  outputs: string[]
  status: JobStatus
  progress: number // 0-1
  message?: string
  report?: QualityReport
}

export interface QualityReport {
  engine?: string
  fidelity?: 'high' | 'medium' | 'low'
  missingFonts?: string[]
  usedFonts?: string[]
  embeddedFonts?: number
  totalFonts?: number
  nonEmbedded?: string[]
  pagesIn?: number
  pagesOut?: number
  bytesIn?: number
  bytesOut?: number
  notes?: string[]
}

export interface Job {
  id: string
  action: ActionId | 'download'
  options: ActionOptions
  files: FileResult[]
  status: JobStatus
  createdAt: number
  outDirs: string[]
  title?: string
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  progress?: number
  notes?: string
  message?: string
}

export interface EngineStatus {
  platform: NodeJS.Platform
  office: { word: boolean; excel: boolean; powerpoint: boolean }
  hancom: boolean
  libreoffice: string | null
  ffmpeg: string | null
  ytdlp: string | null
  hwEncoders: string[]
}

export interface DownloadRequest {
  urls: string[]
  format?: Settings['downloadFormat']
}

export interface UrlInfo {
  url: string
  site: string
  title?: string
  thumbnail?: string
  duration?: number
  error?: string
}
