import type { ActionId } from './formats'
import type { ActionOptions } from './types'

const IMG: ActionOptions = { quality: 88, resize: 'none', stripMeta: true, background: '#ffffff', fit: 'contain' }
const STAMP: ActionOptions = { anchor: 'br', sizePct: 18, marginPct: 4, opacity: 1, stampPages: 'last' }
const OFFICE: ActionOptions = {
  engine: 'auto',
  sheetFit: 'width',
  orientation: 'original',
  bitmapMissingFonts: true,
  dpi: 200,
  quality: 90
}
const VID: ActionOptions = { vquality: 'high', codec: 'h264', hwaccel: true, remux: true }

export const DEFAULT_OPTIONS: Record<ActionId, ActionOptions> = {
  'img.jpg': IMG,
  'img.png': IMG,
  'img.webp': { ...IMG, quality: 82 },
  'img.avif': { ...IMG, quality: 60 },
  'img.tiff': IMG,
  'img.resize': { ...IMG, resize: 'long', size: 1920, keepFormat: true },
  'img.pdf': { mode: 'merge', pageSize: 'original', marginMm: 0, quality: 90 },
  'img.sign': { ...IMG, ...STAMP, keepFormat: true },

  'doc.pdf': OFFICE,
  'doc.docx': OFFICE,
  'doc.hwp': { ...OFFICE, hwpTarget: 'hwpx' },
  'doc.jpg': OFFICE,
  'slide.pdf': OFFICE,
  'slide.pptx': OFFICE,
  'slide.jpg': OFFICE,
  'slide.png': OFFICE,
  'sheet.pdf': OFFICE,
  'sheet.xlsx': OFFICE,
  'sheet.csv': OFFICE,
  'hwp.pdf': OFFICE,
  'hwp.docx': OFFICE,
  'hwp.jpg': OFFICE,
  'hwp.hwpx': OFFICE,

  'pdf.jpg': { dpi: 200, pages: 'all', quality: 90 },
  'pdf.png': { dpi: 200, pages: 'all', quality: 90 },
  'pdf.compress': { level: 'medium' },
  'pdf.merge': { name: 'merged' },
  'pdf.split': { splitMode: 'each', ranges: '', every: 1 },
  'pdf.edit': {},
  'pdf.encrypt': { userPassword: '', ownerPassword: '', allowPrint: true, allowCopy: false, allowEdit: false },
  'pdf.sign': STAMP,

  'vid.mp4': VID,
  'vid.mov': VID,
  'vid.webm': { ...VID, remux: false },
  'vid.gif': { fps: 15, gifWidth: 720, start: '0', end: '' },
  'vid.audio': { audioFormat: 'mp3', audioBitrate: 192 },
  'vid.compress': { ...VID, remux: false, vquality: 'medium', targetMB: 0 },
  'vid.resize': { ...VID, remux: false, height: 1080 },
  'vid.trim': { ...VID, start: '0', end: '', trimCopy: true },

  'aud.mp3': { audioBitrate: 192 },
  'aud.m4a': { audioBitrate: 192 },
  'aud.wav': {},
  'aud.flac': {}
}

export const FONT_ALIASES: Record<string, string> = {
  '맑은 고딕': 'Malgun Gothic',
  '굴림': 'Gulim',
  '굴림체': 'GulimChe',
  '돋움': 'Dotum',
  '돋움체': 'DotumChe',
  '바탕': 'Batang',
  '바탕체': 'BatangChe',
  '궁서': 'Gungsuh',
  '궁서체': 'GungsuhChe',
  '나눔고딕': 'NanumGothic',
  '나눔명조': 'NanumMyeongjo',
  '나눔바른고딕': 'NanumBarunGothic',
  '나눔스퀘어': 'NanumSquare',
  '나눔스퀘어라운드': 'NanumSquareRound',
  '나눔손글씨 펜': 'Nanum Pen Script',
  '애플 SD 산돌고딕 Neo': 'Apple SD Gothic Neo',
  '본고딕': 'Source Han Sans KR',
  '본명조': 'Source Han Serif KR',
  '함초롬바탕': 'HCR Batang',
  '함초롬돋움': 'HCR Dotum',
  '프리텐다드': 'Pretendard',
  '휴먼명조': 'HumanMyeongjo'
}
