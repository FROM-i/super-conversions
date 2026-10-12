import { useCallback, useEffect, useRef, useState, type PointerEvent as RPE } from 'react'
import type { AnnoType, Annotation, EditDocument, EditPageRef, Settings } from '@shared/types'
import { sc } from '../lib/api'
import { openPdf, type PdfDoc } from '../lib/pdfjs'
import { baseName, cls, uid } from '../lib/util'
import { IcPlus, IcRedo, IcRot, IcTrash, IcUndo } from '../lib/icons'

// ---------------------------------------------------------------- model
interface PageRef extends EditPageRef {
  key: string
}
interface Anno extends Annotation {
  pk: string // page key
}
interface Snap {
  pages: PageRef[]
  annos: Anno[]
}

type Tool = 'select' | AnnoType
const TOOLS: { t: Tool; k: string; label: string; glyph: string }[] = [
  { t: 'select', k: 'v', label: '선택 (V)', glyph: '↖' },
  { t: 'text', k: 't', label: '텍스트 (T)', glyph: 'T' },
  { t: 'rect', k: 'r', label: '사각형 (R)', glyph: '□' },
  { t: 'ellipse', k: 'o', label: '원 (O)', glyph: '○' },
  { t: 'line', k: 'l', label: '선 (L)', glyph: '╱' },
  { t: 'arrow', k: 'a', label: '화살표 (A)', glyph: '↗' },
  { t: 'pen', k: 'p', label: '펜 (P)', glyph: '✎' },
  { t: 'highlight', k: 'h', label: '형광펜 (H)', glyph: 'H' },
  { t: 'whiteout', k: 'w', label: '흰색으로 덮기 (W)', glyph: '▢' },
  { t: 'redact', k: 'x', label: '가리기 · 내용 완전 삭제 (X)', glyph: '■' },
  { t: 'image', k: 'i', label: '이미지 (I)', glyph: '▣' },
  { t: 'signature', k: 's', label: '서명·직인 (S)', glyph: '✍' }
]
const COLORS = ['#111111', '#2F5BFF', '#FF5A1F', '#E5383B', '#18A058', '#B9A6FF', '#C6F432']
const A4 = { w: 595.28, h: 841.89 }

interface Props {
  path: string | null
  settings: Settings
  onClose: () => void
  toast: (m: string) => void
}

export default function PdfEditor({ path, settings, onClose, toast }: Props) {
  const [sources, setSources] = useState<string[]>([])
  const [docs, setDocs] = useState<PdfDoc[]>([])
  const [snap, setSnap] = useState<Snap>({ pages: [], annos: [] })
  const [past, setPast] = useState<Snap[]>([])
  const [future, setFuture] = useState<Snap[]>([])
  const [cur, setCur] = useState(0)
  const [zoom, setZoom] = useState(1.25)
  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState('#E5383B')
  const [stroke, setStroke] = useState(2)
  const [fontSize, setFontSize] = useState(14)
  const [selId, setSelId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [pendingImg, setPendingImg] = useState<{ data: string; w: number; h: number } | null>(null)
  const [sigList, setSigList] = useState<{ id: string; name: string; data: string }[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  // ---------------- load
  useEffect(() => {
    if (!path) return
    ;(async () => {
      const bytes = await sc.read(path)
      const d = await openPdf(bytes)
      setSources([path])
      setDocs([d])
      const pages: PageRef[] = Array.from({ length: d.numPages }, (_, i) => ({ key: uid(), src: 0, index: i, rotate: 0 }))
      setSnap({ pages, annos: [] })
      setPast([])
      setFuture([])
      setCur(0)
    })().catch((e) => toast(`PDF를 열 수 없습니다: ${(e as Error).message}`))
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ;(async () => {
      const l: { id: string; name: string; data: string }[] = []
      for (const s of settings.signatures) {
        const d = await sc.getSignature(s.id)
        if (d) l.push({ id: s.id, name: s.name, data: d })
      }
      setSigList(l)
    })()
  }, [settings.signatures])

  const commit = useCallback(
    (next: Snap | ((s: Snap) => Snap)) => {
      setSnap((s) => {
        const n = typeof next === 'function' ? next(s) : next
        setPast((p) => [...p.slice(-60), s])
        setFuture([])
        return n
      })
    },
    [setSnap]
  )
  const undo = () => {
    if (!past.length) return
    setFuture((f) => [snap, ...f])
    setSnap(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }
  const redo = () => {
    if (!future.length) return
    setPast((p) => [...p, snap])
    setSnap(future[0])
    setFuture((f) => f.slice(1))
  }

  // ---------------- page geometry
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number; base: number }>>({})
  useEffect(() => {
    ;(async () => {
      const add: Record<string, { w: number; h: number; base: number }> = {}
      for (const p of snap.pages) {
        const k = `${p.src}:${p.index}`
        if (sizes[k] || p.index < 0) continue
        const pg = await docs[p.src]?.getPage(p.index + 1)
        if (!pg) continue
        const vp = pg.getViewport({ scale: 1, rotation: 0 })
        add[k] = { w: vp.width, h: vp.height, base: pg.rotate } // explicit rotation 0 = unrotated box
      }
      if (Object.keys(add).length) setSizes((s) => ({ ...s, ...add }))
    })()
  }, [snap.pages, docs]) // eslint-disable-line react-hooks/exhaustive-deps

  const dispSize = (p: PageRef) => {
    if (p.index < 0) {
      const sw = (p.rotate / 90) % 2 ? [p.height ?? A4.h, p.width ?? A4.w] : [p.width ?? A4.w, p.height ?? A4.h]
      return { w: sw[0], h: sw[1], rot: p.rotate }
    }
    const s = sizes[`${p.src}:${p.index}`]
    if (!s) return { w: A4.w, h: A4.h, rot: 0 }
    const rot = (s.base + p.rotate) % 360
    return rot % 180 ? { w: s.h, h: s.w, rot } : { w: s.w, h: s.h, rot }
  }

  // ---------------- thumbnails
  useEffect(() => {
    let alive = true
    ;(async () => {
      for (const p of snap.pages) {
        const tk = `${p.src}:${p.index}:${p.rotate}`
        if (thumbs[tk] || p.index < 0 || !docs[p.src]) continue
        const pg = await docs[p.src].getPage(p.index + 1)
        const vp = pg.getViewport({ scale: 0.25, rotation: (pg.rotate + p.rotate) % 360 })
        const c = document.createElement('canvas')
        c.width = vp.width
        c.height = vp.height
        await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp, canvas: c }).promise
        if (!alive) return
        const url = c.toDataURL('image/jpeg', 0.7)
        setThumbs((t) => ({ ...t, [tk]: url }))
      }
    })()
    return () => {
      alive = false
    }
  }, [snap.pages, docs]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- page ops
  const rotatePage = (key: string, d = 90) => commit((s) => ({ ...s, pages: s.pages.map((p) => (p.key === key ? { ...p, rotate: (p.rotate + d + 360) % 360 } : p)) }))
  const deletePage = (key: string) => {
    if (snap.pages.length <= 1) return toast('마지막 한 장은 지울 수 없습니다.')
    commit((s) => ({ pages: s.pages.filter((p) => p.key !== key), annos: s.annos.filter((a) => a.pk !== key) }))
  }
  const insertBlank = (afterKey: string) =>
    commit((s) => {
      const i = s.pages.findIndex((p) => p.key === afterKey)
      const ref = s.pages[i]
      const d = ref ? dispSize(ref) : { w: A4.w, h: A4.h }
      const n = [...s.pages]
      n.splice(i + 1, 0, { key: uid(), src: 0, index: -1, rotate: 0, width: d.w, height: d.h })
      return { ...s, pages: n }
    })
  const addPdf = async () => {
    const files = await sc.pickPdf()
    if (!files.length) return
    let srcs = [...sources]
    let ds = [...docs]
    const added: PageRef[] = []
    for (const f of files) {
      const d = await openPdf(await sc.read(f))
      const si = srcs.length
      srcs = [...srcs, f]
      ds = [...ds, d]
      for (let i = 0; i < d.numPages; i++) added.push({ key: uid(), src: si, index: i, rotate: 0 })
    }
    setSources(srcs)
    setDocs(ds)
    commit((s) => ({ ...s, pages: [...s.pages, ...added] }))
    toast(`${added.length}쪽을 뒤에 추가했습니다.`)
  }
  const movePage = (from: string, to: string) =>
    commit((s) => {
      const n = [...s.pages]
      const a = n.findIndex((p) => p.key === from)
      const b = n.findIndex((p) => p.key === to)
      const [m] = n.splice(a, 1)
      n.splice(b, 0, m)
      return { ...s, pages: n }
    })

  // ---------------- annotations
  const updAnno = (id: string, patch: Partial<Anno>, record = false) => {
    const f = (s: Snap) => ({ ...s, annos: s.annos.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
    record ? commit(f) : setSnap(f)
  }
  const delAnno = (id: string) => {
    commit((s) => ({ ...s, annos: s.annos.filter((a) => a.id !== id) }))
    setSelId(null)
  }

  const pickTool = async (t: Tool) => {
    setSelId(null)
    setEditId(null)
    if (t === 'image') {
      const d = await sc.pickImage()
      if (!d) return
      const im = await loadImg(d)
      setPendingImg({ data: d, w: im.width, h: im.height })
    } else if (t === 'signature') {
      const s = sigList.find((x) => x.id === settings.defaultSignatureId) ?? sigList[0]
      if (!s) return toast('저장된 서명이 없습니다. 설정 › 서명·직인에서 등록해 주세요.')
      const im = await loadImg(s.data)
      setPendingImg({ data: s.data, w: im.width, h: im.height })
    }
    setTool(t)
  }

  // ---------------- keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.closest?.('input,textarea,select')
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
        return
      }
      if (inField) return
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId) {
        e.preventDefault()
        delAnno(selId)
        return
      }
      if (e.key === 'Escape') {
        setSelId(null)
        setTool('select')
        return
      }
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z + 0.25))
      if (e.key === '-') setZoom((z) => Math.max(0.5, z - 0.25))
      const t = TOOLS.find((x) => x.k === e.key.toLowerCase())
      if (t && !mod) pickTool(t.t)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  // ---------------- save
  const save = async () => {
    if (saving || !sources.length) return
    setSaving(true)
    try {
      const pages: EditPageRef[] = []
      for (const p of snap.pages) {
        const reds = snap.annos.filter((a) => a.pk === p.key && a.type === 'redact')
        const ref: EditPageRef = { src: p.src, index: p.index, rotate: p.rotate, width: p.width, height: p.height }
        if (reds.length) {
          // true redaction: flatten the page to pixels with the boxes burned in
          const d = dispSize(p)
          ref.width = d.w
          ref.height = d.h
          const c = document.createElement('canvas')
          const scale = 200 / 72
          c.width = Math.round(d.w * scale)
          c.height = Math.round(d.h * scale)
          const ctx = c.getContext('2d')!
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, c.width, c.height)
          if (p.index >= 0) {
            const pg = await docs[p.src].getPage(p.index + 1)
            const vp = pg.getViewport({ scale, rotation: d.rot })
            await pg.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise
          }
          ctx.fillStyle = '#000'
          for (const r of reds) ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale)
          ref.raster = c.toDataURL('image/png')
        }
        pages.push(ref)
      }
      const idx = new Map(snap.pages.map((p, i) => [p.key, i]))
      const annotations: Annotation[] = snap.annos.filter((a) => idx.has(a.pk) && !(a.type === 'text' && !a.text?.trim())).map(({ pk, ...a }) => ({ ...a, page: idx.get(pk)! }))
      const model: EditDocument = { sources, pages, annotations, outputName: baseName(sources[0]).replace(/\.pdf$/i, '') }
      await sc.startEdit(model)
      toast('저장했습니다 → SUPER CONVERSIONS 폴더')
    } catch (e) {
      toast(`저장 실패: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (!path)
    return (
      <div className="dropzone-wrap">
        <div className="empty-state" style={{ maxWidth: 520 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink)', marginBottom: 8 }}>PDF 편집</div>
          변환 보드에서 PDF를 더블클릭하거나, 우클릭 그리드의 EDIT 칸을 누르세요.
          <div style={{ marginTop: 16 }}>
            <button
              className="btn solid"
              onClick={async () => {
                const f = await sc.pickPdf()
                if (f[0]) window.dispatchEvent(new CustomEvent('sc-open-editor', { detail: f[0] }))
              }}
            >
              PDF 열기
            </button>
          </div>
        </div>
      </div>
    )

  const sel = snap.annos.find((a) => a.id === selId)
  return (
    <div className="editor tone-pdf">
      <div className="ed-tools">
        {TOOLS.map((t) => (
          <button key={t.t} className={cls('tool', tool === t.t && 'on')} title={t.label} onClick={() => pickTool(t.t)}>
            {t.glyph}
          </button>
        ))}
        <span className="sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={cls('swatch', color === c && 'on')}
            style={{ background: c }}
            onClick={() => {
              setColor(c)
              if (sel) updAnno(sel.id, sel.type === 'text' || sel.type === 'line' || sel.type === 'arrow' || sel.type === 'pen' || sel.type === 'rect' || sel.type === 'ellipse' || sel.type === 'highlight' ? { color: c } : {}, true)
            }}
            aria-label={c}
          />
        ))}
        <span className="sep" />
        <select className="inp" style={{ width: 74, height: 30 }} value={stroke} onChange={(e) => (setStroke(+e.target.value), sel && updAnno(sel.id, { strokeWidth: +e.target.value }, true))} title="선 두께">
          {[1, 2, 3, 4, 6, 8].map((v) => (
            <option key={v} value={v}>
              {v}pt
            </option>
          ))}
        </select>
        <select className="inp" style={{ width: 74, height: 30 }} value={fontSize} onChange={(e) => (setFontSize(+e.target.value), sel?.type === 'text' && updAnno(sel.id, { fontSize: +e.target.value }, true))} title="글자 크기">
          {[9, 10, 11, 12, 14, 16, 18, 24, 32, 48].map((v) => (
            <option key={v} value={v}>
              {v}pt
            </option>
          ))}
        </select>
        {tool === 'signature' && sigList.length > 1 && (
          <select
            className="inp"
            style={{ width: 140, height: 30 }}
            onChange={async (e) => {
              const s = sigList.find((x) => x.id === e.target.value)
              if (s) {
                const im = await loadImg(s.data)
                setPendingImg({ data: s.data, w: im.width, h: im.height })
              }
            }}
          >
            {sigList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <span className="sep" />
        <button className="tool" title="실행 취소 (Ctrl+Z)" onClick={undo} disabled={!past.length}>
          <IcUndo />
        </button>
        <button className="tool" title="다시 실행" onClick={redo} disabled={!future.length}>
          <IcRedo />
        </button>
        <span className="sep" />
        <button className="tool" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} title="축소 (-)">
          −
        </button>
        <span className="mono" style={{ width: 44, textAlign: 'center', fontWeight: 500 }}>
          {Math.round(zoom * 100)}%
        </span>
        <button className="tool" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} title="확대 (+)">
          +
        </button>
        <span className="grow" />
        <span className="muted fname" style={{ marginRight: 8, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {baseName(path)}
        </span>
        <button className="btn ghost" onClick={onClose}>
          닫기
        </button>
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? '저장 중…' : '저장'} <span className="kbd" style={{ color: 'inherit', borderColor: 'currentColor' }}>Ctrl S</span>
        </button>
      </div>

      <div className="ed-thumbs">
        {snap.pages.map((p, i) => {
          const tk = `${p.src}:${p.index}:${p.rotate}`
          const d = dispSize(p)
          return (
            <div
              key={p.key}
              className={cls('ed-thumb', cur === i && 'cur', overKey === p.key && dragKey !== p.key && 'over')}
              draggable
              onDragStart={() => setDragKey(p.key)}
              onDragOver={(e) => (e.preventDefault(), setOverKey(p.key))}
              onDrop={() => {
                if (dragKey && dragKey !== p.key) movePage(dragKey, p.key)
                setDragKey(null)
                setOverKey(null)
              }}
              onDragEnd={() => (setDragKey(null), setOverKey(null))}
              onClick={() => {
                setCur(i)
                document.getElementById(`pg-${p.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {p.index < 0 ? <div className="blank" style={{ aspectRatio: `${d.w}/${d.h}` }} /> : thumbs[tk] ? <img src={thumbs[tk]} alt="" draggable={false} /> : <div className="blank" style={{ aspectRatio: `${d.w}/${d.h}` }} />}
              <span className="n">{i + 1}</span>
              <div className="ops">
                <button onClick={(e) => (e.stopPropagation(), rotatePage(p.key))} title="90° 회전">
                  <IcRot />
                </button>
                <button onClick={(e) => (e.stopPropagation(), insertBlank(p.key))} title="뒤에 빈 페이지">
                  <IcPlus />
                </button>
                <button onClick={(e) => (e.stopPropagation(), deletePage(p.key))} title="삭제">
                  <IcTrash />
                </button>
              </div>
            </div>
          )
        })}
        <button className="btn" style={{ justifyContent: 'center' }} onClick={addPdf}>
          <IcPlus /> PDF 추가
        </button>
      </div>

      <div
        className="ed-stage"
        ref={stageRef}
        onScroll={(e) => {
          const st = e.currentTarget.scrollTop
          let acc = 28
          for (let i = 0; i < snap.pages.length; i++) {
            const h = dispSize(snap.pages[i]).h * zoom + 24
            if (st < acc + h / 2) {
              if (cur !== i) setCur(i)
              break
            }
            acc += h
          }
        }}
      >
        {snap.pages.map((p) => (
          <PageView
            key={p.key}
            page={p}
            doc={docs[p.src]}
            disp={dispSize(p)}
            zoom={zoom}
            annos={snap.annos.filter((a) => a.pk === p.key)}
            tool={tool}
            color={color}
            stroke={stroke}
            fontSize={fontSize}
            pendingImg={pendingImg}
            selId={selId}
            editId={editId}
            setSelId={setSelId}
            setEditId={setEditId}
            create={(a) => {
              commit((s) => ({ ...s, annos: [...s.annos, a] }))
              if (a.type === 'text') {
                setEditId(a.id)
                setSelId(a.id)
              }
              if (a.type === 'image' || a.type === 'signature') {
                setTool('select')
                setSelId(a.id)
              }
            }}
            update={updAnno}
            begin={() => setPast((x) => [...x.slice(-60), snap])}
          />
        ))}
      </div>
    </div>
  )
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = rej
    i.src = src
  })
}

// ---------------------------------------------------------------- page view
interface PVProps {
  page: PageRef
  doc?: PdfDoc
  disp: { w: number; h: number; rot: number }
  zoom: number
  annos: Anno[]
  tool: Tool
  color: string
  stroke: number
  fontSize: number
  pendingImg: { data: string; w: number; h: number } | null
  selId: string | null
  editId: string | null
  setSelId: (id: string | null) => void
  setEditId: (id: string | null) => void
  create: (a: Anno) => void
  update: (id: string, p: Partial<Anno>, record?: boolean) => void
  begin: () => void
}

function PageView(props: PVProps) {
  const { page, doc, disp, zoom, annos, tool } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Anno | null>(null)
  const [visible, setVisible] = useState(false)
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = holder.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: '800px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !doc || page.index < 0 || !canvas.current) return
    let task: { cancel: () => void } | null = null
    let alive = true
    ;(async () => {
      const pg = await doc.getPage(page.index + 1)
      if (!alive) return
      const dpr = window.devicePixelRatio || 1
      const vp = pg.getViewport({ scale: zoom * dpr, rotation: disp.rot })
      const c = canvas.current!
      c.width = Math.floor(vp.width)
      c.height = Math.floor(vp.height)
      const t = pg.render({ canvasContext: c.getContext('2d')!, viewport: vp, canvas: c })
      task = t
      await t.promise.catch(() => undefined)
    })()
    return () => {
      alive = false
      task?.cancel()
    }
  }, [visible, doc, page.index, disp.rot, zoom])

  const toPt = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
  }

  const onDown = (e: RPE<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (tool === 'select') {
      if (e.target === e.currentTarget) {
        props.setSelId(null)
        props.setEditId(null)
      }
      return
    }
    e.preventDefault()
    const p = toPt(e)
    const base: Anno = { id: uid(), pk: page.key, page: 0, type: tool, x: p.x, y: p.y, w: 0, h: 0, color: props.color, strokeWidth: props.stroke }
    if (tool === 'text') {
      props.create({ ...base, w: 220, h: props.fontSize * 1.4, fontSize: props.fontSize, text: '', color: props.color })
      return
    }
    if (tool === 'image' || tool === 'signature') {
      if (!props.pendingImg) return
      const w = tool === 'signature' ? 150 : Math.min(240, props.pendingImg.w)
      const h = (w * props.pendingImg.h) / props.pendingImg.w
      props.create({ ...base, x: p.x - w / 2, y: p.y - h / 2, w, h, image: props.pendingImg.data })
      return
    }
    if (tool === 'highlight') base.color = props.color === '#111111' ? '#FFE14D' : props.color
    if (tool === 'line' || tool === 'arrow') base.points = [p.x, p.y, p.x, p.y]
    if (tool === 'pen') base.points = [p.x, p.y]
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDraft(base)
  }
  const onMove = (e: RPE<HTMLDivElement>) => {
    if (!draft) return
    const p = toPt(e)
    if (draft.type === 'pen') {
      const pts = [...(draft.points ?? []), p.x, p.y]
      setDraft({ ...draft, points: pts, ...bbox(pts) })
    } else if (draft.type === 'line' || draft.type === 'arrow') {
      const pts = [draft.points![0], draft.points![1], p.x, p.y]
      setDraft({ ...draft, points: pts, ...bbox(pts) })
    } else {
      const x0 = draft.points?.[0] ?? draft.x
      const y0 = draft.points?.[1] ?? draft.y
      if (!draft.points) draft.points = [draft.x, draft.y]
      setDraft({ ...draft, x: Math.min(x0, p.x), y: Math.min(y0, p.y), w: Math.abs(p.x - x0), h: Math.abs(p.y - y0) })
    }
  }
  const onUp = () => {
    if (!draft) return
    const d = draft
    setDraft(null)
    const isBox = !['pen', 'line', 'arrow'].includes(d.type)
    if (isBox && (d.w < 3 || d.h < 3)) return
    if (!isBox && (d.points?.length ?? 0) < 4) return
    props.create(isBox ? { ...d, points: undefined } : d)
  }

  return (
    <div id={`pg-${page.key}`} ref={holder} className="ed-page" style={{ width: disp.w * zoom, height: disp.h * zoom }}>
      {page.index >= 0 && <canvas ref={canvas} />}
      <div className="ed-layer" ref={layer} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} style={{ cursor: tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair' }}>
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <defs>
            <marker id={`ah-${page.key}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          {[...annos, ...(draft ? [draft] : [])]
            .filter((a) => a.type === 'pen' || a.type === 'line' || a.type === 'arrow')
            .map((a) => {
              const pts = a.points ?? []
              const d = pts.reduce((s, v, i) => s + (i % 2 === 0 ? `${i ? ' L' : 'M'}${v * zoom}` : `,${v * zoom}`), '')
              return (
                <path
                  key={a.id}
                  d={d}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={(a.strokeWidth ?? 2) * zoom}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={a.type === 'arrow' ? `url(#ah-${page.key})` : undefined}
                  style={{ pointerEvents: tool === 'select' ? 'stroke' : 'none', cursor: 'move', strokeDasharray: props.selId === a.id ? `${4 * zoom} ${3 * zoom}` : undefined }}
                  onPointerDown={(e) => tool === 'select' && startMove(e, a, props, zoom)}
                />
              )
            })}
        </svg>
        {[...annos, ...(draft ? [draft] : [])]
          .filter((a) => a.type !== 'pen' && a.type !== 'line' && a.type !== 'arrow')
          .map((a) => (
            <AnnoBox key={a.id} a={a} {...props} />
          ))}
      </div>
    </div>
  )
}

const bbox = (pts: number[]) => {
  const xs = pts.filter((_, i) => i % 2 === 0)
  const ys = pts.filter((_, i) => i % 2 === 1)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function startMove(e: React.PointerEvent, a: Anno, p: PVProps, zoom: number, resize = false) {
  e.stopPropagation()
  e.preventDefault()
  p.setSelId(a.id)
  const sx = e.clientX
  const sy = e.clientY
  const orig = { ...a, points: a.points ? [...a.points] : undefined }
  let moved = false
  const mv = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / zoom
    const dy = (ev.clientY - sy) / zoom
    if (!moved && Math.abs(dx) + Math.abs(dy) < 1) return
    if (!moved) p.begin()
    moved = true
    if (resize) {
      let w = Math.max(8, orig.w + dx)
      let h = Math.max(8, orig.h + dy)
      if (a.type === 'image' || a.type === 'signature') h = (w * orig.h) / orig.w
      if (a.type === 'text') {
        h = Math.max(orig.h, h)
        w = Math.max(40, w)
      }
      p.update(a.id, { w, h })
    } else {
      p.update(a.id, { x: orig.x + dx, y: orig.y + dy, points: orig.points?.map((v, i) => v + (i % 2 === 0 ? dx : dy)) })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', mv)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', mv)
  window.addEventListener('pointerup', up)
}

function AnnoBox({ a, ...p }: PVProps & { a: Anno }) {
  const zoom = p.zoom
  const sel = p.selId === a.id
  const editing = p.editId === a.id
  const style: React.CSSProperties = { left: a.x * zoom, top: a.y * zoom, width: a.w * zoom, height: a.h * zoom, pointerEvents: p.tool === 'select' || editing ? 'auto' : 'none', cursor: p.tool === 'select' ? 'move' : undefined }
  let inner: React.ReactNode = null
  switch (a.type) {
    case 'rect':
      Object.assign(style, { border: `${(a.strokeWidth ?? 2) * zoom}px solid ${a.color}`, background: a.fill })
      break
    case 'ellipse':
      Object.assign(style, { border: `${(a.strokeWidth ?? 2) * zoom}px solid ${a.color}`, borderRadius: '50%' })
      break
    case 'highlight':
      Object.assign(style, { background: a.color, opacity: 0.4, mixBlendMode: 'multiply' })
      break
    case 'whiteout':
      Object.assign(style, { background: '#fff', outline: sel ? undefined : '1px dashed #ccc' })
      break
    case 'redact':
      Object.assign(style, { background: '#000' })
      break
    case 'image':
    case 'signature':
      inner = <img src={a.image} alt="" draggable={false} style={{ width: '100%', height: '100%', display: 'block' }} />
      break
    case 'text':
      inner = editing ? (
        <textarea
          autoFocus
          value={a.text ?? ''}
          style={{ fontSize: (a.fontSize ?? 14) * zoom, color: a.color, fontWeight: a.bold ? 700 : 400 }}
          onChange={(e) => {
            const lines = e.target.value.split('\n')
            const longest = Math.max(...lines.map((l) => l.length))
            p.update(a.id, { text: e.target.value, h: Math.max(a.h, lines.length * (a.fontSize ?? 14) * 1.3 + 2), w: Math.max(a.w, Math.min(560, longest * (a.fontSize ?? 14) * 0.62 + 12)) })
          }}
          onBlur={() => p.setEditId(null)}
          onKeyDown={(e) => e.key === 'Escape' && (e.currentTarget as HTMLTextAreaElement).blur()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="txt" style={{ fontSize: (a.fontSize ?? 14) * zoom, color: a.color, fontWeight: a.bold ? 700 : 400 }}>
          {a.text || ' '}
        </div>
      )
      break
  }
  return (
    <div
      className={cls('anno', sel && 'sel')}
      style={style}
      onPointerDown={(e) => p.tool === 'select' && !editing && startMove(e, a, p, zoom)}
      onDoubleClick={() => a.type === 'text' && p.setEditId(a.id)}
    >
      {inner}
      {sel && !editing && p.tool === 'select' && <span className="handle" onPointerDown={(e) => startMove(e, a, p, zoom, true)} />}
    </div>
  )
}

