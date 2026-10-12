import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ACTIONS, CATEGORY_META, OUTER_SLOTS, SLOT_NUMPAD, actionsFor, categoryOf, extOf, type ActionDef, type ActionId, type Category } from '@shared/formats'
import { cls, toneOf } from '../lib/util'

export interface GridPick {
  action: ActionId
  files: string[]
  immediate: boolean
}

interface Props {
  files: string[]
  at?: { x: number; y: number } // viewport point to centre on; omitted = static (overlay)
  cell?: number
  onPick: (p: GridPick) => void
  onClose: () => void
  center?: ReactNode // override centre tile (overlay progress)
  locked?: boolean
}

type Cell =
  | { kind: 'action'; def: ActionDef; disabled?: boolean }
  | { kind: 'cat'; cat: Category; count: number }
  | { kind: 'empty' }

const KEY_TO_SLOT: Record<string, number> = {}
SLOT_NUMPAD.forEach((k, i) => (KEY_TO_SLOT[k] = i))

export function availableActions(files: string[]): ActionDef[] {
  const cats = [...new Set(files.map(categoryOf).filter(Boolean))] as Category[]
  if (cats.length !== 1) return []
  return actionsFor(cats[0])
}

export default function GridMenu({ files, at, cell = 116, onPick, onClose, center, locked }: Props) {
  const [narrow, setNarrow] = useState<Category | null>(null)
  const [focus, setFocus] = useState<number>(-1)

  const groups = useMemo(() => {
    const m = new Map<Category, string[]>()
    for (const f of files) {
      const c = categoryOf(f)
      if (!c) continue
      m.set(c, [...(m.get(c) ?? []), f])
    }
    return m
  }, [files])

  const activeCat: Category | null = narrow ?? (groups.size === 1 ? [...groups.keys()][0] : null)
  const scope = activeCat ? groups.get(activeCat) ?? [] : files

  const cells: Cell[] = useMemo(() => {
    const out: Cell[] = Array(9).fill({ kind: 'empty' })
    if (activeCat) {
      const acts = actionsFor(activeCat)
      acts.slice(0, 8).forEach((def, i) => {
        const disabled = (def.singleOnly && scope.length !== 1) || (def.multiToOne && scope.length < 2)
        out[OUTER_SLOTS[i]] = { kind: 'action', def, disabled }
      })
    } else {
      ;[...groups.entries()].slice(0, 8).forEach(([cat, fs], i) => (out[OUTER_SLOTS[i]] = { kind: 'cat', cat, count: fs.length }))
    }
    return out
  }, [activeCat, groups, scope.length])

  const exts = [...new Set(scope.map(extOf))]
  const centerLabel = activeCat ? (exts.length === 1 ? exts[0].toUpperCase() : CATEGORY_META[activeCat].label) : 'MIX'

  const choose = (i: number, immediate: boolean) => {
    if (locked) return
    const c = cells[i]
    if (!c || c.kind === 'empty') return
    if (c.kind === 'cat') {
      setNarrow(c.cat)
      setFocus(-1)
      return
    }
    if (c.disabled) return
    onPick({ action: c.def.id, files: scope, immediate })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (locked && e.key !== 'Escape') return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (narrow && groups.size > 1) setNarrow(null)
        else onClose()
        return
      }
      if (e.key === 'Backspace' && narrow) {
        setNarrow(null)
        return
      }
      const k = e.code.startsWith('Numpad') ? e.code.slice(6) : e.key
      if (k in KEY_TO_SLOT) {
        e.preventDefault()
        const slot = KEY_TO_SLOT[k]
        if (slot === 4) return
        choose(slot, e.shiftKey)
        return
      }
      const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
      if (moves[e.key]) {
        e.preventDefault()
        const [dr, dc] = moves[e.key]
        let cur = focus < 0 ? 4 : focus
        do {
          const r = (Math.floor(cur / 3) + dr + 3) % 3
          const c = ((cur % 3) + dc + 3) % 3
          cur = r * 3 + c
        } while (cur === 4)
        setFocus(cur)
        return
      }
      if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault()
        choose(focus, e.shiftKey)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const size = cell * 3 + 12
  const style: CSSProperties = { ['--cell' as string]: `${cell}px` }
  if (at) {
    const x = Math.min(Math.max(8, at.x - size / 2), window.innerWidth - size - 8)
    const y = Math.min(Math.max(8, at.y - size / 2), window.innerHeight - size - 8)
    Object.assign(style, { left: x, top: y })
  }

  return (
    <>
      {at && <div className="grid-backdrop" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />}
      <div className="grid-menu" style={style} key={activeCat ?? 'root'} role="menu" aria-label="변환 메뉴">
        {cells.map((c, i) => {
          const r = Math.floor(i / 3)
          const col = i % 3
          const fly = { ['--fx' as string]: `${(1 - col) * cell}px`, ['--fy' as string]: `${(1 - r) * cell}px`, ['--i' as string]: Math.abs(r - 1) + Math.abs(col - 1) } as CSSProperties
          if (i === 4) {
            return (
              <div key={i} className={cls('cell center', activeCat && toneOf(activeCat))} style={{ ...fly, ['--i' as string]: 0 }}>
                {center ?? (
                  <>
                    <span className="hint">{narrow && groups.size > 1 ? '← Esc' : '원본'}</span>
                    <span className="lab">{centerLabel}</span>
                    <span className="count">{scope.length}개 파일</span>
                  </>
                )}
              </div>
            )
          }
          if (c.kind === 'empty') return <div key={i} className="cell empty" style={fly} />
          if (c.kind === 'cat') {
            return (
              <button key={i} className={cls('cell', toneOf(c.cat), focus === i && 'focus')} style={fly} onClick={() => choose(i, false)} role="menuitem">
                <span className="bar" />
                <span className="k">{SLOT_NUMPAD[i]}</span>
                <span className="lab">{CATEGORY_META[c.cat].label}</span>
                <span className="hint">{c.count}개 →</span>
              </button>
            )
          }
          return (
            <button
              key={i}
              className={cls('cell', toneOf(c.def.category), focus === i && 'focus', c.disabled && 'disabled')}
              style={fly}
              onClick={(e) => choose(i, e.shiftKey)}
              onMouseEnter={() => setFocus(i)}
              title={c.def.singleOnly ? '파일 1개를 선택했을 때 사용할 수 있습니다' : c.def.multiToOne ? '2개 이상 선택' : undefined}
              role="menuitem"
            >
              <span className="bar" />
              <span className="k">{SLOT_NUMPAD[i]}</span>
              <span className="lab">{c.def.label}</span>
              <span className="hint">{c.def.hint}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

export { ACTIONS }
