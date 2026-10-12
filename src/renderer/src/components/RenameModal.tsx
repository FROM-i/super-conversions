import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_RULE, planRename, type RenameItem, type RenameRule } from '@shared/rename'
import { sc } from '../lib/api'
import { baseName, cls } from '../lib/util'
import { Field, Num, Seg, Text, Toggle } from './Fields'

const RULE_KEY = 'sc.renameRule'
const loadRule = (): RenameRule => {
  try {
    return { ...DEFAULT_RULE, ...JSON.parse(localStorage.getItem(RULE_KEY) ?? '{}') }
  } catch {
    return DEFAULT_RULE
  }
}

interface Props {
  items: RenameItem[]
  onClose: () => void
  onDone: (renamed: { from: string; to: string }[]) => void
  toast: (m: string) => void
}

/** Batch rename with live preview. One item → simple name field; many → rules with auto numbering. */
export default function RenameModal({ items, onClose, onDone, toast }: Props) {
  const single = items.length === 1
  const [rule, setRule] = useState<RenameRule>(() => {
    const r = loadRule()
    // a fresh batch defaults to "새 이름 + 번호"
    return single ? r : { ...r, mode: 'pattern', pattern: r.pattern.includes('{n}') ? r.pattern : '{name}_{n}' }
  })
  const [name, setName] = useState(() => baseName(items[0]?.path ?? '').replace(/\.[^.]+$/, ''))
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const set = (p: Partial<RenameRule>) => setRule((r) => ({ ...r, ...p }))

  const plan = useMemo(() => planRename(items, single ? { ...DEFAULT_RULE, pattern: name, mode: 'pattern' } : rule, (p) => existing.has(p.toLowerCase())), [items, rule, name, single, existing])

  // ask main which targets already exist on disk (for collision warnings)
  useEffect(() => {
    const t = setTimeout(async () => {
      const ex = await sc.exists(plan.map((r) => r.to))
      setExisting(new Set(ex.map((p) => p.toLowerCase())))
    }, 120)
    return () => clearTimeout(t)
  }, [plan.map((r) => r.to).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const changed = plan.filter((r) => r.from !== r.to)
  const errors = plan.filter((r) => r.error)

  const apply = async () => {
    if (errors.length || !changed.length) return
    setBusy(true)
    try {
      if (!single) localStorage.setItem(RULE_KEY, JSON.stringify(rule))
    } catch {
      /* ignore */
    }
    const res = single ? await sc.renameOne(items[0].path, plan[0].newName) : await sc.renameBatch(items, rule)
    setBusy(false)
    if (res.renamed.length) onDone(res.renamed)
    if (res.errors.length) toast(`${res.errors.length}개 실패: ${res.errors[0].error}`)
    else {
      toast(`${res.renamed.length}개 이름을 바꿨습니다 · Ctrl/⌘+Z로 되돌리기`)
      onClose()
    }
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest?.('textarea')) {
        e.preventDefault()
        apply()
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: single ? 'min(480px, 92vw)' : 'min(800px, 94vw)' }}>
        <div className="modal-head">
          {single ? '이름 변경' : `${items.length}개 파일 이름 일괄 변경`}
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="modal-body" style={single ? undefined : { display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20 }}>
          {single ? (
            <Field label="새 이름" help={plan[0]?.error ?? `확장자(${baseName(items[0].path).match(/\.[^.]+$/)?.[0] ?? ''})는 그대로 유지됩니다.`}>
              <input className="inp" autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} style={{ userSelect: 'text' }} />
            </Field>
          ) : (
            <div>
              <Field label="방식">
                <Seg value={rule.mode} options={[['pattern', '새 이름 + 번호'], ['replace', '찾아 바꾸기'], ['affix', '앞뒤에 붙이기']]} onChange={(v) => set({ mode: v })} />
              </Field>
              {rule.mode === 'pattern' && (
                <>
                  <Field label="이름 규칙" help={<>{'{n}'} 번호 · {'{name}'} 원래 이름 · {'{date}'} 날짜 · {'{time}'} 시각</>}>
                    <Text value={rule.pattern} onChange={(v) => set({ pattern: v })} placeholder="예: 제안서_{n}" />
                    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                      {['{name}_{n}', '{n}_{name}', '스크린샷_{date}_{n}', '이미지_{n}'].map((p) => (
                        <button key={p} className="chip" onClick={() => set({ pattern: p })}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="번호">
                    <div className="row">
                      <Num value={rule.start} onChange={(v) => set({ start: v ?? 1 })} min={0} />
                      <span className="muted" style={{ whiteSpace: 'nowrap' }}>부터</span>
                      <Num value={rule.step} onChange={(v) => set({ step: v ?? 1 })} min={1} />
                      <span className="muted" style={{ whiteSpace: 'nowrap' }}>씩</span>
                    </div>
                    <Seg value={rule.pad} options={[[1, '1, 2, 3'], [2, '01, 02'], [3, '001, 002'], [4, '0001']]} onChange={(v) => set({ pad: v })} />
                  </Field>
                </>
              )}
              {rule.mode === 'replace' && (
                <>
                  <Field label="찾을 글자">
                    <Text value={rule.find} onChange={(v) => set({ find: v })} placeholder="예: Screenshot" />
                  </Field>
                  <Field label="바꿀 글자" help="비워 두면 찾은 글자를 지웁니다.">
                    <Text value={rule.replace} onChange={(v) => set({ replace: v })} placeholder="예: 스크린샷" />
                  </Field>
                  <Toggle on={rule.caseSensitive} onChange={(v) => set({ caseSensitive: v })} label="대소문자 구분" />
                </>
              )}
              {rule.mode === 'affix' && (
                <>
                  <Field label="앞에 붙이기">
                    <Text value={rule.prefix} onChange={(v) => set({ prefix: v })} placeholder="예: 2026_" />
                  </Field>
                  <Field label="뒤에 붙이기">
                    <Text value={rule.suffix} onChange={(v) => set({ suffix: v })} placeholder="예: _최종" />
                  </Field>
                </>
              )}
              <Field label="번호 매기는 순서">
                <Seg value={rule.order} options={[['current', '지금 순서'], ['name', '이름순'], ['date', '날짜순']]} onChange={(v) => set({ order: v })} />
              </Field>
            </div>
          )}
          {!single && (
            <div style={{ minWidth: 0 }}>
              <div className="cap" style={{ marginBottom: 8 }}>
                미리보기 · {changed.length}개 변경{errors.length ? ` · ${errors.length}개 문제` : ''}
              </div>
              <div className="rename-preview">
                {plan.map((r) => (
                  <div key={r.from} className={cls('rp-row', r.error && 'err', r.from === r.to && 'same')}>
                    <span className="old" title={baseName(r.from)}>
                      {baseName(r.from)}
                    </span>
                    <span className="arr">→</span>
                    <span className="new" title={r.error ?? r.newName}>
                      {r.newName}
                      {r.error && <em> · {r.error}</em>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="muted grow" style={{ fontSize: 11.5 }}>
            원본 파일의 이름이 실제로 바뀝니다. 바로 뒤에는 되돌리기(Ctrl/⌘+Z)가 됩니다.
          </span>
          <button className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn solid" onClick={apply} disabled={busy || !!errors.length || !changed.length}>
            {busy ? '바꾸는 중…' : single ? '바꾸기' : `${changed.length}개 바꾸기`}
          </button>
        </div>
      </div>
    </div>
  )
}
