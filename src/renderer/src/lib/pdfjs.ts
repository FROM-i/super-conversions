import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const base = new URL('./', location.href).href
export function openPdf(bytes: Uint8Array) {
  // pdf.js transfers the buffer to its worker — always hand it a copy
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/'
  }).promise
}
export type PdfDoc = Awaited<ReturnType<typeof openPdf>>
export { pdfjs }
