// `Super Conversions --sc-selftest <dir>` — builds sample files and runs every action headlessly.
// Used in CI and for support diagnostics.
import { promises as fs } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { PDFDocument, StandardFonts, rgb, degrees } from '@cantoo/pdf-lib'
import { ffmpegPath, run, findSoffice } from './tools'
import { startJob, listJobs, startEditJob } from './jobs'
import type { ActionId } from '@shared/formats'
import type { ActionOptions, Job } from '@shared/types'
import { toDocx, toHwpx } from './engines/docmodel'
import { saveSettings, addSignature } from './settings'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(job: Job): Promise<Job> {
  for (;;) {
    const j = listJobs().find((x) => x.id === job.id)!
    if (j.status !== 'running' && j.status !== 'queued') return j
    await wait(150)
  }
}

export async function runSelfTest(dir: string): Promise<boolean> {
  await fs.mkdir(dir, { recursive: true })
  const P = (n: string) => join(dir, n)
  // ---------- fixtures
  await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#2f5bff' } })
    .composite([{ input: Buffer.from('<svg width="2400" height="1600"><rect x="200" y="200" width="800" height="800" fill="#c6f432"/><text x="1200" y="900" font-size="200" fill="#fff">가나다 SUPER</text></svg>'), left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .toFile(P('photo.jpg'))
  await sharp(P('photo.jpg')).webp().toFile(P('web.webp'))
  await sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 255, g: 90, b: 31, alpha: 0.5 } } }).png().toFile(P('alpha.png'))
  // signature
  const sigPng = await sharp(Buffer.from('<svg width="400" height="160"><rect width="400" height="160" fill="#fff"/><path d="M20 120 C 80 20, 140 160, 200 60 S 320 140, 380 40" stroke="#111" stroke-width="8" fill="none"/></svg>')).png().toBuffer()
  await saveSettings({ signatures: [], defaultSignatureId: undefined })
  await addSignature('테스트 서명', 'signature', sigPng, true)

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const img = await pdf.embedJpg(await fs.readFile(P('photo.jpg')))
  for (let i = 0; i < 4; i++) {
    const pg = pdf.addPage([595, 842])
    pg.drawText(`Page ${i + 1}`, { x: 60, y: 760, size: 32, font, color: rgb(0.1, 0.1, 0.1) })
    pg.drawImage(img, { x: 60, y: 300, width: 480, height: 320 })
  }
  pdf.getPage(2).setRotation(degrees(90))
  await fs.writeFile(P('doc.pdf'), await pdf.save())
  await fs.copyFile(P('doc.pdf'), P('doc2.pdf'))

  const blocks = [
    { kind: 'p' as const, runs: [{ text: '슈퍼 컨버젼스 테스트 문서', bold: true, size: 20 }], align: 'center' as const },
    { kind: 'p' as const, runs: [{ text: '본문 ' }, { text: '굵게', bold: true }, { text: ' 기울임', italic: true }, { text: ' 파랑', color: '#2F5BFF' }] },
    { kind: 'table' as const, rows: [[{ blocks: [{ kind: 'p' as const, runs: [{ text: '항목' }] }] }, { blocks: [{ kind: 'p' as const, runs: [{ text: '값' }] }] }], [{ blocks: [{ kind: 'p' as const, runs: [{ text: 'A' }] }] }, { blocks: [{ kind: 'p' as const, runs: [{ text: '100' }] }] }]] }
  ]
  await fs.writeFile(P('report.docx'), await toDocx(blocks))
  await fs.writeFile(P('report.hwpx'), await toHwpx(blocks))
  await fs.writeFile(P('table.csv'), 'name,qty,price\n사과,3,1200\n배,5,2500\n' + Array.from({ length: 60 }, (_, i) => `item${i},${i},${i * 100}`).join('\n'))

  const ff = ffmpegPath()
  if (ff) {
    await run(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', P('clip.mov')])
  }
  const soffice = findSoffice()
  if (soffice) {
    // make a pptx + xlsx fixture via LibreOffice
    await run(soffice, ['--headless', '--convert-to', 'xlsx', '--outdir', dir, P('table.csv')], { timeoutMs: 120000 })
    await run(soffice, ['--headless', '--convert-to', 'pptx', '--outdir', dir, P('doc.pdf')], { timeoutMs: 120000 }).catch(() => undefined)
  }

  // ---------- cases
  const cases: [ActionId, string[], ActionOptions?][] = [
    ['img.jpg', ['web.webp', 'alpha.png']],
    ['img.png', ['photo.jpg']],
    ['img.webp', ['photo.jpg']],
    ['img.avif', ['photo.jpg']],
    ['img.resize', ['photo.jpg'], { resize: 'long', size: 800, targetKB: 40 }],
    ['img.pdf', ['photo.jpg', 'alpha.png'], { mode: 'merge' }],
    ['img.sign', ['photo.jpg']],
    ['pdf.jpg', ['doc.pdf'], { dpi: 72, pages: '1-2' }],
    ['pdf.png', ['doc.pdf'], { dpi: 72, pages: '3' }],
    ['pdf.compress', ['doc.pdf'], { level: 'high' }],
    ['pdf.merge', ['doc.pdf', 'doc2.pdf']],
    ['pdf.split', ['doc.pdf'], { splitMode: 'every', every: 2 }],
    ['pdf.encrypt', ['doc.pdf'], { userPassword: '1234' }],
    ['pdf.sign', ['doc.pdf'], { stampPages: 'all' }],
    ['doc.pdf', ['report.docx']],
    ['doc.jpg', ['report.docx'], { dpi: 72 }],
    ['doc.hwp', ['report.docx'], { hwpTarget: 'hwpx' }],
    ['hwp.docx', ['report.hwpx']],
    ['hwp.pdf', ['report.hwpx']],
    ['sheet.pdf', ['table.xlsx'], { sheetFit: 'onepage' }],
    ['sheet.xlsx', ['table.csv']],
    ['slide.pdf', ['doc.pptx']],
    ['vid.mp4', ['clip.mov']],
    ['vid.gif', ['clip.mov'], { start: '1', end: '2', gifWidth: 320 }],
    ['vid.audio', ['clip.mov']],
    ['vid.compress', ['clip.mov'], { targetMB: 1, hwaccel: false }],
    ['vid.trim', ['clip.mov'], { start: '1', end: '3', trimCopy: false, hwaccel: false }],
    ['vid.webm', ['clip.mov']]
  ]
  const results: Record<string, unknown>[] = []
  let ok = true
  for (const [action, inputs, opts] of cases) {
    const files = inputs.map(P)
    try {
      await Promise.all(files.map((f) => fs.access(f)))
    } catch {
      results.push({ action, status: 'skipped (fixture missing)' })
      continue
    }
    const t0 = Date.now()
    const j = await until(await startJob(action, files, opts))
    const pass = j.files.every((f) => f.status === 'done' && f.outputs.length > 0)
    if (!pass) ok = false
    results.push({ action, status: pass ? 'PASS' : 'FAIL', ms: Date.now() - t0, files: j.files.map((f) => ({ out: f.outputs.map((o) => o.replace(dir, '.')), msg: f.message, report: f.report })) })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${action}  ${Date.now() - t0}ms  ${j.files.map((f) => f.message ?? '').join(' | ')}`)
  }
  // editor apply
  const ej = await startEditJob({
    sources: [P('doc.pdf')],
    pages: [
      { src: 0, index: 2, rotate: 90 },
      { src: 0, index: 0, rotate: 0 },
      { src: 0, index: -1, rotate: 0, width: 595, height: 842 }
    ],
    annotations: [
      { id: 'a', type: 'text', page: 1, x: 60, y: 100, w: 300, h: 30, text: '한글 텍스트 주석', fontSize: 18, color: '#E5383B' },
      { id: 'b', type: 'rect', page: 0, x: 40, y: 40, w: 200, h: 100, color: '#2F5BFF', strokeWidth: 3 },
      { id: 'c', type: 'highlight', page: 1, x: 60, y: 60, w: 200, h: 30 },
      { id: 'd', type: 'arrow', page: 1, x: 0, y: 0, w: 0, h: 0, points: [100, 300, 300, 400], color: '#FF5A1F' },
      { id: 'e', type: 'signature', page: 2, x: 380, y: 720, w: 160, h: 64, image: sigPng.toString('base64') }
    ]
  })
  const ejd = await until(ej)
  console.log(`${ejd.status === 'done' ? 'PASS' : 'FAIL'}  pdf.edit  ${ejd.files[0].message}`)
  if (ejd.status !== 'done') ok = false
  results.push({ action: 'pdf.edit', status: ejd.status, files: ejd.files })
  await fs.writeFile(P('selftest-report.json'), JSON.stringify(results, null, 2))
  return ok
}
