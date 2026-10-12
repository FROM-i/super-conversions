import { ACTION_BY_ID } from '@shared/formats'
import type { Job, QualityReport } from '@shared/types'
import { sc } from '../lib/api'
import { baseName, cls, fmtBytes, toneOf } from '../lib/util'
import { IcOpen, IcX } from '../lib/icons'

const STATUS: Record<string, string> = { queued: '대기', running: '진행 중', done: '완료', error: '실패', cancelled: '취소됨' }

function Report({ r }: { r?: QualityReport }) {
  if (!r) return null
  const chips: { t: string; c?: string; title?: string }[] = []
  if (r.engine) chips.push({ t: r.engine, c: r.fidelity === 'high' ? 'hi' : r.fidelity === 'low' ? 'lo' : undefined, title: r.fidelity === 'high' ? '서식 보존 높음' : r.fidelity === 'low' ? '서식 보존 낮음' : '서식 보존 보통' })
  if (r.fidelity) chips.push({ t: r.fidelity === 'high' ? '서식 보존 ◎' : r.fidelity === 'medium' ? '서식 보존 ○' : '서식 보존 △', c: r.fidelity === 'high' ? 'hi' : r.fidelity === 'low' ? 'lo' : undefined })
  if (r.totalFonts !== undefined) chips.push({ t: `폰트 포함 ${r.embeddedFonts}/${r.totalFonts}`, c: r.embeddedFonts === r.totalFonts ? 'hi' : 'lo', title: r.nonEmbedded?.join(', ') })
  if (r.missingFonts?.length) chips.push({ t: `PC에 없는 폰트 ${r.missingFonts.length}`, c: 'lo', title: r.missingFonts.join(', ') })
  if (r.pagesOut !== undefined) chips.push({ t: r.pagesIn ? `${r.pagesIn} → ${r.pagesOut}쪽` : `${r.pagesOut}쪽`, c: r.pagesIn && r.pagesIn !== r.pagesOut ? 'lo' : undefined })
  if (r.bytesIn !== undefined && r.bytesOut !== undefined) {
    const pct = Math.round((1 - r.bytesOut / r.bytesIn) * 100)
    chips.push({ t: `${fmtBytes(r.bytesIn)} → ${fmtBytes(r.bytesOut)}${pct > 0 ? ` (−${pct}%)` : ''}`, c: pct > 0 ? 'hi' : undefined })
  }
  return (
    <div className="report">
      {chips.map((c, i) => (
        <span key={i} className={cls('chip', c.c)} title={c.title}>
          {c.t}
        </span>
      ))}
      {r.notes?.map((n, i) => (
        <span key={'n' + i} className="msg" style={{ width: '100%', fontSize: 11.5, color: 'var(--muted)' }}>
          · {n}
        </span>
      ))}
    </div>
  )
}

export default function JobsView({ jobs }: { jobs: Job[] }) {
  return (
    <div className="page">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <h1>작업</h1>
          <p className="lead">변환 결과는 원본 폴더의 SUPER CONVERSIONS/V번호 폴더에 저장됩니다. 실행할 때마다 V1, V2, V3…가 새로 만들어집니다.</p>
        </div>
        {jobs.some((j) => j.status !== 'running') && (
          <button className="btn ghost" onClick={() => sc.clearJobs()}>
            완료 항목 지우기
          </button>
        )}
      </div>
      {!jobs.length && <div className="empty-state">아직 작업이 없습니다.</div>}
      {jobs.map((j) => {
        const def = j.action === 'download' ? null : ACTION_BY_ID[j.action]
        const tone = def ? toneOf(def.category) : 'tone-video'
        const done = j.files.filter((f) => f.status === 'done').length
        return (
          <div key={j.id} className={cls('job', tone)}>
            <div className="job-head">
              <div className="sq">{def ? def.label : 'DL'}</div>
              <div className="grow">
                <div className="t">
                  {def ? `${def.label} · ${def.hint}` : '영상 다운로드'} {j.title && <span className="muted">· {j.title}</span>}
                </div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {STATUS[j.status]} · {done}/{j.files.length} · {new Date(j.createdAt).toLocaleTimeString()}
                </div>
              </div>
              {j.status === 'running' && (
                <button className="btn ghost" onClick={() => sc.cancel(j.id)}>
                  <IcX /> 취소
                </button>
              )}
              {j.outDirs.map((d) => (
                <button key={d} className="btn" onClick={() => sc.open(d)} title={d}>
                  <IcOpen /> {baseName(d)}
                </button>
              ))}
            </div>
            {j.files.map((f, i) => (
              <div key={i} className="job-file">
                <span className="fn" title={f.input}>
                  {j.action === 'download' ? f.input : baseName(f.input)}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <span className={cls('chip', f.status === 'done' && 'on', f.status === 'error' && 'warn')}>
                    <span className="dot" />
                    {f.status === 'running' ? `${Math.round(f.progress * 100)}%` : STATUS[f.status]}
                  </span>
                  {f.outputs.length > 0 && (
                    <button className="btn ghost" onClick={() => (f.outputs.length === 1 ? sc.reveal(f.outputs[0]) : sc.open(f.outputs[0].replace(/[\\/][^\\/]*$/, '')))}>
                      {f.outputs.length > 1 ? `${f.outputs.length}개 파일` : '보기'}
                    </button>
                  )}
                </span>
                {f.status === 'running' && (
                  <div className="pbar">
                    <i style={{ width: `${f.progress * 100}%` }} />
                  </div>
                )}
                {f.message && <span className={cls('msg', f.status === 'error' && 'err')}>{f.message}</span>}
                <Report r={f.report} />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
