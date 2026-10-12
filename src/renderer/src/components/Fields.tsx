import type { ReactNode } from 'react'
import type { Anchor } from '@shared/types'
import { cls } from '../lib/util'

export function Field({ label, help, children, right }: { label: ReactNode; help?: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="field">
      <div className="lbl">
        <span>{label}</span>
        {right && <span className="muted mono">{right}</span>}
      </div>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  )
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T | undefined; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={String(v)} className={cls(value === v && 'on')} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ on, onChange, label, help }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; help?: ReactNode }) {
  return (
    <div className="field">
      <div className={cls('toggle', on && 'on')} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
        <span className="lbl" style={{ fontSize: 11.5, fontWeight: 500 }}>
          {label}
        </span>
        <span className="sw" />
      </div>
      {help && <div className="help">{help}</div>}
    </div>
  )
}

export function Num({ value, onChange, min, max, step, suffix, placeholder }: { value?: number; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; suffix?: string; placeholder?: string }) {
  return (
    <div className="row">
      <input
        className="inp mono"
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      {suffix && <span className="muted" style={{ whiteSpace: 'nowrap' }}>{suffix}</span>}
    </div>
  )
}

export function Text({ value, onChange, placeholder, type = 'text' }: { value?: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input className="inp" type={type} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ userSelect: 'text' }} />
}

export function Range({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <input className="range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
}

const ANCHORS: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
export function Anchor9({ value, onChange }: { value?: Anchor; onChange: (a: Anchor) => void }) {
  return (
    <div className="anchor9">
      {ANCHORS.map((a) => (
        <button key={a} className={cls(value === a && 'on')} onClick={() => onChange(a)} aria-label={a} />
      ))}
    </div>
  )
}
