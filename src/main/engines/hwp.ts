import { promises as fs } from 'fs'
import { join } from 'path'
import { isWin, tmpDir } from '../tools'
import { extOf } from '@shared/formats'
import type { ActionOptions } from '@shared/types'
import { detectOffice, officeWorker, officeConvert } from './office'
import { fromDocx, fromHwp5, fromHwpx, toDocx, toHtml, toHwpx } from './docmodel'
import { hwpToPdf, htmlToPdf } from '../render'

export interface HwpResult {
  engine: string
  fidelity: 'high' | 'medium' | 'low'
  notes?: string[]
}

async function hancom(): Promise<boolean> {
  if (!isWin || !officeWorker) return false
  return (await detectOffice()).hancom
}

async function hancomSave(src: string, dst: string, format: 'PDF' | 'HWP' | 'HWPX' | 'OOXML') {
  await officeWorker!.call('hwp', { src, dst, format })
}

const readModel = async (src: string) => {
  const buf = await fs.readFile(src)
  return extOf(src) === 'hwpx' ? fromHwpx(buf) : fromHwp5(buf)
}

/** HWP/HWPX → PDF */
export async function hwpToPdfFile(src: string, dst: string, o: ActionOptions): Promise<HwpResult> {
  if (o.engine !== 'builtin' && (await hancom())) {
    await hancomSave(src, dst, 'PDF')
    return { engine: '한컴오피스', fidelity: 'high' }
  }
  if (extOf(src) === 'hwp') {
    try {
      const pdf = await hwpToPdf(new Uint8Array(await fs.readFile(src)))
      await fs.writeFile(dst, pdf)
      return { engine: '내장 HWP 렌더러 (베타)', fidelity: 'low', notes: ['한컴오피스가 없어 내장 렌더러로 변환했습니다. 복잡한 표·도형·이미지는 다를 수 있습니다.'] }
    } catch {
      /* fall back to text model */
    }
  }
  const blocks = await readModel(src)
  await fs.writeFile(dst, await htmlToPdf(toHtml(blocks)))
  return { engine: '내장 변환기 (베타)', fidelity: 'low', notes: ['텍스트·표 중심으로 재구성했습니다. 원본 레이아웃과 다를 수 있습니다.'] }
}

/** HWP/HWPX → DOCX */
export async function hwpToDocxFile(src: string, dst: string, o: ActionOptions): Promise<HwpResult> {
  if (o.engine !== 'builtin' && (await hancom())) {
    await hancomSave(src, dst, 'OOXML')
    return { engine: '한컴오피스', fidelity: 'high', notes: ['HWP → DOCX는 한컴으로도 표·글상자가 일부 어긋날 수 있습니다.'] }
  }
  await fs.writeFile(dst, await toDocx(await readModel(src)))
  return { engine: '내장 변환기 (베타)', fidelity: 'low', notes: ['텍스트·글자 서식·표만 옮깁니다.'] }
}

/** HWP ↔ HWPX */
export async function hwpSwapFile(src: string, dst: string, o: ActionOptions): Promise<HwpResult> {
  const toX = extOf(src) === 'hwp'
  if (o.engine !== 'builtin' && (await hancom())) {
    await hancomSave(src, dst, toX ? 'HWPX' : 'HWP')
    return { engine: '한컴오피스', fidelity: 'high' }
  }
  if (!toX) throw new Error('HWPX → HWP(구형 바이너리)는 한컴오피스가 설치된 Windows에서만 가능합니다.')
  await fs.writeFile(dst, await toHwpx(await fromHwp5(await fs.readFile(src))))
  return { engine: '내장 HWPX 작성기 (실험)', fidelity: 'low', notes: ['텍스트·표 위주로 HWPX를 새로 작성했습니다.'] }
}

/** Word/ODT/RTF → HWP or HWPX */
export async function docToHwpFile(src: string, dst: string, target: 'hwp' | 'hwpx', o: ActionOptions): Promise<HwpResult> {
  if (o.engine !== 'builtin' && (await hancom())) {
    await hancomSave(src, dst, target === 'hwp' ? 'HWP' : 'HWPX')
    return { engine: '한컴오피스', fidelity: 'high' }
  }
  if (target === 'hwp') throw new Error('HWP(구형 바이너리) 저장은 한컴오피스가 필요합니다. 옵션에서 HWPX를 선택하면 한컴 없이도 만들 수 있습니다.')
  let docx = src
  let tmp: string | null = null
  if (extOf(src) !== 'docx') {
    tmp = await tmpDir('sc-doc-')
    docx = join(tmp, 'src.docx')
    await officeConvert(src, docx, 'docx', o)
  }
  try {
    const blocks = await fromDocx(await fs.readFile(docx))
    await fs.writeFile(dst, await toHwpx(blocks))
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
  return { engine: '내장 HWPX 작성기 (실험)', fidelity: 'low', notes: ['한컴오피스 없이 HWPX로 새로 작성했습니다. 텍스트·글자 서식·표가 옮겨지며 이미지·도형은 제외됩니다.'] }
}
