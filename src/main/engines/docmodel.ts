// Lightweight document model used for builtin (no Hancom) HWP/HWPX/DOCX conversions.
// Fidelity target: text, basic character styles, alignment and tables — not full layout.
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  WidthType,
  BorderStyle
} from 'docx'

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  size?: number // pt
  color?: string // #rrggbb
  font?: string
}
export type Align = 'left' | 'center' | 'right' | 'justify'
export interface Para {
  kind: 'p'
  runs: Run[]
  align?: Align
}
export interface Cell {
  blocks: Block[]
  colSpan?: number
  rowSpan?: number
}
export interface Tbl {
  kind: 'table'
  rows: Cell[][]
}
export type Block = Para | Tbl

// ============================ parsers ============================
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', preserveOrder: true, trimValues: false })
type Node = Record<string, unknown> & { ':@'?: Record<string, string> }
const tagOf = (n: Node) => Object.keys(n).find((k) => k !== ':@') ?? ''
const kids = (n: Node): Node[] => (n[tagOf(n)] as Node[]) ?? []
const attr = (n: Node, a: string) => n[':@']?.['@' + a]
const textOf = (n: Node): string =>
  kids(n)
    .map((c) => (tagOf(c) === '#text' ? String(c['#text']) : textOf(c)))
    .join('')

// ---------- HWPX ----------
export async function fromHwpx(buf: Buffer): Promise<Block[]> {
  const zip = await JSZip.loadAsync(buf)
  const header = await zip.file('Contents/header.xml')?.async('string')
  const charPr: Record<string, Run> = {}
  const paraAlign: Record<string, Align> = {}
  const fonts: Record<string, string> = {}
  if (header) {
    for (const m of header.matchAll(/<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/g)) {
      for (const f of m[0].matchAll(/<hh:font id="(\d+)" face="([^"]*)"/g)) fonts[f[1]] = f[2]
    }
    for (const m of header.matchAll(/<hh:charPr id="(\d+)"([^>]*)>([\s\S]*?)<\/hh:charPr>/g)) {
      const h = /height="(\d+)"/.exec(m[2])
      const c = /textColor="(#[0-9A-Fa-f]{6})"/.exec(m[2])
      const fr = /<hh:fontRef hangul="(\d+)"/.exec(m[3])
      charPr[m[1]] = {
        text: '',
        size: h ? +h[1] / 100 : undefined,
        color: c && c[1].toUpperCase() !== '#000000' ? c[1] : undefined,
        bold: /<hh:bold\s*\/>/.test(m[3]),
        italic: /<hh:italic\s*\/>/.test(m[3]),
        underline: /<hh:underline type="(BOTTOM|CENTER|TOP)"/.test(m[3]),
        font: fr ? fonts[fr[1]] : undefined
      }
    }
    for (const m of header.matchAll(/<hh:paraPr id="(\d+)"[\s\S]*?<hh:align horizontal="([A-Z_]+)"/g)) {
      paraAlign[m[1]] = m[2] === 'CENTER' ? 'center' : m[2] === 'RIGHT' ? 'right' : m[2] === 'LEFT' ? 'left' : 'justify'
    }
  }
  const sections = Object.keys(zip.files)
    .filter((f) => /^Contents\/section\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10))
  const blocks: Block[] = []
  for (const s of sections) {
    const tree = xml.parse(await zip.file(s)!.async('string')) as Node[]
    const sec = tree.find((n) => tagOf(n).endsWith(':sec'))
    if (sec) blocks.push(...hwpxBlocks(kids(sec), charPr, paraAlign))
  }
  return blocks
}

function hwpxBlocks(nodes: Node[], charPr: Record<string, Run>, paraAlign: Record<string, Align>): Block[] {
  const out: Block[] = []
  for (const n of nodes) {
    if (tagOf(n) !== 'hp:p') continue
    const runs: Run[] = []
    const tables: Tbl[] = []
    for (const r of kids(n)) {
      if (tagOf(r) !== 'hp:run') continue
      const style = charPr[attr(r, 'charPrIDRef') ?? ''] ?? { text: '' }
      for (const c of kids(r)) {
        const t = tagOf(c)
        if (t === 'hp:t') {
          const txt = kids(c)
            .map((x) => (tagOf(x) === '#text' ? String(x['#text']) : tagOf(x) === 'hp:tab' ? '\t' : tagOf(x) === 'hp:lineBreak' ? '\n' : ''))
            .join('')
          if (txt) runs.push({ ...style, text: txt })
        } else if (t === 'hp:tbl') tables.push(hwpxTable(c, charPr, paraAlign))
      }
    }
    if (runs.length || !tables.length) out.push({ kind: 'p', runs, align: paraAlign[attr(n, 'paraPrIDRef') ?? ''] })
    out.push(...tables)
  }
  return out
}

function hwpxTable(t: Node, charPr: Record<string, Run>, paraAlign: Record<string, Align>): Tbl {
  const rows: Cell[][] = []
  for (const tr of kids(t).filter((x) => tagOf(x) === 'hp:tr')) {
    const row: Cell[] = []
    for (const tc of kids(tr).filter((x) => tagOf(x) === 'hp:tc')) {
      const sub = kids(tc).find((x) => tagOf(x) === 'hp:subList')
      const span = kids(tc).find((x) => tagOf(x) === 'hp:cellSpan')
      row.push({
        blocks: sub ? hwpxBlocks(kids(sub), charPr, paraAlign) : [],
        colSpan: span ? +(attr(span, 'colSpan') ?? 1) : 1,
        rowSpan: span ? +(attr(span, 'rowSpan') ?? 1) : 1
      })
    }
    rows.push(row)
  }
  return { kind: 'table', rows }
}

// ---------- HWP 5 (binary) via hwp.js parser ----------
interface HwpChar { type: number; value: number | string }
interface HwpPara { content: HwpChar[]; shapeBuffer: { pos: number; shapeIndex: number }[]; controls: unknown[]; shapeIndex: number }
interface HwpCharShape { fontBaseSize: number; attr: number; color: number[] | { r: number; g: number; b: number } }

export async function fromHwp5(buf: Buffer): Promise<Block[]> {
  const { parse } = (await import('hwp.js')) as unknown as { parse: (d: Uint8Array, o?: { type: string }) => { info: { charShapes: HwpCharShape[]; paragraphShapes: { align: number }[] }; sections: { content: HwpPara[] }[] } }
  const doc = parse(new Uint8Array(buf), { type: 'array' })
  const shapes = doc.info.charShapes
  const pshapes = doc.info.paragraphShapes
  const toRun = (idx: number, text: string): Run => {
    const s = shapes[idx]
    if (!s) return { text }
    const col = Array.isArray(s.color) ? s.color : s.color ? [s.color.r, s.color.g, s.color.b] : [0, 0, 0]
    const hexc = '#' + col.map((v) => Number(v).toString(16).padStart(2, '0')).join('')
    return { text, size: s.fontBaseSize ? s.fontBaseSize / 100 : undefined, italic: !!(s.attr & 1), bold: !!(s.attr & 2), underline: ((s.attr >> 2) & 3) === 1, color: hexc !== '#000000' ? hexc : undefined }
  }
  const alignOf = (n?: number): Align | undefined => (n === 1 ? 'left' : n === 2 ? 'right' : n === 3 ? 'center' : n === 0 ? 'justify' : undefined)
  const paras = (list: HwpPara[]): Block[] => {
    const out: Block[] = []
    for (const p of list) {
      const runs: Run[] = []
      let cur = ''
      let curShape = p.shapeBuffer[0]?.shapeIndex ?? 0
      let sbI = 0
      p.content.forEach((ch, pos) => {
        while (sbI + 1 < p.shapeBuffer.length && p.shapeBuffer[sbI + 1].pos <= pos) {
          sbI++
          if (cur) runs.push(toRun(curShape, cur))
          cur = ''
          curShape = p.shapeBuffer[sbI].shapeIndex
        }
        if (ch.type === 0 && typeof ch.value === 'string') cur += ch.value
        else if (ch.type === 0 && ch.value === 9) cur += '\t'
        else if (ch.type === 0 && ch.value === 10) cur += '\n'
      })
      if (cur) runs.push(toRun(curShape, cur))
      const tables = (p.controls as { rowCount?: number; content?: { attribute: { colSpan: number; rowSpan: number }; items: HwpPara[] }[][] }[]).filter((c) => c && c.rowCount !== undefined && Array.isArray(c.content))
      if (runs.length || !tables.length) out.push({ kind: 'p', runs, align: alignOf(pshapes[p.shapeIndex]?.align) })
      for (const t of tables) {
        out.push({
          kind: 'table',
          rows: (t.content ?? []).map((row) => (row ?? []).filter(Boolean).map((cell) => ({ blocks: paras(cell.items ?? []), colSpan: cell.attribute?.colSpan ?? 1, rowSpan: cell.attribute?.rowSpan ?? 1 })))
        })
      }
    }
    return out
  }
  return doc.sections.flatMap((s) => paras(s.content))
}

// ---------- DOCX ----------
export async function fromDocx(buf: Buffer): Promise<Block[]> {
  const zip = await JSZip.loadAsync(buf)
  const docXml = await zip.file('word/document.xml')?.async('string')
  if (!docXml) throw new Error('DOCX 본문을 찾을 수 없습니다.')
  const tree = xml.parse(docXml) as Node[]
  const doc = tree.find((n) => tagOf(n) === 'w:document')
  const body = doc ? kids(doc).find((n) => tagOf(n) === 'w:body') : undefined
  return body ? docxBlocks(kids(body)) : []
}

function docxBlocks(nodes: Node[]): Block[] {
  const out: Block[] = []
  for (const n of nodes) {
    const t = tagOf(n)
    if (t === 'w:p') out.push(docxPara(n))
    else if (t === 'w:tbl') {
      const rows: Cell[][] = []
      for (const tr of kids(n).filter((x) => tagOf(x) === 'w:tr')) {
        rows.push(
          kids(tr)
            .filter((x) => tagOf(x) === 'w:tc')
            .map((tc) => {
              const pr = kids(tc).find((x) => tagOf(x) === 'w:tcPr')
              const gs = pr ? kids(pr).find((x) => tagOf(x) === 'w:gridSpan') : undefined
              return { blocks: docxBlocks(kids(tc)), colSpan: gs ? +(attr(gs, 'w:val') ?? 1) : 1 }
            })
        )
      }
      out.push({ kind: 'table', rows })
    } else if (t === 'w:sdt') {
      const c = kids(n).find((x) => tagOf(x) === 'w:sdtContent')
      if (c) out.push(...docxBlocks(kids(c)))
    }
  }
  return out
}

function docxPara(p: Node): Para {
  const runs: Run[] = []
  let align: Align | undefined
  const walk = (nodes: Node[]) => {
    for (const c of nodes) {
      const t = tagOf(c)
      if (t === 'w:pPr') {
        const jc = kids(c).find((x) => tagOf(x) === 'w:jc')
        const v = jc ? attr(jc, 'w:val') : undefined
        align = v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v === 'both' ? 'justify' : v ? 'left' : undefined
      } else if (t === 'w:r') {
        const pr = kids(c).find((x) => tagOf(x) === 'w:rPr')
        const prk = pr ? kids(pr) : []
        const has = (tag: string) => {
          const e = prk.find((x) => tagOf(x) === tag)
          return !!e && attr(e, 'w:val') !== '0' && attr(e, 'w:val') !== 'false'
        }
        const sz = prk.find((x) => tagOf(x) === 'w:sz')
        const col = prk.find((x) => tagOf(x) === 'w:color')
        const rf = prk.find((x) => tagOf(x) === 'w:rFonts')
        const style: Omit<Run, 'text'> = {
          bold: has('w:b'),
          italic: has('w:i'),
          underline: !!prk.find((x) => tagOf(x) === 'w:u' && attr(x, 'w:val') !== 'none'),
          size: sz ? +(attr(sz, 'w:val') ?? 0) / 2 || undefined : undefined,
          color: col && /^[0-9A-Fa-f]{6}$/.test(attr(col, 'w:val') ?? '') && attr(col, 'w:val') !== '000000' ? '#' + attr(col, 'w:val') : undefined,
          font: rf ? attr(rf, 'w:eastAsia') ?? attr(rf, 'w:ascii') : undefined
        }
        let text = ''
        for (const x of kids(c)) {
          const xt = tagOf(x)
          if (xt === 'w:t') text += textOf(x)
          else if (xt === 'w:tab') text += '\t'
          else if (xt === 'w:br' || xt === 'w:cr') text += '\n'
        }
        if (text) runs.push({ ...style, text })
      } else if (t === 'w:hyperlink' || t === 'w:ins' || t === 'w:smartTag' || t === 'w:fldSimple') walk(kids(c))
    }
  }
  walk(kids(p))
  return { kind: 'p', runs, align }
}

// ============================ emitters ============================
const DOCX_ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }

export async function toDocx(blocks: Block[]): Promise<Buffer> {
  const conv = (bs: Block[]): (Paragraph | Table)[] =>
    bs.map((b) =>
      b.kind === 'p'
        ? new Paragraph({
            alignment: b.align ? DOCX_ALIGN[b.align] : undefined,
            children: b.runs.flatMap((r) =>
              r.text.split('\n').map(
                (seg, i) =>
                  new TextRun({
                    text: seg,
                    break: i > 0 ? 1 : undefined,
                    bold: r.bold,
                    italics: r.italic,
                    underline: r.underline ? {} : undefined,
                    size: r.size ? Math.round(r.size * 2) : undefined,
                    color: r.color?.replace('#', ''),
                    font: r.font
                  })
              )
            )
          })
        : new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: b.rows
              .filter((r) => r.length)
              .map(
                (r) =>
                  new TableRow({
                    children: r.map((c) => {
                      const content = conv(c.blocks)
                      return new TableCell({
                        columnSpan: c.colSpan && c.colSpan > 1 ? c.colSpan : undefined,
                        rowSpan: c.rowSpan && c.rowSpan > 1 ? c.rowSpan : undefined,
                        borders: {
                          top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
                          bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
                          left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
                          right: { style: BorderStyle.SINGLE, size: 4, color: '000000' }
                        },
                        children: content.length ? (content.some((x) => x instanceof Paragraph) ? content : [new Paragraph(''), ...content]) : [new Paragraph('')]
                      })
                    })
                  })
              )
          })
    )
  const doc = new Document({
    styles: { default: { document: { run: { font: '맑은 고딕', size: 20 } } } },
    sections: [{ children: conv(blocks) }]
  })
  return Packer.toBuffer(doc)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function toHtml(blocks: Block[], title = ''): string {
  const run = (r: Run) => {
    const css = [r.bold && 'font-weight:700', r.italic && 'font-style:italic', r.underline && 'text-decoration:underline', r.size && `font-size:${r.size}pt`, r.color && `color:${r.color}`, r.font && `font-family:'${esc(r.font)}',Pretendard,sans-serif`]
      .filter(Boolean)
      .join(';')
    const t = esc(r.text).replace(/\t/g, '&emsp;').replace(/\n/g, '<br>')
    return css ? `<span style="${css}">${t}</span>` : t
  }
  const conv = (bs: Block[]): string =>
    bs
      .map((b) =>
        b.kind === 'p'
          ? `<p style="text-align:${b.align ?? 'left'}">${b.runs.map(run).join('') || '&nbsp;'}</p>`
          : `<table>${b.rows.map((r) => `<tr>${r.map((c) => `<td${c.colSpan && c.colSpan > 1 ? ` colspan="${c.colSpan}"` : ''}${c.rowSpan && c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : ''}>${conv(c.blocks)}</td>`).join('')}</tr>`).join('')}</table>`
      )
      .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page{size:A4;margin:20mm 20mm 18mm}
body{font-family:'Malgun Gothic','Apple SD Gothic Neo',Pretendard,sans-serif;font-size:10pt;line-height:1.6;color:#000}
p{margin:0 0 2pt}table{border-collapse:collapse;width:100%;margin:4pt 0}td{border:0.5pt solid #000;padding:3pt 5pt;vertical-align:middle}
</style></head><body>${conv(blocks)}</body></html>`
}

// ---------- HWPX writer (experimental) ----------
export async function toHwpx(blocks: Block[]): Promise<Buffer> {
  // Collect distinct char/para styles
  const charKeys: string[] = []
  const charDefs: Run[] = []
  const charId = (r: Run) => {
    const k = JSON.stringify([!!r.bold, !!r.italic, !!r.underline, r.size ?? 10, r.color ?? '#000000'])
    let i = charKeys.indexOf(k)
    if (i < 0) {
      i = charKeys.length
      charKeys.push(k)
      charDefs.push(r)
    }
    return i
  }
  charId({ text: '' }) // id 0 = default
  const ALIGNS: Align[] = ['justify', 'left', 'center', 'right']
  const paraId = (a?: Align) => Math.max(0, ALIGNS.indexOf(a ?? 'justify'))
  let pid = 0
  let tblId = 1000

  const runXml = (r: Run) => {
    const parts = r.text.split('\n')
    const inner = parts.map((s, i) => (i ? '<hp:lineBreak/>' : '') + esc(s).replace(/\t/g, '<hp:tab/>')).join('')
    return `<hp:run charPrIDRef="${charId(r)}"><hp:t>${inner}</hp:t></hp:run>`
  }
  const CONTENT_W = 42520 // A4 minus margins, HWPUNIT (1/7200 in)
  const paraXml = (b: Para, first = false): string =>
    `<hp:p id="${pid++}" paraPrIDRef="${paraId(b.align)}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${first ? SEC_PR : ''}${b.runs.map(runXml).join('') || '<hp:run charPrIDRef="0"/>'}</hp:p>`
  const tableXml = (t: Tbl, width = CONTENT_W): string => {
    const rows = t.rows.filter((r) => r.length)
    const cols = Math.max(1, ...rows.map((r) => r.reduce((n, c) => n + (c.colSpan ?? 1), 0)))
    const cw = Math.floor(width / cols)
    const rh = 2000
    let rowAddr = 0
    const trs = rows
      .map((r) => {
        let colAddr = 0
        const tcs = r
          .map((c) => {
            const span = c.colSpan ?? 1
            const inner = c.blocks.length ? blocksXml(c.blocks, cw * span) : `<hp:p id="${pid++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>`
            const x = `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="2"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList><hp:cellAddr colAddr="${colAddr}" rowAddr="${rowAddr}"/><hp:cellSpan colSpan="${span}" rowSpan="${c.rowSpan ?? 1}"/><hp:cellSz width="${cw * span}" height="${rh}"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`
            colAddr += span
            return x
          })
          .join('')
        rowAddr++
        return `<hp:tr>${tcs}</hp:tr>`
      })
      .join('')
    return `<hp:p id="${pid++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${tblId++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="2" noAdjust="0"><hp:sz width="${cw * cols}" widthRelTo="ABSOLUTE" height="${rh * rows.length}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>${trs}</hp:tbl></hp:run></hp:p>`
  }
  const blocksXml = (bs: Block[], width = CONTENT_W): string => bs.map((b) => (b.kind === 'p' ? paraXml(b) : tableXml(b, width))).join('')

  const first: Para = blocks[0]?.kind === 'p' ? (blocks[0] as Para) : { kind: 'p', runs: [] }
  const rest = blocks[0]?.kind === 'p' ? blocks.slice(1) : blocks
  const body = paraXml(first, true) + blocksXml(rest)

  const NS = `xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"`
  const section = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${NS}>${body}</hs:sec>`

  const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']
  const langAttrs = (v: string) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`
  const fontfaces = LANGS.map((l) => `<hh:fontface lang="${l}" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="TTF" isEmbedded="0"/></hh:fontface>`).join('')
  const borderLine = (side: string, type: string) => `<hh:${side} type="${type}" width="0.12 mm" color="#000000"/>`
  const borderFill = (id: number, type: string) =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${borderLine('leftBorder', type)}${borderLine('rightBorder', type)}${borderLine('topBorder', type)}${borderLine('bottomBorder', type)}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>`
  const charPrs = charDefs
    .map(
      (r, i) =>
        `<hh:charPr id="${i}" height="${Math.round((r.size ?? 10) * 100)}" textColor="${r.color ?? '#000000'}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"><hh:fontRef ${langAttrs('0')}/><hh:ratio ${langAttrs('100')}/><hh:spacing ${langAttrs('0')}/><hh:relSz ${langAttrs('100')}/><hh:offset ${langAttrs('0')}/>${r.bold ? '<hh:bold/>' : ''}${r.italic ? '<hh:italic/>' : ''}<hh:underline type="${r.underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>`
    )
    .join('')
  const paraPrs = ALIGNS.map(
    (a, i) =>
      `<hh:paraPr id="${i}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${a.toUpperCase()}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`
  ).join('')
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${NS} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="7">${fontfaces}</hh:fontfaces><hh:borderFills itemCnt="2">${borderFill(1, 'NONE')}${borderFill(2, 'SOLID')}</hh:borderFills><hh:charProperties itemCnt="${charDefs.length}">${charPrs}</hh:charProperties><hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties><hh:paraProperties itemCnt="${ALIGNS.length}">${paraPrs}</hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`

  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' })
  zip.file('version.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="12, 0, 0, 0"/>`)
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`)
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`)
  zip.file('Contents/content.hpf', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title/><opf:language>ko</opf:language><opf:meta name="creator" content="text">Super Conversions</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`)
  zip.file('settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`)
  zip.file('Contents/header.xml', header)
  zip.file('Contents/section0.xml', section)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/hwp+zip' })
}

const SEC_PR = `<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`
