import JSZip from 'jszip'
import { promises as fs } from 'fs'
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRef } from '@cantoo/pdf-lib'
import { extOf } from '@shared/formats'
import { getSettings } from '../settings'

let systemFonts: Set<string> | null = null
const norm = (s: string) => s.toLowerCase().replace(/^"|"$/g, '').replace(/[\s_-]+/g, '')

export async function getSystemFonts(): Promise<Set<string>> {
  if (systemFonts) return systemFonts
  try {
    const { getFonts } = (await import('font-list')) as { getFonts: (o?: { disableQuoting?: boolean }) => Promise<string[]> }
    const list = await getFonts({ disableQuoting: true })
    systemFonts = new Set(list.map(norm))
  } catch {
    systemFonts = new Set()
  }
  return systemFonts
}

const isInstalled = (name: string, sys: Set<string>, aliases: Record<string, string>): boolean => {
  const n = norm(name)
  if (sys.has(n)) return true
  // alias in either direction (Korean ↔ English family names)
  for (const [ko, en] of Object.entries(aliases)) {
    if (norm(ko) === n && sys.has(norm(en))) return true
    if (norm(en) === n && sys.has(norm(ko))) return true
  }
  // family prefix match ("Pretendard SemiBold" vs "Pretendard")
  for (const f of sys) if (f.length > 3 && (n.startsWith(f) || f.startsWith(n))) return true
  return false
}

/** Fonts referenced by an OOXML / HWPX document. */
export async function usedFonts(src: string): Promise<string[]> {
  const ext = extOf(src)
  if (!['docx', 'pptx', 'xlsx', 'xlsm', 'hwpx', 'ppsx'].includes(ext)) return []
  const zip = await JSZip.loadAsync(await fs.readFile(src))
  const names = new Set<string>()
  const files = Object.keys(zip.files).filter((f) => f.endsWith('.xml'))
  const themeFonts: Record<string, string> = {}
  for (const f of files.filter((f) => /theme\d*\.xml$/.test(f))) {
    const x = await zip.file(f)!.async('string')
    const maj = /<a:majorFont>([\s\S]*?)<\/a:majorFont>/.exec(x)?.[1] ?? ''
    const min = /<a:minorFont>([\s\S]*?)<\/a:minorFont>/.exec(x)?.[1] ?? ''
    const pick = (blk: string, tag: string) => new RegExp(`<a:${tag} typeface="([^"]*)"`).exec(blk)?.[1]
    const hang = (blk: string) => /<a:font script="Hang" typeface="([^"]*)"/.exec(blk)?.[1]
    themeFonts['+mj-lt'] = pick(maj, 'latin') ?? ''
    themeFonts['+mn-lt'] = pick(min, 'latin') ?? ''
    themeFonts['+mj-ea'] = pick(maj, 'ea') || hang(maj) || ''
    themeFonts['+mn-ea'] = pick(min, 'ea') || hang(min) || ''
    Object.values(themeFonts).forEach((v) => v && names.add(v))
  }
  const patterns = [
    /typeface="([^"]+)"/g, // pptx a:latin/a:ea/a:cs
    /w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/g, // docx w:rFonts
    /<name val="([^"]+)"/g, // xlsx styles
    /<hh:font [^>]*face="([^"]+)"/g // hwpx header
  ]
  for (const f of files) {
    if (/theme\d*\.xml$/.test(f)) continue
    if (!/(slide|document|styles|header|sharedStrings|section|numbering|footnotes|fontTable)/i.test(f)) continue
    const x = await zip.file(f)!.async('string')
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(x))) {
        const v = m[1]
        if (!v || v.startsWith('+')) {
          if (v && themeFonts[v]) names.add(themeFonts[v])
          continue
        }
        names.add(v)
      }
    }
  }
  return [...names].filter((n) => n && !/^(Symbol|Wingdings.*|Webdings|Marlett)$/i.test(n)).sort()
}

export async function preflight(src: string): Promise<{ used: string[]; missing: string[] }> {
  if (!getSettings().preflightFonts) return { used: [], missing: [] }
  const used = await usedFonts(src).catch(() => [] as string[])
  if (!used.length) return { used, missing: [] }
  const sys = await getSystemFonts()
  if (!sys.size) return { used, missing: [] }
  const aliases = getSettings().fontAliases
  return { used, missing: used.filter((f) => !isInstalled(f, sys, aliases)) }
}

/** Inspect a PDF: page count + which fonts are embedded. */
export async function postflightPdf(pdfPath: string): Promise<{ pages: number; total: number; embedded: number; nonEmbedded: string[] }> {
  const doc = await PDFDocument.load(await fs.readFile(pdfPath), { ignoreEncryption: true, updateMetadata: false })
  const ctx = doc.context
  const seen = new Set<string>()
  let total = 0
  let embedded = 0
  const nonEmbedded: string[] = []
  const lookupDict = (v: unknown): PDFDict | undefined => {
    const o = v instanceof PDFRef ? ctx.lookup(v) : v
    return o instanceof PDFDict ? o : undefined
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue
    if (obj.get(PDFName.of('Type')) !== PDFName.of('Font')) continue
    const sub = obj.get(PDFName.of('Subtype'))
    if (sub === PDFName.of('CIDFontType0') || sub === PDFName.of('CIDFontType2')) continue // counted via Type0
    const baseName = (obj.get(PDFName.of('BaseFont'))?.toString() ?? '?').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '')
    if (seen.has(baseName)) continue
    seen.add(baseName)
    total++
    if (sub === PDFName.of('Type3')) {
      embedded++
      continue
    }
    let desc = lookupDict(obj.get(PDFName.of('FontDescriptor')))
    if (!desc && sub === PDFName.of('Type0')) {
      const arr = obj.get(PDFName.of('DescendantFonts'))
      const a = (arr instanceof PDFRef ? ctx.lookup(arr) : arr) as PDFArray | undefined
      const d0 = a && a.size() ? lookupDict(a.get(0)) : undefined
      desc = d0 ? lookupDict(d0.get(PDFName.of('FontDescriptor'))) : undefined
    }
    const has = desc && (desc.has(PDFName.of('FontFile')) || desc.has(PDFName.of('FontFile2')) || desc.has(PDFName.of('FontFile3')))
    if (has) embedded++
    else nonEmbedded.push(decodePdfName(baseName))
  }
  return { pages: doc.getPageCount(), total, embedded, nonEmbedded }
}

const decodePdfName = (n: string) => {
  try {
    return decodeURIComponent(n.replace(/#([0-9a-f]{2})/gi, '%$1'))
  } catch {
    return n
  }
}

/** Slide count from a pptx (for page-count verification). */
export async function slideCount(src: string): Promise<number | undefined> {
  if (!/\.pptx$/i.test(src)) return undefined
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(src))
    let n = 0
    for (const f of Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))) {
      const head = (await zip.file(f)!.async('string')).slice(0, 600)
      if (!/<p:sld\b[^>]*\bshow="0"/.test(head)) n++ // hidden slides are not exported
    }
    return n || undefined
  } catch {
    return undefined
  }
}
