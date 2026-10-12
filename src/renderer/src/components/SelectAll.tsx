import { IcCheck } from '../lib/icons'
import { cls } from '../lib/util'

/** Toolbar "select all" checkbox with an indeterminate (partial) state. */
export default function SelectAll({ total, selected, onAll, onNone }: { total: number; selected: number; onAll: () => void; onNone: () => void }) {
  const state = selected === 0 ? 'none' : selected >= total ? 'all' : 'some'
  return (
    <div className="select-all">
      <button className={cls('cbox', state !== 'none' && 'on')} onClick={() => (state === 'all' ? onNone() : onAll())} aria-label={state === 'all' ? '전체 해제' : '전체 선택'} role="checkbox" aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}>
        {state === 'all' ? <IcCheck /> : state === 'some' ? <i className="dash" /> : null}
      </button>
      <span className="lbl" onClick={() => (state === 'all' ? onNone() : onAll())}>
        {selected ? `${selected}개 선택` : '전체 선택'}
      </span>
      {selected > 0 && (
        <button className="btn ghost" style={{ height: 26, padding: '0 8px' }} onClick={onNone}>
          해제
        </button>
      )}
    </div>
  )
}
