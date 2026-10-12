import { promises as fs, existsSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { planRename, type RenameItem, type RenameRule, type RenamePlanRow } from '@shared/rename'

export interface RenameResult {
  ok: boolean
  renamed: { from: string; to: string }[]
  errors: { from: string; error: string }[]
}

let lastBatch: { from: string; to: string }[] = []

/** Two-phase rename (→ temp → final) so swaps like a↔b and case-only changes are safe. */
async function applyPairs(pairs: { from: string; to: string }[]): Promise<RenameResult> {
  const staged: { from: string; tmp: string; to: string }[] = []
  const errors: RenameResult['errors'] = []
  for (const p of pairs) {
    if (p.from === p.to) continue
    const tmp = join(dirname(p.from), `.sc-rename-${randomUUID()}`)
    try {
      await fs.rename(p.from, tmp)
      staged.push({ ...p, tmp })
    } catch (e) {
      errors.push({ from: p.from, error: (e as Error).message })
    }
  }
  const renamed: RenameResult['renamed'] = []
  for (const s of staged) {
    try {
      if (existsSync(s.to) && s.to.toLowerCase() !== s.from.toLowerCase()) throw new Error('같은 이름의 파일이 이미 있습니다')
      await fs.rename(s.tmp, s.to)
      renamed.push({ from: s.from, to: s.to })
    } catch (e) {
      await fs.rename(s.tmp, s.from).catch(() => undefined) // roll this one back
      errors.push({ from: s.from, error: (e as Error).message })
    }
  }
  return { ok: errors.length === 0, renamed, errors }
}

export async function renameFiles(items: RenameItem[], rule: RenameRule): Promise<RenameResult & { plan: RenamePlanRow[] }> {
  const plan = planRename(items, rule, (p) => existsSync(p))
  const bad = plan.filter((r) => r.error)
  if (bad.length) return { ok: false, renamed: [], errors: bad.map((r) => ({ from: r.from, error: r.error! })), plan }
  const res = await applyPairs(plan.map((r) => ({ from: r.from, to: r.to })))
  if (res.renamed.length) lastBatch = res.renamed
  return { ...res, plan }
}

export async function renameOne(from: string, newName: string): Promise<RenameResult> {
  const to = join(dirname(from), newName)
  if (to !== from && existsSync(to) && to.toLowerCase() !== from.toLowerCase()) return { ok: false, renamed: [], errors: [{ from, error: '같은 이름의 파일이 이미 있습니다' }] }
  const res = await applyPairs([{ from, to }])
  if (res.renamed.length) lastBatch = res.renamed
  return res
}

export async function undoLastRename(): Promise<RenameResult> {
  if (!lastBatch.length) return { ok: false, renamed: [], errors: [{ from: '', error: '되돌릴 이름 변경이 없습니다' }] }
  const res = await applyPairs(lastBatch.map((r) => ({ from: r.to, to: r.from })))
  lastBatch = []
  return res
}
