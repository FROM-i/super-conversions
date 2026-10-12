import { app, safeStorage } from 'electron'
import { promises as fs, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import sharp from 'sharp'
import type { Settings, SignatureMeta } from '@shared/types'
import { FONT_ALIASES } from '@shared/defaults'

const dir = () => app.getPath('userData')
const file = () => join(dir(), 'settings.json')
const sigDir = () => join(dir(), 'signatures')

export const defaultSettings = (): Settings => ({
  outputFolderName: 'SUPER CONVERSIONS',
  downloadDir: app.getPath('downloads'),
  officeEngine: 'auto',
  sofficePath: '',
  preflightFonts: true,
  fontAliases: { ...FONT_ALIASES },
  presets: {},
  cookiesBrowser: 'none',
  downloadFormat: 'best',
  autoUpdateDownloader: true,
  autoUpdateApp: true,
  theme: 'system',
  signatures: [],
  shellIntegration: false,
  overlayRunsImmediately: true,
  concurrency: 2,
  libraryEnabled: true,
  libraryDir: '',
  libraryCollectMode: 'move',
  libraryClipboard: false,
  libraryExtraFolders: [],
  launchAtLogin: false,
  closeToTray: true
})

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  let s = defaultSettings()
  try {
    if (existsSync(file())) s = { ...s, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    /* corrupt → defaults */
  }
  cache = s
  return s
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...getSettings(), ...patch }
  cache = next
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

// ---------- Signatures (encrypted at rest via OS keychain / DPAPI) ----------

function seal(buf: Buffer): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(buf.toString('base64'))
  return Buffer.concat([Buffer.from('PLAIN:'), buf])
}
function unseal(buf: Buffer): Buffer {
  if (buf.subarray(0, 6).toString() === 'PLAIN:') return buf.subarray(6)
  return Buffer.from(safeStorage.decryptString(buf), 'base64')
}

/** Normalise an incoming signature image: trim, optional white→transparent, PNG. */
export async function prepareSignaturePng(input: Buffer, removeBg: boolean): Promise<Buffer> {
  let img = sharp(input).rotate().ensureAlpha()
  if (removeBg) {
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      // soft knockout: near-white → transparent, ramp between 200..240
      if (lum >= 240) data[i + 3] = 0
      else if (lum > 200) data[i + 3] = Math.round(data[i + 3] * ((240 - lum) / 40))
    }
    img = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  }
  const png = await img.png().toBuffer()
  // trim transparent border (with a little padding)
  try {
    const trimmed = await sharp(png).trim({ threshold: 1 }).png().toBuffer()
    return await sharp(trimmed).extend({ top: 8, bottom: 8, left: 8, right: 8, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  } catch {
    return png
  }
}

export async function addSignature(name: string, kind: SignatureMeta['kind'], png: Buffer, removeBg: boolean): Promise<Settings> {
  const clean = await prepareSignaturePng(png, removeBg)
  const meta = await sharp(clean).metadata()
  const id = randomUUID()
  await fs.mkdir(sigDir(), { recursive: true })
  await fs.writeFile(join(sigDir(), `${id}.bin`), seal(clean))
  const s = getSettings()
  const sig: SignatureMeta = { id, name, kind, createdAt: Date.now(), width: meta.width ?? 0, height: meta.height ?? 0 }
  return saveSettings({
    signatures: [...s.signatures, sig],
    defaultSignatureId: s.defaultSignatureId ?? id
  })
}

export async function removeSignature(id: string): Promise<Settings> {
  await fs.rm(join(sigDir(), `${id}.bin`), { force: true })
  const s = getSettings()
  const signatures = s.signatures.filter((x) => x.id !== id)
  return saveSettings({
    signatures,
    defaultSignatureId: s.defaultSignatureId === id ? signatures[0]?.id : s.defaultSignatureId
  })
}

export async function getSignaturePng(id?: string): Promise<Buffer> {
  const s = getSettings()
  const sid = id || s.defaultSignatureId
  if (!sid) throw new Error('저장된 서명이 없습니다. 설정 › 서명·직인에서 먼저 등록해 주세요.')
  const raw = await fs.readFile(join(sigDir(), `${sid}.bin`))
  return unseal(raw)
}
