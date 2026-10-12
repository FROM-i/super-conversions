import { promises as fs } from 'fs'
import zlib from 'zlib'
import sharp from 'sharp'
import fontkit from '@cantoo/fontkit'
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFNumber,
  PDFRef,
  PDFPage,
  PDFFont,
  degrees,
  rgb,
  BlendMode,
  LineCapStyle
} from '@cantoo/pdf-lib'
import type { ActionOptions, Annotation, EditDocument } from '@shared/types'
import { parsePageList } from '../output'
import { anchorXY } from './image'
import { resourcePath } from '../tools'

export async function loadPdf(path: string): Promise<PDFDocument> {
  const bytes = await fs.readFile(path)
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (e) {
    if (/encrypt/i.test(String(e))) throw new Error('암호가 걸린 PDF입니다. 암호를 해제한 뒤 다시 시도해 주세요.')
    throw e
  }
}

const save = (doc: PDFDocument) => doc.save({ useObjectStreams: true })

// ---------- merge ----------
export async function mergePdfs(srcs: string[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const s of srcs) {
    const d = await loadPdf(s)
    const pages = await out.copyPages(d, d.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  return save(out)
}

// ---------- split ----------
export async function splitPdf(src: string, o: ActionOptions): Promise<{ label: string; bytes: Uint8Array }[]> {
  const d = await loadPdf(src)
  const n = d.getPageCount()
  const groups: { label: string; idx: number[] }[] = []
  const pad = (i: number) => String(i).padStart(String(n).length, '0')
  if (o.splitMode === 'ranges' && o.ranges) {
    for (const part of o.ranges.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      const idx = parsePageList(part, n)
      if (idx.length) groups.push({ label: `_p${part.replace(/\s/g, '')}`, idx })
    }
  } else if (o.splitMode === 'every' && o.every && o.every > 1) {
    for (let i = 0; i < n; i += o.every) {
      const idx = [...Array(Math.min(o.every, n - i)).keys()].map((k) => k + i)
      groups.push({ label: `_p${pad(i + 1)}-${pad(idx[idx.length - 1] + 1)}`, idx })
    }
  } else {
    for (let i = 0; i < n; i++) groups.push({ label: `_p${pad(i + 1)}`, idx: [i] })
  }
  const res: { label: string; bytes: Uint8Array }[] = []
  for (const g of groups) {
    const out = await PDFDocument.create()
    const pages = await out.copyPages(d, g.idx)
    pages.forEach((p) => out.addPage(p))
    res.push({ label: g.label, bytes: await save(out) })
  }
  return res
}

// ---------- encrypt ----------
export async function encryptPdf(src: string, o: ActionOptions): Promise<Uint8Array> {
  if (!o.userPassword) throw new Error('열기 암호를 입력해 주세요.')
  const d = await loadPdf(src)
  d.encrypt({
    userPassword: o.userPassword,
    ownerPassword: o.ownerPassword || o.userPassword + '#owner',
    permissions: {
      printing: o.allowPrint ? 'highResolution' : false,
      copying: !!o.allowCopy,
      modifying: !!o.allowEdit,
      annotating: !!o.allowEdit,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: !!o.allowEdit
    }
  })
  return d.save({ useObjectStreams: false })
}

// ---------- compress (re-encode embedded raster images) ----------
const LEVELS = { low: { maxPx: 2600, q: 82 }, medium: { maxPx: 1800, q: 72 }, high: { maxPx: 1200, q: 58 } } as const

export async function compressPdf(src: string, o: ActionOptions): Promise<{ bytes: Uint8Array; before: number; after: number; images: number }> {
  const orig = await fs.readFile(src)
  const d = await PDFDocument.load(orig, { updateMetadata: false })
  const ctx = d.context
  const L = LEVELS[o.level ?? 'medium']
  const smasks = new Set<string>()
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const sm = obj.dict.get(PDFName.of('SMask'))
      if (sm instanceof PDFRef) smasks.add(sm.toString())
    }
  }
  let touched = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const dict = obj.dict
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue
    if (smasks.has(ref.toString())) continue
    if (dict.has(PDFName.of('ImageMask')) || dict.has(PDFName.of('Mask')) || dict.has(PDFName.of('Decode'))) continue
    const w = (dict.get(PDFName.of('Width')) as PDFNumber)?.asNumber()
    const h = (dict.get(PDFName.of('Height')) as PDFNumber)?.asNumber()
    const bpc = (dict.get(PDFName.of('BitsPerComponent')) as PDFNumber | undefined)?.asNumber()
    const filter = dict.get(PDFName.of('Filter'))
    const cs = dict.get(PDFName.of('ColorSpace'))
    if (!w || !h || w * h < 40_000) continue
    let input: sharp.Sharp | null = null
    try {
      if (filter === PDFName.of('DCTDecode')) {
        input = sharp(Buffer.from(obj.contents))
      } else if (filter === PDFName.of('FlateDecode') && bpc === 8 && !dict.has(PDFName.of('DecodeParms'))) {
        const channels = cs === PDFName.of('DeviceRGB') ? 3 : cs === PDFName.of('DeviceGray') ? 1 : 0
        if (!channels) continue
        const raw = zlib.inflateSync(Buffer.from(obj.contents))
        if (raw.length !== w * h * channels) continue
        input = sharp(raw, { raw: { width: w, height: h, channels: channels as 1 | 3 } })
      } else continue
      const scale = Math.min(1, L.maxPx / Math.max(w, h))
      const nw = Math.max(1, Math.round(w * scale))
      const nh = Math.max(1, Math.round(h * scale))
      const isGray = cs === PDFName.of('DeviceGray')
      let pipe = input.resize(nw, nh, { fit: 'fill' })
      if (isGray) pipe = pipe.toColourspace('b-w')
      else pipe = pipe.toColorspace('srgb')
      const jpg = await pipe.jpeg({ quality: L.q, mozjpeg: true }).toBuffer()
      if (jpg.length >= obj.contents.length * 0.95 && scale === 1) continue
      const nd = dict.clone(ctx)
      nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'))
      nd.delete(PDFName.of('DecodeParms'))
      nd.set(PDFName.of('Width'), PDFNumber.of(nw))
      nd.set(PDFName.of('Height'), PDFNumber.of(nh))
      nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8))
      nd.set(PDFName.of('ColorSpace'), PDFName.of(isGray ? 'DeviceGray' : 'DeviceRGB'))
      nd.set(PDFName.of('Length'), PDFNumber.of(jpg.length))
      ctx.assign(ref, PDFRawStream.of(nd, new Uint8Array(jpg)))
      touched++
    } catch {
      /* leave image untouched */
    }
  }
  const out = await save(d)
  if (out.length >= orig.length) return { bytes: new Uint8Array(orig), before: orig.length, after: orig.length, images: 0 }
  return { bytes: out, before: orig.length, after: out.length, images: touched }
}

// ---------- coordinate mapping (display space → PDF user space) ----------
interface PageGeom {
  x0: number
  y0: number
  W: number
  H: number
  r: number // total rotation clockwise
  dw: number // display width
  dh: number
}
function geom(page: PDFPage): PageGeom {
  const box = page.getCropBox()
  const r = (((page.getRotation().angle % 360) + 360) % 360) as number
  const swap = r === 90 || r === 270
  return { x0: box.x, y0: box.y, W: box.width, H: box.height, r, dw: swap ? box.height : box.width, dh: swap ? box.width : box.height }
}
function toPdf(g: PageGeom, dx: number, dy: number): { x: number; y: number } {
  let x: number, y: number
  switch (g.r) {
    case 90:
      x = dy
      y = dx
      break
    case 180:
      x = g.W - dx
      y = dy
      break
    case 270:
      x = g.W - dy
      y = g.H - dx
      break
    default:
      x = dx
      y = g.H - dy
  }
  return { x: x + g.x0, y: y + g.y0 }
}

const hex = (c?: string, fb = '#000000') => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || fb) ?? /^#?([0-9a-f]{6})$/i.exec(fb)!
  const n = parseInt(m[1], 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

interface Fonts {
  regular: PDFFont
  bold: PDFFont
}
async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit)
  const reg = await fs.readFile(resourcePath('fonts', 'Pretendard-Regular.otf'))
  const bold = await fs.readFile(resourcePath('fonts', 'Pretendard-Bold.otf'))
  return { regular: await doc.embedFont(reg, { subset: true }), bold: await doc.embedFont(bold, { subset: true }) }
}

async function embedImage(doc: PDFDocument, b64: string) {
  const buf = Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64')
  if (buf[0] === 0xff && buf[1] === 0xd8) return doc.embedJpg(buf)
  // normalise anything else to PNG
  const png = buf[0] === 0x89 && buf[1] === 0x50 ? buf : await sharp(buf).png().toBuffer()
  return doc.embedPng(png)
}

/** Draw one annotation onto a page (annotation coords are display-space points). */
async function drawAnnotation(doc: PDFDocument, page: PDFPage, a: Annotation, fonts: () => Promise<Fonts>) {
  const g = geom(page)
  const rot = degrees(g.r) // pdf-lib rotates ccw; page shows clockwise → content appears upright
  const opacity = a.opacity ?? 1
  // bottom-left corner of the display box
  const bl = toPdf(g, a.x, a.y + a.h)
  switch (a.type) {
    case 'rect':
    case 'whiteout':
    case 'redact':
    case 'highlight': {
      const fill = a.type === 'whiteout' ? hex('#ffffff') : a.type === 'redact' ? hex('#000000') : a.fill ? hex(a.fill) : undefined
      const isHl = a.type === 'highlight'
      page.drawRectangle({
        x: bl.x,
        y: bl.y,
        width: a.w,
        height: a.h,
        rotate: rot,
        color: isHl ? hex(a.color, '#FFE14D') : fill,
        opacity: isHl ? 0.4 : a.type === 'rect' ? (a.fill ? opacity : undefined) : 1,
        borderColor: a.type === 'rect' && a.color ? hex(a.color) : undefined,
        borderWidth: a.type === 'rect' ? a.strokeWidth ?? 2 : 0,
        borderOpacity: opacity,
        blendMode: isHl ? BlendMode.Multiply : undefined
      })
      break
    }
    case 'ellipse': {
      const c = toPdf(g, a.x + a.w / 2, a.y + a.h / 2)
      const swap = g.r === 90 || g.r === 270
      page.drawEllipse({
        x: c.x,
        y: c.y,
        xScale: (swap ? a.h : a.w) / 2,
        yScale: (swap ? a.w : a.h) / 2,
        color: a.fill ? hex(a.fill) : undefined,
        opacity: a.fill ? opacity : undefined,
        borderColor: hex(a.color, '#FF4F1F'),
        borderWidth: a.strokeWidth ?? 2,
        borderOpacity: opacity
      })
      break
    }
    case 'line':
    case 'arrow': {
      const p = a.points && a.points.length >= 4 ? a.points : [a.x, a.y, a.x + a.w, a.y + a.h]
      const s = toPdf(g, p[0], p[1])
      const e = toPdf(g, p[2], p[3])
      const color = hex(a.color, '#FF4F1F')
      const thickness = a.strokeWidth ?? 2
      page.drawLine({ start: s, end: e, thickness, color, opacity, lineCap: LineCapStyle.Round })
      if (a.type === 'arrow') {
        const ang = Math.atan2(e.y - s.y, e.x - s.x)
        const len = Math.max(8, thickness * 4)
        for (const da of [Math.PI - 0.45, Math.PI + 0.45]) {
          page.drawLine({ start: e, end: { x: e.x + len * Math.cos(ang + da), y: e.y + len * Math.sin(ang + da) }, thickness, color, opacity, lineCap: LineCapStyle.Round })
        }
      }
      break
    }
    case 'pen': {
      const p = a.points ?? []
      const color = hex(a.color, '#FF4F1F')
      for (let i = 0; i + 3 < p.length; i += 2) {
        page.drawLine({ start: toPdf(g, p[i], p[i + 1]), end: toPdf(g, p[i + 2], p[i + 3]), thickness: a.strokeWidth ?? 2, color, opacity, lineCap: LineCapStyle.Round })
      }
      break
    }
    case 'text': {
      const f = await fonts()
      const font = a.bold ? f.bold : f.regular
      const size = a.fontSize ?? 14
      const lineH = size * 1.3
      const lines = (a.text ?? '').split('\n')
      lines.forEach((ln, i) => {
        // baseline of line i in display space
        const base = toPdf(g, a.x, a.y + size * 0.88 + i * lineH)
        page.drawText(ln, { x: base.x, y: base.y, size, font, color: hex(a.color, '#111111'), opacity, rotate: rot })
      })
      break
    }
    case 'image':
    case 'signature': {
      if (!a.image) break
      const img = await embedImage(doc, a.image)
      page.drawImage(img, { x: bl.x, y: bl.y, width: a.w, height: a.h, rotate: rot, opacity })
      break
    }
  }
}

/** Build the edited PDF from the editor's document model. */
export async function applyEdits(model: EditDocument): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const srcDocs = await Promise.all(model.sources.map((s) => loadPdf(s)))
  let fontCache: Fonts | null = null
  const fonts = async () => (fontCache ??= await embedFonts(out))

  for (let i = 0; i < model.pages.length; i++) {
    const ref = model.pages[i]
    let page: PDFPage
    if (ref.raster) {
      // flattened (redacted) page: raster already shows final orientation
      const img = await out.embedPng(Buffer.from(ref.raster.replace(/^data:[^,]+,/, ''), 'base64'))
      const w = ref.width ?? 595.28
      const h = ref.height ?? 841.89
      page = out.addPage([w, h])
      page.drawImage(img, { x: 0, y: 0, width: w, height: h })
    } else if (ref.index < 0) {
      page = out.addPage([ref.width ?? 595.28, ref.height ?? 841.89])
      if (ref.rotate) page.setRotation(degrees(ref.rotate))
    } else {
      const [p] = await out.copyPages(srcDocs[ref.src], [ref.index])
      page = out.addPage(p)
      const base = p.getRotation().angle
      page.setRotation(degrees((((base + ref.rotate) % 360) + 360) % 360))
    }
    for (const a of model.annotations.filter((x) => x.page === i && !(ref.raster && x.type === 'redact'))) {
      await drawAnnotation(out, page, a, fonts)
    }
  }
  return save(out)
}

// ---------- signature stamping on PDF ----------
export async function signPdf(src: string, sigPng: Buffer, o: ActionOptions): Promise<Uint8Array> {
  const d = await loadPdf(src)
  const img = await d.embedPng(sigPng)
  const n = d.getPageCount()
  let idx: number[]
  switch (o.stampPages) {
    case 'first':
      idx = [0]
      break
    case 'all':
      idx = [...Array(n).keys()]
      break
    case 'custom':
      idx = parsePageList(o.pageList, n)
      break
    default:
      idx = [n - 1]
  }
  for (const i of idx) {
    const page = d.getPage(i)
    const g = geom(page)
    const w = (g.dw * (o.sizePct ?? 18)) / 100
    const h = (w * img.height) / img.width
    const margin = (Math.min(g.dw, g.dh) * (o.marginPct ?? 4)) / 100
    const { x, y } = anchorXY(o.anchor ?? 'br', g.dw, g.dh, w, h, margin)
    await drawAnnotation(d, page, { id: 's', type: 'signature', page: i, x, y, w, h, image: sigPng.toString('base64'), opacity: o.opacity ?? 1 }, async () => {
      throw new Error('no fonts')
    })
  }
  return save(d)
}

/** Page sizes in display orientation (used by the editor + raster jobs). */
export async function pageInfo(src: string): Promise<{ width: number; height: number; rotation: number }[]> {
  const d = await loadPdf(src)
  return d.getPages().map((p) => {
    const g = geom(p)
    return { width: g.dw, height: g.dh, rotation: g.r }
  })
}

