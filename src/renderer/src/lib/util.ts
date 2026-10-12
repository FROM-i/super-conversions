import { CATEGORY_META, categoryOf, extOf, type Category } from '@shared/formats'

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p
export const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
export const toneOf = (cat: Category | null | undefined) => (cat ? `tone-${CATEGORY_META[cat].tone}` : 'tone-doc')
export const toneOfPath = (p: string) => toneOf(categoryOf(p))
export { extOf, categoryOf }

export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || isNaN(n)) return '–'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export const uid = () => Math.random().toString(36).slice(2, 10)

export function cls(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ')
}
