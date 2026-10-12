// Pure rename planner shared by main (validation) and renderer (live preview).

export type RenameMode = 'pattern' | 'replace' | 'affix'

export interface RenameRule {
  mode: RenameMode
  // pattern mode: tokens {name} {n} {date} {time} {ext}
  pattern: string
  start: number
  pad: number // digits for {n}: 1 → 1,2,3 · 2 → 01,02 · 3 → 001
  step: number
  // replace mode
  find: string
  replace: string
  caseSensitive: boolean
  // affix mode
  prefix: string
  suffix: string
  // all modes
  order: 'current' | 'name' | 'date'
}

export const DEFAULT_RULE: RenameRule = {
  mode: 'pattern',
  pattern: '{name}_{n}',
  start: 1,
  pad: 2,
  step: 1,
  find: '',
  replace: '',
  caseSensitive: false,
  prefix: '',
  suffix: '',
  order: 'current'
}

export interface RenameItem {
  path: string
  mtime?: number
}

export interface RenamePlanRow {
  from: string
  to: string
  newName: string
  error?: string
}

const sep = (p: string) => (p.includes('\\') ? '\\' : '/')
const splitPath = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return { dir: p.slice(0, i), file: p.slice(i + 1) }
}
const splitExt = (f: string) => {
  const i = f.lastIndexOf('.')
  return i > 0 ? { stem: f.slice(0, i), ext: f.slice(i) } : { stem: f, ext: '' }
}
const two = (n: number) => String(n).padStart(2, '0')
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function sanitizeName(s: string): string {
  return s.replace(ILLEGAL, '_').replace(/[. ]+$/, '').trim()
}

export function planRename(items: RenameItem[], rule: RenameRule, existing?: (path: string) => boolean): RenamePlanRow[] {
  const ordered = [...items]
  if (rule.order === 'name') ordered.sort((a, b) => splitPath(a.path).file.localeCompare(splitPath(b.path).file, 'ko', { numeric: true }))
  if (rule.order === 'date') ordered.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0))

  const rows: RenamePlanRow[] = ordered.map((it, i) => {
    const { dir, file } = splitPath(it.path)
    const { stem, ext } = splitExt(file)
    let next = stem
    if (rule.mode === 'pattern') {
      const n = rule.start + i * (rule.step || 1)
      const d = new Date(it.mtime ?? Date.now())
      next = (rule.pattern || '{name}')
        .replace(/\{name\}/g, stem)
        .replace(/\{n\}/g, String(n).padStart(Math.max(1, rule.pad), '0'))
        .replace(/\{date\}/g, `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`)
        .replace(/\{time\}/g, `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`)
        .replace(/\{ext\}/g, ext.replace('.', ''))
    } else if (rule.mode === 'replace') {
      if (rule.find) {
        const esc = rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        next = stem.replace(new RegExp(esc, rule.caseSensitive ? 'g' : 'gi'), rule.replace)
      }
    } else {
      next = `${rule.prefix}${stem}${rule.suffix}`
    }
    const clean = sanitizeName(next)
    const newName = clean + ext
    return { from: it.path, to: dir + sep(it.path) + newName, newName }
  })

  // validation: empty, reserved, duplicates within the batch, collisions with untouched files
  const fromSet = new Set(rows.map((r) => r.from.toLowerCase()))
  const seen = new Map<string, number>()
  for (const r of rows) {
    const key = r.to.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const r of rows) {
    const stem = splitExt(r.newName).stem
    if (!stem) r.error = '이름이 비어 있습니다'
    else if (RESERVED.test(stem)) r.error = '사용할 수 없는 이름입니다'
    else if ((seen.get(r.to.toLowerCase()) ?? 0) > 1) r.error = '같은 이름이 겹칩니다'
    else if (r.to.toLowerCase() !== r.from.toLowerCase() && existing?.(r.to) && !fromSet.has(r.to.toLowerCase())) r.error = '같은 이름의 파일이 이미 있습니다'
  }
  return rows
}
