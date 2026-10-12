// Runs inside a hidden window: rasterises PDFs (pdf.js) and lays out HWP files (hwp.js) for printing.
import { sc } from './lib/api'
import { openPdf } from './lib/pdfjs'

async function rasterize(req: { bytes: Uint8Array; pages: number[] | 'all'; scale: number; format: 'png' | 'jpeg'; quality: number }) {
  const doc = await openPdf(req.bytes)
  const idx = req.pages === 'all' ? [...Array(doc.numPages).keys()] : req.pages
  const out: { page: number; data: Uint8Array }[] = []
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  for (const i of idx) {
    const page = await doc.getPage(i + 1)
    // cap at ~40 MP to stay within canvas limits
    let scale = req.scale
    const vp0 = page.getViewport({ scale: 1 })
    const maxScale = Math.sqrt(40_000_000 / (vp0.width * vp0.height))
    scale = Math.min(scale, maxScale)
    const vp = page.getViewport({ scale })
    canvas.width = Math.floor(vp.width)
    canvas.height = Math.floor(vp.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise
    const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), `image/${req.format}`, req.quality))
    out.push({ page: i, data: new Uint8Array(await blob.arrayBuffer()) })
    page.cleanup()
  }
  await doc.destroy()
  return out
}

async function mountHwp(bytes: Uint8Array) {
  const { Viewer } = await import('hwp.js')
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  new Viewer(host, bytes, { type: 'array' } as never)
  // keep only the pages, strip viewer chrome, set the paper size from the first page
  const pages = [...host.querySelectorAll<HTMLElement>('div[data-page-number]')].filter((p) => !p.classList.contains('hwpjs-observer'))
  const first = pages[0]
  const w = first?.style.width || '8.27in'
  const h = first?.style.height || '11.69in'
  const style = document.createElement('style')
  style.textContent = `@page{size:${w} ${h};margin:0}html,body{margin:0;background:#fff}
    .hwpjs-page{box-sizing:border-box!important;box-shadow:none!important;margin:0!important;overflow:hidden;break-after:page}`
  document.head.appendChild(style)
  const wrap = document.createElement('div')
  for (const p of pages) {
    p.classList.add('hwpjs-page')
    p.querySelector('.hwpjs-observer')?.remove()
    wrap.appendChild(p)
  }
  document.body.innerHTML = ''
  document.body.appendChild(wrap)
  document.body.classList.remove('overlay-body')
  await document.fonts.ready
  return { pages: pages.length }
}

export function startRenderWorker() {
  document.body.style.background = '#fff'
  sc.onRenderRequest(async (id, req) => {
    try {
      let result: unknown
      if (req.kind === 'pdf-raster') result = await rasterize(req as never)
      else if (req.kind === 'pdf-count') {
        const d = await openPdf(req.bytes as Uint8Array)
        result = d.numPages
        await d.destroy()
      } else if (req.kind === 'hwp-mount') result = await mountHwp(req.bytes as Uint8Array)
      else throw new Error('unknown render request')
      sc.renderReply(id, true, result)
    } catch (e) {
      sc.renderReply(id, false, (e as Error).message)
    }
  })
  sc.renderReady()
}
