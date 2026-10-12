import { useEffect, useRef, useState } from 'react'
import type { SignatureMeta } from '@shared/types'
import { sc } from '../lib/api'
import { Field, Seg, Text, Toggle } from './Fields'

type Mode = 'draw' | 'image' | 'type'

export default function SignatureModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<Mode>('draw')
  const [kind, setKind] = useState<SignatureMeta['kind']>('signature')
  const [name, setName] = useState('내 서명')
  const [img, setImg] = useState<string | null>(null)
  const [removeBg, setRemoveBg] = useState(true)
  const [typed, setTyped] = useState('')
  const [font, setFont] = useState<'pen' | 'sans'>('pen')
  const [ink, setInk] = useState('#111111')
  const [busy, setBusy] = useState(false)
  const pad = useRef<HTMLCanvasElement>(null)
  const drawn = useRef(false)

  useEffect(() => {
    const c = pad.current
    if (!c || mode !== 'draw') return
    const dpr = window.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
    c.width = r.width * dpr
    c.height = r.height * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    let last: { x: number; y: number; t: number } | null = null
    let w = 3
    const pos = (e: PointerEvent) => ({ x: e.offsetX, y: e.offsetY, t: performance.now() })
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId)
      last = pos(e)
      w = 3
    }
    const move = (e: PointerEvent) => {
      if (!last) return
      const p = pos(e)
      const dist = Math.hypot(p.x - last.x, p.y - last.y)
      const v = dist / Math.max(1, p.t - last.t)
      // faster stroke → thinner line (pen feel)
      const target = Math.max(1.4, Math.min(4.2, 4.2 - v * 1.6))
      w = w * 0.7 + target * 0.3
      ctx.strokeStyle = ink
      ctx.lineWidth = e.pressure && e.pointerType === 'pen' ? 1 + e.pressure * 4 : w
      ctx.beginPath()
      ctx.moveTo(last.x, last.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      last = p
      drawn.current = true
    }
    const up = () => (last = null)
    c.addEventListener('pointerdown', down)
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
    c.addEventListener('pointerleave', up)
    return () => {
      c.removeEventListener('pointerdown', down)
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.removeEventListener('pointerleave', up)
    }
  }, [mode, ink])

  const clear = () => {
    const c = pad.current
    if (!c) return
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    drawn.current = false
  }

  const typedPng = (): string => {
    const c = document.createElement('canvas')
    const size = 120
    const ctx = c.getContext('2d')!
    const family = font === 'pen' ? "'Nanum Pen Script'" : "'Pretendard'"
    ctx.font = `${font === 'pen' ? 400 : 700} ${size}px ${family}`
    const w = Math.ceil(ctx.measureText(typed).width) + 40
    c.width = w
    c.height = size * 1.5
    ctx.font = `${font === 'pen' ? 400 : 700} ${size}px ${family}`
    ctx.fillStyle = ink
    ctx.textBaseline = 'middle'
    ctx.fillText(typed, 20, c.height / 2)
    return c.toDataURL('image/png')
  }

  const save = async () => {
    let data: string | null = null
    let bg = false
    if (mode === 'draw') data = drawn.current ? pad.current!.toDataURL('image/png') : null
    else if (mode === 'image') {
      data = img
      bg = removeBg
    } else data = typed.trim() ? typedPng() : null
    if (!data) return
    setBusy(true)
    await sc.addSignature(name || (kind === 'seal' ? '직인' : '서명'), kind, data, bg)
    setBusy(false)
    onSaved()
    onClose()
  }

  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          서명·직인 등록
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="modal-body">
          <div className="row" style={{ gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="이름">
                <Text value={name} onChange={setName} />
              </Field>
            </div>
            <div style={{ width: 200 }}>
              <Field label="종류">
                <Seg value={kind} options={[['signature', '서명'], ['seal', '직인·도장']]} onChange={(v) => (setKind(v), name === '내 서명' || name === '회사 직인' ? setName(v === 'seal' ? '회사 직인' : '내 서명') : null)} />
              </Field>
            </div>
          </div>
          <Field label="만드는 방법">
            <Seg value={mode} options={[['draw', '직접 그리기'], ['image', '이미지 불러오기'], ['type', '타이핑']]} onChange={setMode} />
          </Field>
          {mode !== 'image' && (
            <div className="row" style={{ margin: '4px 0 10px' }}>
              <span className="cap">잉크</span>
              {['#111111', '#1d3fd6', '#d42a2a'].map((c) => (
                <button key={c} className={`swatch ${ink === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setInk(c)} aria-label={c} />
              ))}
            </div>
          )}
          {mode === 'draw' && (
            <>
              <canvas ref={pad} className="pad" />
              <div className="row" style={{ marginTop: 8 }}>
                <span className="muted">마우스·트랙패드·펜으로 서명하세요.</span>
                <span className="grow" />
                <button className="btn ghost" onClick={clear}>
                  지우기
                </button>
              </div>
            </>
          )}
          {mode === 'image' && (
            <>
              <div className="pad" style={{ display: 'grid', placeItems: 'center', cursor: 'pointer' }} onClick={async () => setImg(await sc.pickImage())}>
                {img ? <img src={img} alt="" style={{ maxWidth: '90%', maxHeight: 200 }} /> : <span className="muted">클릭해서 서명·도장 사진 선택 (종이에 찍어 촬영한 사진도 OK)</span>}
              </div>
              <Toggle on={removeBg} onChange={setRemoveBg} label="흰 배경 자동 제거" help="종이 위 서명·도장 사진의 흰 배경을 투명하게 만듭니다." />
            </>
          )}
          {mode === 'type' && (
            <>
              <Field label="서명 문구">
                <Text value={typed} onChange={setTyped} placeholder="예: 민지홍" />
              </Field>
              <Field label="서체">
                <Seg value={font} options={[['pen', '손글씨 (나눔손글씨 펜)'], ['sans', '고딕 (Pretendard)']]} onChange={setFont} />
              </Field>
              <div className="pad" style={{ display: 'grid', placeItems: 'center', fontFamily: font === 'pen' ? "'Nanum Pen Script'" : 'Pretendard', fontWeight: font === 'pen' ? 400 : 700, fontSize: 64, color: ink }}>
                {typed || ' '}
              </div>
            </>
          )}
          <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            서명은 이 컴퓨터의 보안 저장소(macOS 키체인 / Windows 데이터 보호)로 암호화되어 저장됩니다. 공인인증서 기반 전자서명이 아닌, 문서에 보이는 서명 이미지입니다.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn solid" onClick={save} disabled={busy}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
