import { useEffect, useState } from 'react'
import type { Job, Settings, UrlInfo } from '@shared/types'
import { sc } from '../lib/api'
import { cls } from '../lib/util'
import { IcDown, IcX } from '../lib/icons'

interface Props {
  incoming: string[]
  clearIncoming: () => void
  settings: Settings
  setSettings: (s: Settings) => void
  jobs: Job[]
  toast: (m: string) => void
}

const SITES = ['YouTube', 'Instagram', 'TikTok', 'Pinterest', 'Threads', 'X', 'Vimeo']

export default function DownloadView({ incoming, clearIncoming, settings, setSettings, jobs, toast }: Props) {
  const [text, setText] = useState('')
  const [items, setItems] = useState<UrlInfo[]>([])

  const addUrls = async (urls: string[]) => {
    const fresh = urls.filter((u) => !items.some((i) => i.url === u))
    if (!fresh.length) return
    setItems((x) => [...x, ...fresh.map((url) => ({ url, site: '…' }))])
    for (const u of fresh) {
      sc.probeUrl(u).then((info) => setItems((x) => x.map((i) => (i.url === u ? info : i))))
    }
  }

  useEffect(() => {
    if (incoming.length) {
      addUrls(incoming)
      clearIncoming()
    }
  }, [incoming]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const urls = await sc.extractUrls(text)
    if (!urls.length) {
      toast('링크를 찾지 못했습니다.')
      return
    }
    setText('')
    addUrls(urls)
  }

  const start = async () => {
    const urls = items.filter((i) => !i.error).map((i) => i.url)
    if (!urls.length) return
    await sc.startDownload(urls)
    setItems([])
    toast(`${urls.length}개 다운로드를 시작했습니다.`)
  }

  const dl = jobs.filter((j) => j.action === 'download').slice(0, 6)
  const setFmt = async (f: Settings['downloadFormat']) => setSettings(await sc.saveSettings({ downloadFormat: f }))

  return (
    <div className="page tone-video" style={{ maxWidth: 980 }}>
      <h1>영상 다운로드</h1>
      <p className="lead">
        링크를 붙여넣으면 제목과 썸네일을 확인한 뒤 내려받습니다. 저장 위치: <span className="mono">{settings.downloadDir}/SUPER CONVERSIONS/V번호</span>
      </p>
      <div className="paste">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text')
            if (/https?:\/\//.test(t)) {
              e.preventDefault()
              sc.extractUrls(t).then(addUrls)
            }
          }}
          placeholder="여기에 링크를 붙여넣으세요 (여러 개 가능)"
        />
        <button className="go" onClick={submit}>
          <IcDown />
          추가
        </button>
      </div>
      <div className="sites">
        {SITES.map((s) => (
          <span key={s} className="chip">
            {s}
          </span>
        ))}
        <span className="grow" />
        <div className="seg" style={{ width: 360 }}>
          {(
            [
              ['best', '최고화질'],
              ['1080', '1080p'],
              ['720', '720p'],
              ['audio', '소리만 MP3']
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={cls(settings.downloadFormat === v && 'on')} onClick={() => setFmt(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {items.length > 0 && (
        <>
          <div className="links">
            {items.map((i) => (
              <div key={i.url} className="link">
                <div className="th">{i.thumbnail ? <img src={i.thumbnail} alt="" /> : i.site}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="cap" style={{ color: 'var(--ink-2)' }}>
                    {i.site}
                  </div>
                  <div className="tt">{i.title ?? (i.error ? '확인 실패' : '정보 확인 중…')}</div>
                  <div className={cls('muted')} style={{ fontSize: 11.5, color: i.error ? 'var(--err)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {i.error ?? i.url}
                  </div>
                </div>
                <button className="btn ghost" onClick={() => setItems((x) => x.filter((y) => y.url !== i.url))} aria-label="제거">
                  <IcX />
                </button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <span className="muted">YouTube·Instagram이 로그인을 요구하면 설정 › 다운로드에서 브라우저 쿠키를 지정해 주세요.</span>
            <span className="grow" />
            <button className="btn solid big" onClick={start}>
              {items.filter((i) => !i.error).length}개 다운로드
            </button>
          </div>
        </>
      )}

      {dl.length > 0 && (
        <>
          <div className="cap" style={{ margin: '32px 0 10px' }}>
            최근 다운로드
          </div>
          {dl.map((j) => (
            <div key={j.id} className="job tone-video">
              {j.files.map((f, k) => (
                <div key={k} className="job-file">
                  <span className="fn">{f.outputs[0]?.split(/[\\/]/).pop() ?? f.input}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className={cls('chip', f.status === 'done' && 'on', f.status === 'error' && 'warn')}>
                      <span className="dot" />
                      {f.status === 'running' ? `${Math.round(f.progress * 100)}%` : f.status === 'done' ? '완료' : f.status === 'error' ? '실패' : '대기'}
                    </span>
                    {f.outputs[0] && (
                      <button className="btn ghost" onClick={() => sc.reveal(f.outputs[0])}>
                        보기
                      </button>
                    )}
                  </span>
                  {f.status === 'running' && (
                    <div className="pbar">
                      <i style={{ width: `${f.progress * 100}%` }} />
                    </div>
                  )}
                  {f.message && f.status !== 'done' && <span className={cls('msg', f.status === 'error' && 'err')}>{f.message}</span>}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
      <p className="muted" style={{ marginTop: 28, fontSize: 11.5 }}>
        다운로드한 콘텐츠의 저작권은 원저작자에게 있습니다. 본인 콘텐츠이거나 사용 허락을 받은 경우에만 활용해 주세요.
      </p>
    </div>
  )
}
