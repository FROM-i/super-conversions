import sharp, { Sharp } from 'sharp'
import { promises as fs } from 'fs'
import { extOf } from '@shared/formats'
import type { ActionOptions, Anchor } from '@shared/types'
import { PDFDocument } from '@cantoo/pdf-lib'

sharp.cache(false)

type OutFmt = 'jpg' | 'png' | 'webp' | 'avif' | 'tiff'

/** Decode any supported source into a sharp pipeline (handles HEIC + PSD which sharp can't read natively). */
export async function openImage(path: string, animated = false): Promise<Sharp> {
  const ext = extOf(path)
  const buf = await fs.readFile(path)
  if (ext === 'heic' || ext === 'heif') {
    try {
      await sharp(buf).resize(8).raw().toBuffer() // prebuilt libvips usually lacks HEVC → throws
      return sharp(buf).rotate()
    } catch {
      /* fall through to wasm decoder */
    }
    const decode = (await import('heic-decode')).default as (o: { buffer: Buffer }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
    const img = await decode({ buffer: buf })
    return sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
  }
  if (ext === 'psd') return openPsd(buf)
  if (ext === 'svg') return sharp(buf, { density: 300 })
  return sharp(buf, { animated: animated && (ext === 'gif' || ext === 'webp'), limitInputPixels: false }).rotate()
}

async function openPsd(buf: Buffer): Promise<Sharp> {
  const { readPsd } = await import('ag-psd')
  // Prefer the flattened composite Photoshop stores ("maximize compatibility").
  const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true })
  const comp = psd.imageData
  if (comp && comp.data && comp.data.length) {
    return sharp(Buffer.from(comp.data.buffer, comp.data.byteOffset, comp.data.byteLength), {
      raw: { width: comp.width, height: comp.height, channels: 4 }
    })
  }
  // No composite → naive normal-blend composite of visible layers.
  const full = readPsd(buf, { skipThumbnail: true, useImageData: true })
  const W = full.width
  const H = full.height
  const out = new Uint8ClampedArray(W * H * 4)
  const walk = (layers: typeof full.children) => {
    for (const l of layers ?? []) {
      if (l.hidden) continue
      if (l.children) {
        walk(l.children)
        continue
      }
      const d = l.imageData
      if (!d) continue
      const op = l.opacity ?? 1
      const ox = l.left ?? 0
      const oy = l.top ?? 0
      for (let y = 0; y < d.height; y++) {
        const ty = y + oy
        if (ty < 0 || ty >= H) continue
        for (let x = 0; x < d.width; x++) {
          const tx = x + ox
          if (tx < 0 || tx >= W) continue
          const si = (y * d.width + x) * 4
          const di = (ty * W + tx) * 4
          const a = (d.data[si + 3] / 255) * op
          if (a <= 0) continue
          const da = out[di + 3] / 255
          const oa = a + da * (1 - a)
          for (let c = 0; c < 3; c++) out[di + c] = (d.data[si + c] * a + out[di + c] * da * (1 - a)) / (oa || 1)
          out[di + 3] = oa * 255
        }
      }
    }
  }
  walk(full.children)
  return sharp(Buffer.from(out.buffer), { raw: { width: W, height: H, channels: 4 } })
}

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#ffffff')
  const n = parseInt(m ? m[1] : 'ffffff', 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function applyResize(img: Sharp, o: ActionOptions, meta: { width?: number; height?: number }, scale = 1): Sharp {
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  let w: number | undefined
  let h: number | undefined
  switch (o.resize) {
    case 'long':
      if (o.size) (W >= H ? (w = o.size) : (h = o.size))
      break
    case 'width':
      w = o.size
      break
    case 'height':
      h = o.size
      break
    case 'percent':
      if (o.size) w = Math.round((W * o.size) / 100)
      break
    case 'exact':
      w = o.width
      h = o.height
      break
  }
  if (scale !== 1) {
    w = Math.round((w ?? W) * scale)
    h = h ? Math.round(h * scale) : undefined
  }
  if (!w && !h) return img
  const withoutEnlargement = o.resize !== 'exact' && o.resize !== 'percent'
  return img.resize({ width: w, height: h, fit: o.resize === 'exact' ? (o.fit ?? 'cover') : 'inside', withoutEnlargement })
}

function encode(img: Sharp, fmt: OutFmt, o: ActionOptions, quality: number): Sharp {
  img = img.toColorspace('srgb')
  if (!o.stripMeta) img = img.keepMetadata()
  switch (fmt) {
    case 'jpg':
      return img.flatten({ background: hexToRgb(o.background ?? '#ffffff') }).jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' })
    case 'png':
      return quality < 100 && o.targetKB ? img.png({ palette: true, quality, compressionLevel: 9, effort: 8 }) : img.png({ compressionLevel: 9, adaptiveFiltering: true })
    case 'webp':
      return img.webp({ quality, effort: 5, smartSubsample: true })
    case 'avif':
      return img.avif({ quality, effort: 5 })
    case 'tiff':
      return img.tiff({ compression: 'lzw' })
  }
}

const normFmt = (ext: string): OutFmt => {
  if (ext === 'jpeg' || ext === 'jpg') return 'jpg'
  if (ext === 'png' || ext === 'webp' || ext === 'avif') return ext
  if (ext === 'tif' || ext === 'tiff') return 'tiff'
  return 'jpg' // heic, psd, bmp, gif, svg → jpg by default when "keep format" is impossible
}

export function resolveOutFormat(src: string, o: ActionOptions, forced?: OutFmt): OutFmt {
  if (forced) return forced
  if (o.keepFormat === false && o.format) return o.format
  const e = extOf(src)
  if (e === 'png' || e === 'webp' || e === 'avif' || e === 'tif' || e === 'tiff' || e === 'jpg' || e === 'jpeg') return normFmt(e)
  return 'jpg'
}

/** Convert / resize / squeeze one image. Returns bytes written. */
export async function convertImage(src: string, dst: string, fmt: OutFmt, o: ActionOptions, stamp?: { png: Buffer; o: ActionOptions }): Promise<number> {
  const animated = (fmt === 'webp' || fmt === 'png') && /\.(gif|webp)$/i.test(src)
  const base = await openImage(src, animated)
  const meta = await base.clone().metadata()

  const build = async (quality: number, scale: number) => {
    let img = applyResize(base.clone(), o, meta, scale)
    if (stamp) img = await stampImage(img, stamp.png, stamp.o)
    return encode(img, fmt, o, quality).toBuffer()
  }

  let quality = Math.max(1, Math.min(100, o.quality ?? 88))
  let out = await build(quality, 1)
  const target = o.targetKB ? o.targetKB * 1024 : 0
  if (target && out.length > target && fmt !== 'tiff') {
    // 1) binary search quality, 2) then shrink dimensions
    let lo = 25
    let hi = quality
    let best: Buffer | null = null
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const b = await build(mid, 1)
      if (b.length <= target) {
        best = b
        lo = mid + 1
      } else hi = mid - 1
    }
    if (best) out = best
    else {
      let scale = 1
      quality = 70
      for (let i = 0; i < 10 && out.length > target; i++) {
        scale *= 0.85
        out = await build(quality, scale)
      }
    }
  }
  await fs.writeFile(dst, out)
  return out.length
}

// ---------- Signature stamping ----------
export function anchorXY(anchor: Anchor, W: number, H: number, w: number, h: number, margin: number) {
  const col = anchor[1] === 'l' ? 0 : anchor[1] === 'c' ? 1 : 2
  const row = anchor[0] === 't' ? 0 : anchor[0] === 'm' ? 1 : 2
  const x = col === 0 ? margin : col === 1 ? (W - w) / 2 : W - w - margin
  const y = row === 0 ? margin : row === 1 ? (H - h) / 2 : H - h - margin
  return { x: Math.round(x), y: Math.round(y) }
}

async function stampImage(img: Sharp, sigPng: Buffer, o: ActionOptions): Promise<Sharp> {
  // materialise to know final size
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const sw = Math.max(16, Math.round((W * (o.sizePct ?? 18)) / 100))
  let sig = sharp(sigPng).resize({ width: sw })
  if ((o.opacity ?? 1) < 1) {
    const r = await sig.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let i = 3; i < r.data.length; i += 4) r.data[i] = Math.round(r.data[i] * (o.opacity ?? 1))
    sig = sharp(r.data, { raw: { width: r.info.width, height: r.info.height, channels: 4 } })
  }
  const sigBuf = await sig.png().toBuffer()
  const sm = await sharp(sigBuf).metadata()
  const margin = Math.round((Math.min(W, H) * (o.marginPct ?? 4)) / 100)
  const { x, y } = anchorXY(o.anchor ?? 'br', W, H, sm.width ?? sw, sm.height ?? sw, margin)
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).composite([{ input: sigBuf, left: Math.max(0, x), top: Math.max(0, y) }])
}

// ---------- Images → PDF ----------
export async function imagesToPdf(srcs: string[], o: ActionOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const mm = (v: number) => (v * 72) / 25.4
  for (const src of srcs) {
    await appendImagePage(doc, src, o, mm)
  }
  return doc.save()
}

export async function appendImagePage(doc: PDFDocument, src: string, o: ActionOptions, mm = (v: number) => (v * 72) / 25.4) {
  const img = await openImage(src)
  const meta = await img.clone().metadata()
  const hasAlpha = !!meta.hasAlpha
  const bytes = hasAlpha ? await img.png().toBuffer() : await img.toColorspace('srgb').jpeg({ quality: o.quality ?? 90 }).toBuffer()
  const emb = hasAlpha ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  const density = meta.density && meta.density > 0 ? meta.density : 96
  const natW = (emb.width * 72) / density
  const natH = (emb.height * 72) / density
  let pw = natW
  let ph = natH
  if (o.pageSize === 'a4') [pw, ph] = [595.28, 841.89]
  if (o.pageSize === 'a4-landscape') [pw, ph] = [841.89, 595.28]
  const m = mm(o.marginMm ?? 0)
  if (o.pageSize === 'original' || !o.pageSize) {
    pw += 2 * m
    ph += 2 * m
  }
  const page = doc.addPage([pw, ph])
  const s = Math.min((pw - 2 * m) / emb.width, (ph - 2 * m) / emb.height)
  const w = emb.width * s
  const h = emb.height * s
  page.drawImage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
}
