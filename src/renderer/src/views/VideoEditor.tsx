import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExportLevel, Job, VideoClipInfo } from '@shared/types'
import { sc } from '../lib/api'
import { baseName, cls, fmtBytes } from '../lib/util'
import { IcPlus, IcRedo, IcUndo } from '../lib/icons'

// ---------------------------------------------------------------- model
interface Clip {
  path: string
  name: string
  info: VideoClipInfo
  url: string
  sprite?: { url: string; frames: number } | null
  proxy?: 'making' | 'ready'
}
interface Seg {
  id: string
  path: string
  start: number
  end: number
  speed: number
  muted: boolean
}
const uid = () => Math.random().toString(36).slice(2, 9)
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4]
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|3gp|mts|m2ts)$/i
const segDur = (s: Seg) => (s.end - s.start) / s.speed
const fmt = (t: number, ms = false) => {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return ms ? `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}` : `${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`
}

const LEVELS: { id: ExportLevel; label: string; desc: string; mbps: number; cap?: number }[] = [
  { id: 'high', label: '고화질', desc: '원본에 가깝게 · 파일이 큼', mbps: 8 },
  { id: 'balanced', label: '균형', desc: '화질과 용량의 균형 · 추천', mbps: 4.5 },
  { id: 'light', label: 'SNS·메신저', desc: '인스타·카톡 업로드용 · 최대 1080p', mbps: 2.2, cap: 1080 },
  { id: 'tiny', label: '아주 작게', desc: '빠른 공유용 · 최대 720p', mbps: 1, cap: 720 }
]

interface Props {
  active: boolean
  inbox: string[]
  clearInbox: () => void
  toast: (m: string) => void
}

export default function VideoEditor({ active, inbox, clearInbox, toast }: Props) {
  const [clips, setClips] = useState<Record<string, Clip>>({})
  const [segs, setSegs] = useState<Seg[]>([])
  const [past, setPast] = useState<Seg[][]>([])
  const [future, setFuture] = useState<Seg[][]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [tl, setTl] = useState(0) // timeline time (output seconds)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [proxyPct, setProxyPct] = useState<Record<string, number>>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const trackWrap = useRef<HTMLDivElement>(null)
  const [trackW, setTrackW] = useState(800)

  // refs for the playback loop (avoid stale closures)
  const segsRef = useRef(segs)
  segsRef.current = segs
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const curIdx = useRef(-1)
  const loadedPath = useRef<string | null>(null)

  const offsets = useMemo(() => {
    const o: number[] = []
    let acc = 0
    for (const s of segs) {
      o.push(acc)
      acc += segDur(s)
    }
    return { o, total: acc }
  }, [segs])
  const total = offsets.total

  const locate = useCallback((t: number) => {
    const ss = segsRef.current
    let acc = 0
    for (let i = 0; i < ss.length; i++) {
      const d = segDur(ss[i])
      if (t < acc + d - 1e-6 || i === ss.length - 1) return { i, src: Math.min(ss[i].end, ss[i].start + Math.max(0, t - acc) * ss[i].speed), off: acc }
      acc += d
    }
    return { i: -1, src: 0, off: 0 }
  }, [])

  // ---------------------------------------------------------------- history
  const commit = (next: Seg[] | ((s: Seg[]) => Seg[])) => {
    setSegs((cur) => {
      const n = typeof next === 'function' ? next(cur) : next
      setPast((p) => [...p.slice(-80), cur])
      setFuture([])
      return n
    })
  }
  const undo = () => {
    if (!past.length) return
    setFuture((f) => [segs, ...f])
    setSegs(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }
  const redo = () => {
    if (!future.length) return
    setPast((p) => [...p, segs])
    setSegs(future[0])
    setFuture((f) => f.slice(1))
  }

  // ---------------------------------------------------------------- import
  const loadClip = async (path: string): Promise<Clip | null> => {
    if (clipsRef.current[path]) return clipsRef.current[path]
    try {
      const info = await sc.videoInfo(path)
      const clip: Clip = { path, name: baseName(path), info, url: await sc.videoUrl(path) }
      setClips((c) => ({ ...c, [path]: clip }))
      sc.videoFilmstrip(path, info.duration).then((sp) => setClips((c) => (c[path] ? { ...c, [path]: { ...c[path], sprite: sp } } : c)))
      return clip
    } catch (e) {
      toast(`${baseName(path)}: ${(e as Error).message}`)
      return null
    }
  }

  const addPaths = async (paths: string[], mode: 'append' | 'replace' | 'shelf' = 'append') => {
    const vids = paths.filter((p) => VIDEO_EXT.test(p))
    if (!vids.length) return toast('영상 파일만 불러올 수 있습니다.')
    const loaded: Clip[] = []
    for (const p of vids) {
      const c = await loadClip(p)
      if (c) loaded.push(c)
    }
    if (mode === 'shelf' || !loaded.length) return
    const add = loaded.map((c) => ({ id: uid(), path: c.path, start: 0, end: c.info.duration, speed: 1, muted: false }))
    if (mode === 'replace') {
      commit(add)
      seek(0)
    } else commit((s) => [...s, ...add])
  }

  useEffect(() => {
    if (inbox.length) {
      addPaths(inbox, segsRef.current.length ? 'append' : 'replace')
      clearInbox()
    }
  }, [inbox]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => sc.onProxyProgress((p, x) => setProxyPct((m) => ({ ...m, [p]: x }))), [])

  // ---------------------------------------------------------------- playback
  const loadSeg = useCallback(async (i: number, src: number, autoplay: boolean) => {
    const v = video.current
    const s = segsRef.current[i]
    if (!v || !s) return
    const clip = clipsRef.current[s.path]
    if (!clip) return
    curIdx.current = i
    if (loadedPath.current !== clip.url) {
      loadedPath.current = clip.url
      v.src = clip.url
      await new Promise<void>((res) => {
        const done = () => (v.removeEventListener('loadedmetadata', done), v.removeEventListener('error', done), res())
        v.addEventListener('loadedmetadata', done)
        v.addEventListener('error', done)
      })
    }
    v.currentTime = src
    v.playbackRate = s.speed
    v.muted = s.muted
    if (autoplay) await v.play().catch(() => undefined)
  }, [])

  const seek = useCallback(
    (t: number) => {
      const tt = Math.max(0, Math.min(t, Math.max(0, offsets.total - 0.001)))
      setTl(tt)
      if (!segsRef.current.length) return
      const { i, src } = locate(tt)
      loadSeg(i, src, playing)
    },
    [offsets.total, locate, loadSeg, playing]
  )

  // keep the loop in sync with the video element
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const v = video.current
      const ss = segsRef.current
      const i = curIdx.current
      const s = ss[i]
      if (v && s) {
        let acc = 0
        for (let k = 0; k < i; k++) acc += segDur(ss[k])
        setTl(acc + Math.max(0, v.currentTime - s.start) / s.speed)
        if (v.currentTime >= s.end - 0.03) {
          if (i + 1 < ss.length) loadSeg(i + 1, ss[i + 1].start, true)
          else {
            v.pause()
            setPlaying(false)
            setTl(acc + segDur(s))
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, loadSeg])

  const togglePlay = async () => {
    const v = video.current
    if (!v || !segs.length) return
    if (playing) {
      v.pause()
      setPlaying(false)
      return
    }
    const start = tl >= total - 0.05 ? 0 : tl
    const { i, src } = locate(start)
    setPlaying(true)
    await loadSeg(i, src, true)
  }

  // when the edit changes while paused, re-show the frame under the playhead
  useEffect(() => {
    if (playing || !segs.length) return
    const t = Math.min(tl, Math.max(0, total - 0.001))
    if (t !== tl) setTl(t)
    const { i, src } = locate(t)
    loadSeg(i, src, false)
  }, [segs]) // eslint-disable-line react-hooks/exhaustive-deps

  // unplayable codec → make a preview proxy once
  const onVideoError = async () => {
    const s = segsRef.current[curIdx.current]
    if (!s) return
    const clip = clipsRef.current[s.path]
    if (!clip || clip.proxy) return
    setClips((c) => ({ ...c, [s.path]: { ...c[s.path], proxy: 'making' } }))
    toast('이 영상은 바로 재생할 수 없어 미리보기용 사본을 만드는 중입니다. 내보내기는 원본으로 합니다.')
    try {
      const url = await sc.videoProxy(s.path)
      setClips((c) => ({ ...c, [s.path]: { ...c[s.path], url, proxy: 'ready' } }))
      clipsRef.current = { ...clipsRef.current, [s.path]: { ...clipsRef.current[s.path], url, proxy: 'ready' } }
      loadedPath.current = null
      const { i, src } = locate(tl)
      loadSeg(i, src, false)
    } catch (e) {
      toast((e as Error).message)
    }
  }

  // ---------------------------------------------------------------- edit tools
  const targetIds = (): string[] => {
    if (sel.size) return [...sel]
    const { i } = locate(tl)
    return segs[i] ? [segs[i].id] : []
  }

  const split = () => {
    if (!segs.length) return
    const { i, src } = locate(tl)
    const s = segs[i]
    if (!s || src - s.start < 0.1 || s.end - src < 0.1) return toast('조각의 끝부분이라 자를 수 없습니다. 재생 막대를 조금 옮겨 주세요.')
    const left: Seg = { ...s, id: uid(), end: src }
    const right: Seg = { ...s, id: uid(), start: src }
    commit((ss) => ss.flatMap((x) => (x.id === s.id ? [left, right] : [x])))
    setSel(new Set())
  }

  const remove = () => {
    const ids = targetIds()
    if (!ids.length) return
    if (ids.length === segs.length) return toast('모든 조각을 지울 수는 없습니다. 하나 이상 남겨 주세요.')
    commit((ss) => ss.filter((x) => !ids.includes(x.id)))
    setSel(new Set())
  }

  const setSpeed = (speed: number) => {
    const ids = targetIds()
    if (!ids.length) return
    commit((ss) => ss.map((x) => (ids.includes(x.id) ? { ...x, speed } : x)))
    if (video.current && ids.includes(segs[curIdx.current]?.id)) video.current.playbackRate = speed
  }

  const toggleMute = () => {
    const ids = targetIds()
    if (!ids.length) return
    const allMuted = segs.filter((x) => ids.includes(x.id)).every((x) => x.muted)
    commit((ss) => ss.map((x) => (ids.includes(x.id) ? { ...x, muted: !allMuted } : x)))
  }

  const moveSeg = (from: string, to: string) =>
    commit((ss) => {
      const n = [...ss]
      const a = n.findIndex((x) => x.id === from)
      const b = n.findIndex((x) => x.id === to)
      const [m] = n.splice(a, 1)
      n.splice(b, 0, m)
      return n
    })

  // pause when the user leaves the editor
  useEffect(() => {
    if (!active && playing) {
      video.current?.pause()
      setPlaying(false)
    }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!active || exporting || (e.target as HTMLElement)?.closest?.('input,textarea,select')) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 's' && !mod) split()
      else if (e.key === 'Delete' || e.key === 'Backspace') remove()
      else if (e.key === 'ArrowLeft') seek(tl - (e.shiftKey ? 5 : 1))
      else if (e.key === 'ArrowRight') seek(tl + (e.shiftKey ? 5 : 1))
      else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
      } else if (mod && e.key.toLowerCase() === 'y') redo()
      else if (e.key === 'Escape') setSel(new Set())
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  // ---------------------------------------------------------------- timeline geometry
  useEffect(() => {
    const el = trackWrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth - 32))
    ro.observe(el)
    return () => ro.disconnect()
  }, [segs.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  const pps = total > 0 ? (trackW / total) * zoom : 50 // pixels per output second

  const trackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    seek((e.clientX - r.left) / pps)
  }

  const startTrim = (e: React.PointerEvent, s: Seg, edge: 'l' | 'r') => {
    e.stopPropagation()
    e.preventDefault()
    const clip = clips[s.path]
    const x0 = e.clientX
    const orig = { ...s }
    let moved = false
    const mv = (ev: PointerEvent) => {
      const dSrc = ((ev.clientX - x0) / pps) * orig.speed
      if (!moved) {
        setPast((p) => [...p.slice(-80), segsRef.current])
        setFuture([])
        moved = true
      }
      setSegs((ss) =>
        ss.map((x) =>
          x.id !== s.id ? x : edge === 'l' ? { ...x, start: Math.max(0, Math.min(orig.end - 0.1, orig.start + dSrc)) } : { ...x, end: Math.min(clip?.info.duration ?? orig.end, Math.max(orig.start + 0.1, orig.end + dSrc)) }
        )
      )
    }
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }

  const tick = total <= 0 ? 1 : [1, 2, 5, 10, 15, 30, 60, 120, 300].find((t) => t * pps >= 70) ?? 600

  // ---------------------------------------------------------------- export
  const runExport = async (level: ExportLevel, height: number, name: string) => {
    setExporting(false)
    const j = await sc.videoExport({ segments: segs.map(({ path, start, end, speed, muted }) => ({ path, start, end, speed, muted })), level, height, name })
    setJob(j)
    toast('내보내기를 시작했습니다.')
  }
  useEffect(() => sc.onJob((j) => setJob((cur) => (cur && cur.id === j.id ? j : cur))), [])

  const curSeg = segs[locate(tl).i]
  const targetSegs = sel.size ? segs.filter((s) => sel.has(s.id)) : curSeg ? [curSeg] : []
  const curSpeed = targetSegs.length && targetSegs.every((s) => s.speed === targetSegs[0].speed) ? targetSegs[0].speed : null
  const muted = targetSegs.length > 0 && targetSegs.every((s) => s.muted)
  const shelf = Object.values(clips)

  // ---------------------------------------------------------------- empty
  if (!segs.length) {
    return (
      <div className="dropzone-wrap">
        <div style={{ textAlign: 'center' }}>
          <div className="dropzone" style={{ width: 'min(460px, 60vh)' }}>
            <div className="hero">
              <div className="mosaic">
                <i className="tone-video" />
                <i className="tone-video" />
                <i className="tone-video" />
                <i className="tone-video" />
              </div>
              <div className="big">편집할 영상을 끌어다 놓으세요</div>
              <div className="sub">
                자르기 · 이어 붙이기 · 속도 조절만 하는 아주 쉬운 편집기입니다
                <br />
                여러 개를 넣으면 넣은 순서대로 이어 붙여집니다
              </div>
            </div>
            <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
              <button onClick={async () => addPaths(await sc.pickVideos(), 'replace')}>영상 불러오기</button>
            </div>
          </div>
          {shelf.length > 0 && <Shelf shelf={shelf} onEdit={(p) => addPaths([p], 'replace')} onAppend={(p) => addPaths([p], 'append')} />}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------- editor
  return (
    <div className="vedit tone-video">
      <div className="toolbar">
        <span className="title">영상 편집</span>
        <span className="muted mono">
          {segs.length}개 조각 · {fmt(total)}
        </span>
        <span className="grow" />
        <button className="btn ghost" onClick={undo} disabled={!past.length} title="실행 취소 (Ctrl/⌘+Z)">
          <IcUndo />
        </button>
        <button className="btn ghost" onClick={redo} disabled={!future.length} title="다시 실행">
          <IcRedo />
        </button>
        <button className="btn ghost" onClick={async () => addPaths(await sc.pickVideos(), 'append')}>
          <IcPlus /> 영상 붙이기
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            video.current?.pause()
            setPlaying(false)
            setSegs([])
            setPast([])
            setFuture([])
            setTl(0)
            loadedPath.current = null
          }}
        >
          새로 시작
        </button>
        <button className="btn solid" onClick={() => (video.current?.pause(), setPlaying(false), setExporting(true))}>
          내보내기
        </button>
      </div>

      {job && (
        <div className={cls('vedit-job', job.status)}>
          {job.status === 'running' || job.status === 'queued' ? (
            <>
              <span>내보내는 중 {Math.round((job.files[0]?.progress ?? 0) * 100)}%</span>
              <div className="pbar grow">
                <i style={{ width: `${(job.files[0]?.progress ?? 0) * 100}%` }} />
              </div>
              <button className="btn ghost" onClick={() => sc.cancel(job.id)}>
                취소
              </button>
            </>
          ) : job.status === 'done' ? (
            <>
              <span>
                완료 · {job.files[0]?.message} · {fmtBytes(job.files[0]?.report?.bytesOut)}
              </span>
              <span className="grow" />
              <button className="btn ghost" onClick={() => job.files[0]?.outputs[0] && sc.reveal(job.files[0].outputs[0])}>
                파일 보기
              </button>
              <button className="btn ghost" onClick={() => job.files[0]?.outputs[0] && sc.open(job.files[0].outputs[0])}>
                재생
              </button>
              <button className="btn ghost" onClick={() => setJob(null)}>
                닫기
              </button>
            </>
          ) : (
            <>
              <span className="grow">{job.status === 'cancelled' ? '취소했습니다' : `실패: ${job.files[0]?.message}`}</span>
              <button className="btn ghost" onClick={() => setJob(null)}>
                닫기
              </button>
            </>
          )}
        </div>
      )}

      <div className="vedit-main">
        <div className="vedit-stage">
          <video ref={video} className="vedit-video" playsInline onError={onVideoError} onClick={togglePlay} />
          {curSeg && clips[curSeg.path]?.proxy === 'making' && (
            <div className="vedit-overlay">미리보기 준비 중 {Math.round((proxyPct[curSeg.path] ?? 0) * 100)}%</div>
          )}
        </div>

        <div className="vedit-tools">
          <button className="vplay" onClick={togglePlay} aria-label={playing ? '일시정지' : '재생'}>
            {playing ? <span className="ic-pause" /> : <span className="ic-play" />}
          </button>
          <span className="mono vtime">
            {fmt(tl, true)} <span className="muted">/ {fmt(total, true)}</span>
          </span>
          <span className="sep" />
          <button className="vtool" onClick={split} title="재생 막대 위치에서 자릅니다 (S)">
            <b>자르기</b>
            <span>막대 위치에서 둘로</span>
          </button>
          <button className="vtool" onClick={remove} title="선택한 조각을 지웁니다 (Delete)">
            <b>지우기</b>
            <span>{sel.size ? `선택한 ${sel.size}개` : '막대가 있는 조각'}</span>
          </button>
          <div className="vspeed" title="선택한 조각(없으면 막대가 있는 조각)의 속도">
            <span className="lbl">속도</span>
            <div className="seg">
              {SPEEDS.map((s) => (
                <button key={s} className={cls(curSpeed === s && 'on')} onClick={() => setSpeed(s)}>
                  {s}x
                </button>
              ))}
            </div>
          </div>
          <button className={cls('vtool small', muted && 'on')} onClick={toggleMute} title="선택한 조각의 소리를 끕니다">
            <b>{muted ? '소리 켜기' : '소리 끄기'}</b>
          </button>
        </div>

        <div className="vedit-guide">
          <span>
            <i>1</i> 자를 곳을 누르고 <b>자르기</b>
          </span>
          <span>
            <i>2</i> 필요 없는 조각을 눌러 <b>지우기</b>
          </span>
          <span>
            <i>3</i> 조각을 누르고 <b>속도</b> 선택
          </span>
          <span>
            <i>4</i> 조각을 끌어 순서 바꾸기 · 가장자리를 끌어 길이 조절
          </span>
          <span className="grow" />
          <span className="muted">
            <span className="kbd">Space</span> 재생 <span className="kbd">S</span> 자르기 <span className="kbd">Del</span> 지우기
          </span>
        </div>

        <div className="vedit-timeline" ref={trackWrap}>
          <div className="vtrack-scroll">
            <div className="vtrack" style={{ width: Math.max(trackW, total * pps) }} onMouseDown={(e) => e.target === e.currentTarget && setSel(new Set())}>
              <div className="vruler" onClick={trackClick}>
                {Array.from({ length: Math.floor(total / tick) + 1 }, (_, k) => (
                  <span key={k} style={{ left: k * tick * pps }}>
                    {fmt(k * tick)}
                  </span>
                ))}
              </div>
              <div className="vsegs">
                {segs.map((s, i) => {
                  const clip = clips[s.path]
                  const w = segDur(s) * pps
                  const bgW = clip ? (w * clip.info.duration) / (s.end - s.start) : w
                  return (
                    <div
                      key={s.id}
                      className={cls('vseg', sel.has(s.id) && 'sel', hoverId === s.id && dragId !== s.id && 'over', s.muted && 'muted')}
                      style={{
                        left: offsets.o[i] * pps,
                        width: Math.max(4, w - 2),
                        backgroundImage: clip?.sprite ? `url(${clip.sprite.url})` : undefined,
                        backgroundSize: `${bgW}px 100%`,
                        backgroundPositionX: clip ? `${-(s.start / clip.info.duration) * bgW}px` : undefined
                      }}
                      draggable
                      onDragStart={() => setDragId(s.id)}
                      onDragOver={(e) => (e.preventDefault(), setHoverId(s.id))}
                      onDrop={() => {
                        if (dragId && dragId !== s.id) moveSeg(dragId, s.id)
                        setDragId(null)
                        setHoverId(null)
                      }}
                      onDragEnd={() => (setDragId(null), setHoverId(null))}
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        seek(offsets.o[i] + (e.clientX - r.left) / pps)
                        if (e.shiftKey || e.metaKey || e.ctrlKey) {
                          setSel((x) => {
                            const n = new Set(x)
                            n.has(s.id) ? n.delete(s.id) : n.add(s.id)
                            return n
                          })
                        } else setSel(new Set([s.id]))
                      }}
                      title={`${clip?.name ?? ''} · ${fmt(s.start, true)}–${fmt(s.end, true)}`}
                    >
                      <span className="vseg-label">
                        {i + 1}
                        {s.speed !== 1 && <em>{s.speed}x</em>}
                        {s.muted && <em>무음</em>}
                      </span>
                      {sel.has(s.id) && (
                        <>
                          <span className="vtrim l" onPointerDown={(e) => startTrim(e, s, 'l')} title="끌어서 시작점 조절" />
                          <span className="vtrim r" onPointerDown={(e) => startTrim(e, s, 'r')} title="끌어서 끝점 조절" />
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="vplayhead" style={{ left: tl * pps }}>
                <span />
              </div>
            </div>
          </div>
          <div className="vzoom">
            <span className="muted">확대</span>
            <input type="range" className="range" min={1} max={12} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
          </div>
        </div>
      </div>

      {exporting && <ExportModal total={total} first={segs[0].path} firstClip={clips[segs[0].path]} onClose={() => setExporting(false)} onRun={runExport} />}
    </div>
  )
}

// ---------------------------------------------------------------- pieces
function Shelf({ shelf, onEdit, onAppend }: { shelf: Clip[]; onEdit: (p: string) => void; onAppend: (p: string) => void }) {
  return (
    <div style={{ marginTop: 28, textAlign: 'left' }}>
      <div className="cap" style={{ marginBottom: 8 }}>
        불러온 영상
      </div>
      <div className="vshelf">
        {shelf.map((c) => (
          <div key={c.path} className="vcard" onClick={() => onEdit(c.path)} title="눌러서 편집">
            <div className="th" style={c.sprite ? { backgroundImage: `url(${c.sprite.url})`, backgroundSize: `${c.sprite.frames * 100}% 100%` } : undefined} />
            <div className="nm">{c.name}</div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>
              {fmt(c.info.duration)}
            </div>
            <button
              className="btn ghost"
              onClick={(e) => {
                e.stopPropagation()
                onAppend(c.path)
              }}
            >
              + 붙이기
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ExportModal({ total, first, firstClip, onClose, onRun }: { total: number; first: string; firstClip?: Clip; onClose: () => void; onRun: (l: ExportLevel, h: number, name: string) => void }) {
  const [level, setLevel] = useState<ExportLevel>('balanced')
  const [height, setHeight] = useState(0)
  const [name, setName] = useState(baseName(first).replace(/\.[^.]+$/, '') + '_편집')
  const srcShort = firstClip ? Math.min(firstClip.info.width, firstClip.info.height) : 1080
  const est = (l: (typeof LEVELS)[number]) => {
    const short = Math.min(srcShort, l.cap ?? Infinity, height || Infinity)
    const scale = Math.min(1.6, (short / 1080) ** 1.4)
    return ((l.mbps * scale + 0.16) * total) / 8
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest?.('input')) onRun(level, height, name)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(620px, 94vw)' }}>
        <div className="modal-head">
          내보내기
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <div className="lbl">파일 이름</div>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} style={{ userSelect: 'text' }} />
            <div className="help">원본 영상 폴더의 SUPER CONVERSIONS/V번호 폴더에 MP4로 저장됩니다.</div>
          </div>
          <div className="field">
            <div className="lbl">최적화 수준</div>
            <div className="vlevels">
              {LEVELS.map((l) => (
                <button key={l.id} className={cls('vlevel', level === l.id && 'on')} onClick={() => setLevel(l.id)}>
                  <b>{l.label}</b>
                  <span>{l.desc}</span>
                  <em className="mono">약 {fmtBytes(est(l) * 1024 * 1024)}</em>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="lbl">해상도</div>
            <div className="seg">
              {(
                [
                  [0, firstClip ? `원본 (${firstClip.info.width}×${firstClip.info.height})` : '원본'],
                  [1080, '1080p'],
                  [720, '720p'],
                  [480, '480p']
                ] as [number, string][]
              ).map(([v, l]) => (
                <button key={v} className={cls(height === v && 'on')} onClick={() => setHeight(v)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="help">세로 영상은 짧은 변 기준입니다. 원본보다 크게 늘리지는 않습니다.</div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="muted grow" style={{ fontSize: 11.5 }}>
            길이 {fmt(total)} · 예상 용량은 영상 내용에 따라 달라집니다
          </span>
          <button className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn solid" onClick={() => onRun(level, height, name)}>
            내보내기
          </button>
        </div>
      </div>
    </div>
  )
}
