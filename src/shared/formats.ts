// Conversion matrix shared by main + renderer.
// Every action lives in exactly one category; the 3x3 grid shows up to 8 actions.

export type Category = 'image' | 'doc' | 'slide' | 'sheet' | 'hwp' | 'pdf' | 'video' | 'audio'

export const CATEGORY_META: Record<Category, { label: string; tone: 'doc' | 'image' | 'video' | 'pdf' }> = {
  image: { label: '이미지', tone: 'image' },
  doc: { label: '문서', tone: 'doc' },
  slide: { label: '슬라이드', tone: 'doc' },
  sheet: { label: '시트', tone: 'doc' },
  hwp: { label: '한글', tone: 'doc' },
  pdf: { label: 'PDF', tone: 'pdf' },
  video: { label: '영상', tone: 'video' },
  audio: { label: '오디오', tone: 'video' }
}

export const EXT_CATEGORY: Record<string, Category> = {}
const reg = (cat: Category, exts: string[]) => exts.forEach((e) => (EXT_CATEGORY[e] = cat))
reg('image', ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif', 'heic', 'heif', 'psd', 'svg'])
reg('doc', ['doc', 'docx', 'odt', 'rtf'])
reg('slide', ['ppt', 'pptx', 'odp', 'pps', 'ppsx'])
reg('sheet', ['xls', 'xlsx', 'xlsm', 'csv', 'ods'])
reg('hwp', ['hwp', 'hwpx'])
reg('pdf', ['pdf'])
reg('video', ['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', '3gp', 'mts', 'm2ts'])
reg('audio', ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'])

export const extOf = (p: string): string => {
  const m = /\.([^.\\/]+)$/.exec(p)
  return m ? m[1].toLowerCase() : ''
}
export const categoryOf = (p: string): Category | null => EXT_CATEGORY[extOf(p)] ?? null

export type ActionId =
  // image
  | 'img.jpg' | 'img.png' | 'img.webp' | 'img.avif' | 'img.tiff' | 'img.resize' | 'img.pdf' | 'img.sign'
  // office docs
  | 'doc.pdf' | 'doc.docx' | 'doc.hwp' | 'doc.jpg'
  | 'slide.pdf' | 'slide.pptx' | 'slide.jpg' | 'slide.png'
  | 'sheet.pdf' | 'sheet.xlsx' | 'sheet.csv'
  | 'hwp.pdf' | 'hwp.docx' | 'hwp.jpg' | 'hwp.hwpx'
  // pdf
  | 'pdf.jpg' | 'pdf.png' | 'pdf.compress' | 'pdf.merge' | 'pdf.split' | 'pdf.edit' | 'pdf.encrypt' | 'pdf.sign'
  // video
  | 'vid.mp4' | 'vid.mov' | 'vid.webm' | 'vid.gif' | 'vid.audio' | 'vid.compress' | 'vid.resize' | 'vid.trim'
  // audio
  | 'aud.mp3' | 'aud.m4a' | 'aud.wav' | 'aud.flac'

export interface ActionDef {
  id: ActionId
  category: Category
  label: string // big glyph on the tile (format name)
  hint: string // small caption
  outExt?: string // undefined = depends on options / same as source
  multiToOne?: boolean // whole selection becomes one output (merge)
  singleOnly?: boolean // opens an editor for exactly one file
}

export const ACTIONS: ActionDef[] = [
  { id: 'img.jpg', category: 'image', label: 'JPG', hint: '범용 이미지', outExt: 'jpg' },
  { id: 'img.png', category: 'image', label: 'PNG', hint: '무손실·투명', outExt: 'png' },
  { id: 'img.webp', category: 'image', label: 'WEBP', hint: '웹 최적화', outExt: 'webp' },
  { id: 'img.avif', category: 'image', label: 'AVIF', hint: '초고압축', outExt: 'avif' },
  { id: 'img.tiff', category: 'image', label: 'TIFF', hint: '인쇄용', outExt: 'tiff' },
  { id: 'img.resize', category: 'image', label: 'SIZE', hint: '크기·용량 조정' },
  { id: 'img.pdf', category: 'image', label: 'PDF', hint: '이미지 → PDF', outExt: 'pdf' },
  { id: 'img.sign', category: 'image', label: 'SIGN', hint: '서명·직인 찍기' },

  { id: 'doc.pdf', category: 'doc', label: 'PDF', hint: '서식 보존', outExt: 'pdf' },
  { id: 'doc.docx', category: 'doc', label: 'DOCX', hint: 'Word 최신', outExt: 'docx' },
  { id: 'doc.hwp', category: 'doc', label: 'HWP', hint: '한글 문서' },
  { id: 'doc.jpg', category: 'doc', label: 'JPG', hint: '페이지 이미지', outExt: 'jpg' },

  { id: 'slide.pdf', category: 'slide', label: 'PDF', hint: '서식 보존', outExt: 'pdf' },
  { id: 'slide.pptx', category: 'slide', label: 'PPTX', hint: 'PowerPoint 최신', outExt: 'pptx' },
  { id: 'slide.jpg', category: 'slide', label: 'JPG', hint: '슬라이드 이미지', outExt: 'jpg' },
  { id: 'slide.png', category: 'slide', label: 'PNG', hint: '슬라이드 이미지', outExt: 'png' },

  { id: 'sheet.pdf', category: 'sheet', label: 'PDF', hint: '시트 맞춤', outExt: 'pdf' },
  { id: 'sheet.xlsx', category: 'sheet', label: 'XLSX', hint: 'Excel 최신', outExt: 'xlsx' },
  { id: 'sheet.csv', category: 'sheet', label: 'CSV', hint: '데이터만', outExt: 'csv' },

  { id: 'hwp.pdf', category: 'hwp', label: 'PDF', hint: '한글 → PDF', outExt: 'pdf' },
  { id: 'hwp.docx', category: 'hwp', label: 'DOCX', hint: '한글 → Word', outExt: 'docx' },
  { id: 'hwp.jpg', category: 'hwp', label: 'JPG', hint: '페이지 이미지', outExt: 'jpg' },
  { id: 'hwp.hwpx', category: 'hwp', label: 'HWP⇄X', hint: 'HWP ↔ HWPX' },

  { id: 'pdf.jpg', category: 'pdf', label: 'JPG', hint: '페이지 → 이미지', outExt: 'jpg' },
  { id: 'pdf.png', category: 'pdf', label: 'PNG', hint: '페이지 → 이미지', outExt: 'png' },
  { id: 'pdf.compress', category: 'pdf', label: 'ZIP', hint: '용량 줄이기', outExt: 'pdf' },
  { id: 'pdf.merge', category: 'pdf', label: 'MERGE', hint: '하나로 합치기', outExt: 'pdf', multiToOne: true },
  { id: 'pdf.split', category: 'pdf', label: 'SPLIT', hint: '나누기', outExt: 'pdf' },
  { id: 'pdf.edit', category: 'pdf', label: 'EDIT', hint: '페이지·주석 편집', outExt: 'pdf', singleOnly: true },
  { id: 'pdf.encrypt', category: 'pdf', label: 'LOCK', hint: '암호 걸기', outExt: 'pdf' },
  { id: 'pdf.sign', category: 'pdf', label: 'SIGN', hint: '서명·직인', outExt: 'pdf' },

  { id: 'vid.mp4', category: 'video', label: 'MP4', hint: 'H.264 범용', outExt: 'mp4' },
  { id: 'vid.mov', category: 'video', label: 'MOV', hint: 'QuickTime', outExt: 'mov' },
  { id: 'vid.webm', category: 'video', label: 'WEBM', hint: '웹 영상', outExt: 'webm' },
  { id: 'vid.gif', category: 'video', label: 'GIF', hint: '움짤', outExt: 'gif' },
  { id: 'vid.audio', category: 'video', label: 'AUDIO', hint: '소리만 추출' },
  { id: 'vid.compress', category: 'video', label: 'SLIM', hint: '용량 줄이기', outExt: 'mp4' },
  { id: 'vid.resize', category: 'video', label: 'RES', hint: '해상도 변경', outExt: 'mp4' },
  { id: 'vid.trim', category: 'video', label: 'TRIM', hint: '구간 자르기' },

  { id: 'aud.mp3', category: 'audio', label: 'MP3', hint: '범용', outExt: 'mp3' },
  { id: 'aud.m4a', category: 'audio', label: 'M4A', hint: 'AAC', outExt: 'm4a' },
  { id: 'aud.wav', category: 'audio', label: 'WAV', hint: '무압축', outExt: 'wav' },
  { id: 'aud.flac', category: 'audio', label: 'FLAC', hint: '무손실', outExt: 'flac' }
]

export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<ActionId, ActionDef>

export const actionsFor = (cat: Category): ActionDef[] => ACTIONS.filter((a) => a.category === cat)

/** Numpad layout: grid slot index (0..8, row-major) -> numpad key. Center (4) is the source tile. */
export const SLOT_NUMPAD = ['7', '8', '9', '4', '5', '6', '1', '2', '3']
/** Outer slots in reading order (skipping center). */
export const OUTER_SLOTS = [0, 1, 2, 3, 5, 6, 7, 8]
