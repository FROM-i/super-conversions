import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACTION_BY_ID, type ActionId } from '@shared/formats'
import type { ActionOptions, EngineStatus, LibraryItem, Settings } from '@shared/types'
import { sc } from '../lib/api'
import { cls, fmtBytes } from '../lib/util'
import GridMenu, { type GridPick } from '../components/GridMenu'
import OptionsPanel from '../components/OptionsPanel'
import RenameModal from '../components/RenameModal'
import { IcCheck, IcFolder } from '../lib/icons'

interface Props {
  settings: Settings
  setSettings: (s: Settings) => void
  engines: EngineStatus | null
  toast: (m: string) => void
  onOpenSettings: () => void
}

const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
const dayLabel = (t: number) => {
  const d = new Date(t)
  const today = new Date()
  const y = new Date(Date.now() - 864e5)
  if (dayKey(t) === dayKey(today.getTime())) return '오늘'
  if (dayKey(t) === dayKey(y.getTime())) return '어제'
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
}

export default function LibraryView({ settings, setSettings, engines, toast, onOpenSettings }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [dir, setDir] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const [grid, setGrid] = useState<{ x: number; y: number; files: string[] } | null>(null)
  const [panel, setPanel] = useState<{ action: ActionId; files: string[] } | null>(null)
  const [renaming, setRenaming] = useState<string[] | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [big, setBig] = useState<string | null>(null)
  const loadedThumbs = useRef(new Set<string>())

  const load = useCallback(async () => {
    const r = await sc.libraryList()
    setDir(r.dir)
    setItems(r.items)
    setSel((s) => new Set([...s].filter((p) => r.items.some((i) => i.path === p))))
  }, [])

  useEffect(() => {
    load()
    const off = sc.onLibrary(() => load())
    return () => {
      off()
    }
  }, [load])

  // lazy thumbnails (cached on disk by main)
  useEffect(() => {
    for (const it of items) {
      const key = it.path + it.mtime
      if (loadedThumbs.current.has(key)) continue
      loadedThumbs.current.add(key)
      sc.thumbCached(it.path).then((d) => setThumbs((t) => ({ ...t, [it.path]: d })))
    }
  }, [items])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? items.filter((i) => i.name.toLowerCase().includes(s)) : items
  }, [items, q])

  const groups = useMemo(() => {
    const g: { label: string; items: LibraryItem[] }[] = []
    for (const it of shown) {
      const l = dayLabel(it.ctime)
      if (!g.length || g[g.length - 1].label !== l) g.push({ label: l, items: [] })
      g[g.length - 1].items.push(it)
    }
    return g
  }, [shown])

  const selected = shown.filter((i) => sel.has(i.path)).map((i) => i.path)
  const order = shown.map((i) => i.path)

  const click = (p: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = order.indexOf(anchor)
      const b = order.indexOf(p)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSel(new Set(order.slice(lo, hi + 1)))
    } else if (e.metaKey || e.ctrlKey) {
      setSel((s) => {
        const n = new Set(s)
        n.has(p) ? n.delete(p) : n.add(p)
        return n
      })
      setAnchor(p)
    } else {
      setSel(new Set([p]))
      setAnchor(p)
    }
  }

  const ctx = (p: string, e: React.MouseEvent) => {
    e.preventDefault()
    let fs = selected
    if (!sel.has(p)) {
      setSel(new Set([p]))
      fs = [p]
    }
    setPanel(null)
    setGrid({ x: e.clientX, y: e.clientY, files: fs })
  }

  const run = async (action: ActionId, fs: string[], o?: ActionOptions, save = false) => {
    setPanel(null)
    if (save && o) setSettings(await sc.saveSettings({ presets: { ...settings.presets, [action]: o } }))
    await sc.start(action, fs, o)
    toast(`${ACTION_BY_ID[action].label} 변환을 시작했습니다 · 결과는 라이브러리 폴더의 SUPER CONVERSIONS에 저장됩니다`)
  }

  const pick = (g: GridPick) => {
    setGrid(null)
    g.immediate ? run(g.action, g.files) : setPanel({ action: g.action, files: g.files })
  }

  const trash = async (paths: string[]) => {
    if (!paths.length) return
    await sc.trash(paths)
    toast(`${paths.length}개를 휴지통으로 옮겼습니다`)
  }

  useEffect(() => {
    const k = async (e: KeyboardEvent) => {
      if (grid || panel || renaming || (e.target as HTMLElement)?.closest?.('input,textarea')) return
      const mod = e.metaKey || e.ctrlKey
      if (preview && (e.key === 'Escape' || e.key === ' ')) {
        e.preventDefault()
        setPreview(null)
        return
      }
      if (preview && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const i = order.indexOf(preview) + (e.key === 'ArrowRight' ? 1 : -1)
        if (order[i]) setPreview(order[i])
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSel(new Set(order))
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        const r = await sc.renameUndo()
        toast(r.renamed.length ? `이름 변경 ${r.renamed.length}개를 되돌렸습니다` : r.errors[0]?.error ?? '되돌릴 내용이 없습니다')
      } else if (mod && e.key.toLowerCase() === 'c' && selected[0]) {
        await sc.copyImage(selected[0])
        toast('이미지를 클립보드에 복사했습니다')
      } else if ((e.key === 'F2' || (e.key === 'Enter' && !mod)) && selected.length) {
        e.preventDefault()
        setRenaming(selected)
      } else if (e.key === ' ' && selected.length === 1) {
        e.preventDefault()
        setPreview(selected[0])
      } else if (e.key === ' ' && selected.length > 1) {
        e.preventDefault()
        setGrid({ x: innerWidth / 2, y: innerHeight / 2, files: selected })
      } else if (e.key === 'Delete' || (isMacKey(e) && e.key === 'Backspace')) {
        trash(selected)
      } else if (e.key === 'Escape') setSel(new Set())
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  useEffect(() => {
    setBig(null)
    if (preview) sc.thumbCached(preview, 2000).then(setBig)
  }, [preview])

  const enable = async () => setSettings(await sc.saveSettings({ libraryEnabled: true }))

  return (
    <div className="board">
      <div className="board-main">
        <div className="toolbar">
          <span className="title">라이브러리</span>
          <span className="muted">{items.length}개</span>
          {selected.length > 0 && <span className="chip">{selected.length}개 선택</span>}
          <span className="grow" />
          <input className="inp" style={{ width: 200, height: 30 }} placeholder="이름으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" disabled={!selected.length} onClick={() => setRenaming(selected)}>
            이름 변경 <span className="kbd">F2</span>
          </button>
          <button className="btn ghost" disabled={!selected.length} onClick={() => trash(selected)}>
            삭제
          </button>
          <button className="btn ghost" onClick={() => sc.libraryOpen()} title={dir}>
            <IcFolder /> 폴더
          </button>
          <button
            className="btn solid"
            disabled={!selected.length}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setGrid({ x: r.left - 120, y: r.bottom + 190, files: selected })
            }}
          >
            변환 그리드
          </button>
        </div>

        <div className="lib-scroll" onMouseDown={(e) => e.target === e.currentTarget && setSel(new Set())}>
          {!settings.libraryEnabled && (
            <div className="note" style={{ margin: '16px 20px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="grow">스크린샷 자동 수집이 꺼져 있습니다. 켜면 새로 찍는 스크린샷이 모두 여기로 모입니다.</span>
              <button className="btn" onClick={enable}>
                켜기
              </button>
            </div>
          )}
          {!items.length ? (
            <div className="lib-empty">
              <div className="mosaic" style={{ marginBottom: 16 }}>
                <i className="tone-doc" />
                <i className="tone-image" />
                <i className="tone-video" />
                <i className="tone-pdf" />
              </div>
              <div style={{ fontSize: 'var(--fs-l)', fontWeight: 500, marginBottom: 6 }}>아직 모인 스크린샷이 없습니다</div>
              <div className="muted" style={{ lineHeight: 1.7 }}>
                {navigator.platform.toLowerCase().includes('mac') ? '⌘ ⇧ 3 / ⌘ ⇧ 4' : 'Win ⇧ S 또는 Win PrtScn'}로 스크린샷을 찍으면 자동으로 여기에 모입니다.
                <br />
                이미지를 이 화면에 끌어다 놓아도 담깁니다.
              </div>
              <button className="btn ghost" style={{ marginTop: 14 }} onClick={onOpenSettings}>
                수집 설정 보기
              </button>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="lib-group">
                <div className="lib-day">
                  <span>{g.label}</span>
                  <span className="muted">{g.items.length}</span>
                  <button className="btn ghost" style={{ height: 22, padding: '0 6px', fontSize: 11 }} onClick={() => setSel(new Set(g.items.map((i) => i.path)))}>
                    모두 선택
                  </button>
                </div>
                <div className="tiles lib-tiles">
                  {g.items.map((it) => (
                    <div
                      key={it.path}
                      className={cls('tile tone-image', sel.has(it.path) && 'sel')}
                      onClick={(e) => click(it.path, e)}
                      onDoubleClick={() => setPreview(it.path)}
                      onContextMenu={(e) => ctx(it.path, e)}
                      draggable
                      onDragStart={(e) => {
                        e.preventDefault()
                        sc.startDrag(sel.has(it.path) ? selected : [it.path])
                      }}
                      title={it.name}
                    >
                      <div className="thumb">{thumbs[it.path] ? <img src={thumbs[it.path]!} alt="" draggable={false} /> : <span className="glyph">IMG</span>}</div>
                      <div className="meta">
                        <span className="name">{it.name}</span>
                        <span className="size mono">
                          {new Date(it.ctime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} · {fmtBytes(it.size)}
                        </span>
                      </div>
                      <span className="check">{sel.has(it.path) && <IcCheck />}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
        <div className="statusbar">
          <span>
            더블클릭 크게 보기 · <span className="kbd">F2</span> 이름 변경 · 우클릭 변환 · 다른 앱으로 끌어다 놓기 · <span className="kbd">Ctrl/⌘ C</span> 복사
          </span>
          <span className="grow" />
          <span className="mono" title={dir} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
            {settings.libraryEnabled ? '● 수집 중' : '○ 수집 꺼짐'} · {dir}
          </span>
        </div>
      </div>

      {panel && <OptionsPanel action={panel.action} files={panel.files} settings={settings} engines={engines} onClose={() => setPanel(null)} onRun={(o, save) => run(panel.action, panel.files, o, save)} />}
      {grid && <GridMenu files={grid.files} at={{ x: grid.x, y: grid.y }} onPick={pick} onClose={() => setGrid(null)} />}
      {renaming && (
        <RenameModal
          items={items.filter((i) => renaming.includes(i.path)).sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path)).map((i) => ({ path: i.path, mtime: i.ctime }))}
          onClose={() => setRenaming(null)}
          onDone={(r) => setSel(new Set(r.map((x) => x.to)))}
          toast={toast}
        />
      )}
      {preview && (
        <div className="lib-preview" onClick={() => setPreview(null)}>
          {big ? <img src={big} alt="" onClick={(e) => e.stopPropagation()} /> : <span className="muted">불러오는 중…</span>}
          <div className="cap" style={{ color: '#ddd' }}>
            {preview.split(/[\\/]/).pop()} · ← → 이동 · Space / Esc 닫기
          </div>
        </div>
      )}
    </div>
  )
}

const isMacKey = (e: KeyboardEvent) => e.metaKey || navigator.platform.toLowerCase().includes('mac')
