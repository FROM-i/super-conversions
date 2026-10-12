import { useEffect, useMemo, useRef, useState } from 'react'
import { ACTION_BY_ID, categoryOf, extOf, type ActionId } from '@shared/formats'
import type { ActionOptions, EngineStatus, FileResult, Job, Settings } from '@shared/types'
import { sc } from '../lib/api'
import { baseName, cls, fmtBytes, toneOfPath } from '../lib/util'
import GridMenu, { type GridPick } from '../components/GridMenu'
import OptionsPanel from '../components/OptionsPanel'
import RenameModal from '../components/RenameModal'
import SelectAll from '../components/SelectAll'
import { IcCheck, IcFile, IcFolder, IcLink, IcX } from '../lib/icons'

interface Props {
  files: string[]
  setFiles: (f: string[] | ((x: string[]) => string[])) => void
  jobs: Job[]
  settings: Settings
  setSettings: (s: Settings) => void
  engines: EngineStatus | null
  pendingAction: ActionId | null
  clearPendingAction: () => void
  onOpenEditor: (path: string) => void
  onLinks: (urls: string[]) => void
  toast: (m: string) => void
}

export default function ConvertView(p: Props) {
  const { files, setFiles, jobs, settings, engines } = p
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [grid, setGrid] = useState<{ x: number; y: number; files: string[] } | null>(null)
  const [panel, setPanel] = useState<{ action: ActionId; files: string[] } | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<string[] | null>(null)
  // checkbox mode: once a checkbox / select-all is used, plain clicks toggle instead of replacing
  const [checkMode, setCheckMode] = useState(false)
  useEffect(() => {
    if (sel.size === 0) setCheckMode(false)
  }, [sel])
  const toggle = (f: string) => {
    setSel((s) => {
      const n = new Set(s)
      n.has(f) ? n.delete(f) : n.add(f)
      return n
    })
    setAnchor(f)
    setCheckMode(true)
  }
  const tilesRef = useRef<HTMLDivElement>(null)

  // latest result per input path
  const fileState = useMemo(() => {
    const m = new Map<string, FileResult>()
    for (const j of [...jobs].reverse()) if (j.action !== 'download') for (const f of j.files) m.set(f.input, f)
    return m
  }, [jobs])

  useEffect(() => {
    for (const f of files) {
      if (!(f in thumbs)) {
        setThumbs((t) => ({ ...t, [f]: null }))
        sc.thumb(f).then((d) => setThumbs((t) => ({ ...t, [f]: d })))
        sc.stat(f).then((s) => setSizes((x) => ({ ...x, [f]: s.size }))).catch(() => undefined)
      }
    }
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  // overlay "open with options" handoff
  useEffect(() => {
    if (p.pendingAction && files.length) {
      setPanel({ action: p.pendingAction, files })
      p.clearPendingAction()
    }
  }, [p.pendingAction]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = files.filter((f) => sel.has(f))
  const targets = selected.length ? selected : files

  const openGridAt = (x: number, y: number, fs: string[]) => {
    if (!fs.length) return
    setPanel(null)
    setGrid({ x, y, files: fs })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (grid || panel || renaming || (e.target as HTMLElement)?.closest?.('input,textarea')) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === ' ' && files.length) {
        e.preventDefault()
        const r = tilesRef.current?.getBoundingClientRect()
        openGridAt(r ? r.left + r.width / 2 : innerWidth / 2, r ? r.top + r.height / 2 : innerHeight / 2, targets)
      } else if (e.key === 'F2' && targets.length) {
        e.preventDefault()
        setRenaming(selected.length ? selected : files)
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        sc.renameUndo().then((r) => {
          if (r.renamed.length) applyRenamed(r.renamed)
          p.toast(r.renamed.length ? `이름 변경 ${r.renamed.length}개를 되돌렸습니다` : r.errors[0]?.error ?? '되돌릴 내용이 없습니다')
        })
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSel(new Set(files))
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
        setFiles((x) => x.filter((f) => !sel.has(f)))
        setSel(new Set())
      } else if (e.key === 'Escape') setSel(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const clickTile = (f: string, e: React.MouseEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (e.shiftKey && anchor) {
      const a = files.indexOf(anchor)
      const b = files.indexOf(f)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSel(new Set(files.slice(lo, hi + 1)))
    } else if (mod || checkMode) {
      toggle(f)
    } else {
      setSel(sel.size === 1 && sel.has(f) ? new Set() : new Set([f]))
      setAnchor(f)
    }
  }

  const ctxTile = (f: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    let fs = selected
    if (!sel.has(f)) {
      setSel(new Set([f]))
      fs = [f]
    }
    openGridAt(e.clientX, e.clientY, fs)
  }

  const applyRenamed = (renamed: { from: string; to: string }[]) => {
    const m = new Map(renamed.map((r) => [r.from, r.to]))
    setFiles((x) => x.map((f) => m.get(f) ?? f))
    setSel((s) => new Set([...s].map((f) => m.get(f) ?? f)))
    setThumbs((t) => {
      const n = { ...t }
      for (const [a, b] of m) n[b] = t[a] ?? null
      return n
    })
    setSizes((z) => {
      const n = { ...z }
      for (const [a, b] of m) n[b] = z[a]
      return n
    })
  }

  const pick = (g: GridPick) => {
    setGrid(null)
    if (g.action === 'pdf.edit') {
      p.onOpenEditor(g.files[0])
      return
    }
    if (g.immediate) run(g.action, g.files)
    else setPanel({ action: g.action, files: g.files })
  }

  const run = async (action: ActionId, fs: string[], o?: ActionOptions, savePreset = false) => {
    setPanel(null)
    if (savePreset && o) {
      const s = await sc.saveSettings({ presets: { ...settings.presets, [action]: o } })
      p.setSettings(s)
    }
    await sc.start(action, fs, o)
    p.toast(`${ACTION_BY_ID[action].label} 변환을 시작했습니다 · ${fs.length}개`)
  }

  const add = async (kind: 'files' | 'folder') => {
    const got = await sc.pick(kind)
    if (got.length) setFiles((x) => [...new Set([...x, ...got])])
  }

  const pasteLinks = async () => {
    const text = await navigator.clipboard.readText().catch(() => '')
    const urls = await sc.extractUrls(text)
    if (urls.length) p.onLinks(urls)
    else p.toast('클립보드에 링크가 없습니다. 영상 링크를 복사한 뒤 다시 눌러 주세요.')
  }

  // ------------------------------------------------------------ empty state
  if (!files.length) {
    return (
      <div className="dropzone-wrap">
        <div>
          <div className="dropzone">
            <div className="hero">
              <div className="mosaic">
                <i className="tone-doc" />
                <i className="tone-image" />
                <i className="tone-video" />
                <i className="tone-pdf" />
              </div>
              <div className="big">파일을 끌어다 놓으세요</div>
              <div className="sub">
                문서 · 이미지 · 영상 · PDF
                <br />
                놓은 뒤 우클릭하면 변환 그리드가 열립니다
              </div>
            </div>
            <div className="actions">
              <button onClick={() => add('files')}>
                <IcFile /> 파일 선택
              </button>
              <button onClick={() => add('folder')}>
                <IcFolder /> 폴더 선택
              </button>
              <button onClick={pasteLinks}>
                <IcLink /> 링크 붙여넣기
              </button>
            </div>
          </div>
          <div className="legend">
            <span className="tone-doc">
              <i /> 문서
            </span>
            <span className="tone-image">
              <i /> 이미지
            </span>
            <span className="tone-video">
              <i /> 영상
            </span>
            <span className="tone-pdf">
              <i /> PDF
            </span>
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------ board
  const cats = new Set(targets.map(categoryOf))
  return (
    <div className="board">
      <div className="board-main">
        <div className="toolbar">
          <span className="title">{files.length}개 파일</span>
          <SelectAll total={files.length} selected={selected.length} onAll={() => (setSel(new Set(files)), setCheckMode(true))} onNone={() => setSel(new Set())} />
          <span className="grow" />
          <button className="btn ghost" onClick={() => setRenaming(selected.length ? selected : files)} title="선택한 파일(없으면 전체)의 이름을 바꿉니다">
            이름 변경 <span className="kbd">F2</span>
          </button>
          <button className="btn ghost" onClick={() => add('files')}>
            <IcFile /> 추가
          </button>
          <button className="btn ghost" onClick={() => add('folder')}>
            <IcFolder /> 폴더
          </button>
          <button className="btn ghost" onClick={() => (setFiles([]), setSel(new Set()), setPanel(null))}>
            비우기
          </button>
          <button
            className="btn solid"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              openGridAt(r.left - 120, r.bottom + 190, targets)
            }}
          >
            변환 그리드 <span className="kbd" style={{ color: 'inherit', borderColor: 'currentColor' }}>Space</span>
          </button>
        </div>
        <div
          className={cls('tiles', checkMode && 'checking')}
          ref={tilesRef}
          onMouseDown={(e) => e.target === e.currentTarget && setSel(new Set())}
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault()
              openGridAt(e.clientX, e.clientY, targets)
            }
          }}
        >
          {files.map((f, i) => {
            const st = fileState.get(f)
            const ext = extOf(f)
            const prog = st?.status === 'running' ? st.progress : st?.status === 'done' ? 1 : 0
            return (
              <div
                key={f}
                className={cls('tile', toneOfPath(f), sel.has(f) && 'sel')}
                onClick={(e) => clickTile(f, e)}
                onDoubleClick={() => (ext === 'pdf' ? p.onOpenEditor(f) : sc.open(f))}
                onContextMenu={(e) => ctxTile(f, e)}
                draggable
                onDragStart={(e) => {
                  setDragIdx(i)
                  e.dataTransfer.setData('text/x-sc-index', String(i))
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (dragIdx !== null) e.preventDefault()
                }}
                onDrop={(e) => {
                  if (dragIdx === null) return
                  e.preventDefault()
                  e.stopPropagation()
                  setFiles((x) => {
                    const n = [...x]
                    const [m] = n.splice(dragIdx, 1)
                    n.splice(i, 0, m)
                    return n
                  })
                  setDragIdx(null)
                }}
                onDragEnd={() => setDragIdx(null)}
                title={f}
              >
                <div className="thumb">{thumbs[f] ? <img src={thumbs[f]!} alt="" draggable={false} /> : <span className="glyph">{ext.toUpperCase()}</span>}</div>
                <div className="meta">
                  <span className="name">{baseName(f)}</span>
                  <span className="size mono">{fmtBytes(sizes[f])}</span>
                </div>
                <span className="ext">{ext.toUpperCase()}</span>
                <button
                  className="check"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(f)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-label={sel.has(f) ? '선택 해제' : '선택'}
                >
                  {sel.has(f) && <IcCheck />}
                </button>
                <button
                  className="x"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFiles((x) => x.filter((y) => y !== f))
                  }}
                  aria-label="목록에서 빼기"
                >
                  <IcX />
                </button>
                {st && st.status !== 'queued' && (
                  <>
                    <svg className="prog" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <rect x="0" y="0" width="100" height="100" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - prog * 100} vectorEffect="non-scaling-stroke" />
                    </svg>
                    <span className={cls('state', st.status === 'done' && 'ok', st.status === 'error' && 'err')} title={st.message}>
                      {st.status === 'running' ? `${Math.round(st.progress * 100)}%` : st.status === 'done' ? 'DONE' : st.status === 'error' ? 'ERROR' : st.status.toUpperCase()}
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
        <div className="statusbar">
          <span>
            체크박스로 여러 개 선택 · 파일 <b>우클릭</b> 또는 <span className="kbd">Space</span> → 변환 그리드 · 숫자패드 <span className="kbd">1</span>–<span className="kbd">9</span> 로 바로 선택 · <span className="kbd">F2</span> 이름 변경
          </span>
          <span className="grow" />
          <span>{cats.size > 1 ? '여러 종류 선택됨 → 그리드에서 종류를 먼저 고릅니다' : ''}</span>
        </div>
      </div>
      {panel && (
        <OptionsPanel
          action={panel.action}
          files={panel.files}
          settings={settings}
          engines={engines}
          onClose={() => setPanel(null)}
          onRun={(o, save) => run(panel.action, panel.files, o, save)}
        />
      )}
      {grid && <GridMenu files={grid.files} at={{ x: grid.x, y: grid.y }} onPick={pick} onClose={() => setGrid(null)} />}
      {renaming && <RenameModal items={renaming.map((path) => ({ path }))} onClose={() => setRenaming(null)} onDone={applyRenamed} toast={p.toast} />}
    </div>
  )
}
