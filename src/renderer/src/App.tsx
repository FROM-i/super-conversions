import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActionId } from '@shared/formats'
import type { EngineStatus, Job, Settings, UpdateState } from '@shared/types'
import { sc } from './lib/api'
import { cls } from './lib/util'
import { IcDown, IcGear, IcGrid, IcJobs, IcPdf } from './lib/icons'
import ConvertView from './views/ConvertView'
import JobsView from './views/JobsView'
import DownloadView from './views/DownloadView'
import SettingsView from './views/SettingsView'
import PdfEditor from './views/PdfEditor'

type View = 'convert' | 'download' | 'edit' | 'jobs' | 'settings'

export default function App() {
  const [view, setView] = useState<View>('convert')
  const [files, setFiles] = useState<string[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [engines, setEngines] = useState<EngineStatus | null>(null)
  const [platform, setPlatform] = useState('')
  const [dragging, setDragging] = useState(false)
  const [editPath, setEditPath] = useState<string | null>(null)
  const [links, setLinks] = useState<string[]>([])
  const [pendingAction, setPendingAction] = useState<ActionId | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [upd, setUpd] = useState<UpdateState | null>(null)
  const toastT = useRef<number>(0)
  const dragDepth = useRef(0)

  const toast = useCallback((m: string) => {
    setToastMsg(m)
    clearTimeout(toastT.current)
    toastT.current = window.setTimeout(() => setToastMsg(null), 3600)
  }, [])

  const refreshEngines = useCallback(() => {
    setEngines(null)
    sc.engineStatus().then(setEngines)
  }, [])

  useEffect(() => {
    sc.getSettings().then(setSettings)
    sc.appInfo().then((i) => setPlatform(i.platform))
    sc.jobs().then(setJobs)
    refreshEngines()
    sc.updateState().then(setUpd)
    const offU = sc.onUpdate(setUpd)
    const off1 = sc.onJob((j) => setJobs((xs) => [j, ...xs.filter((x) => x.id !== j.id)].sort((a, b) => b.createdAt - a.createdAt)))
    const off2 = sc.onMainLoad((fs, action) => {
      setFiles((x) => [...new Set([...x, ...fs])])
      setView('convert')
      if (action === 'pdf.edit' && fs[0]) {
        setEditPath(fs[0])
        setView('edit')
      } else if (action) setPendingAction(action)
    })
    const openEd = (e: Event) => {
      setEditPath((e as CustomEvent<string>).detail)
      setView('edit')
    }
    window.addEventListener('sc-open-editor', openEd)
    return () => {
      off1()
      off2()
      offU()
      window.removeEventListener('sc-open-editor', openEd)
    }
  }, [refreshEngines])

  // theme
  useEffect(() => {
    if (!settings) return
    const r = document.documentElement
    if (settings.theme === 'system') r.removeAttribute('data-theme')
    else r.setAttribute('data-theme', settings.theme)
  }, [settings?.theme]) // eslint-disable-line react-hooks/exhaustive-deps

  // global drag & drop + paste
  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepth.current++
      setDragging(true)
    }
    const leave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const drop = async (e: DragEvent) => {
      dragDepth.current = 0
      setDragging(false)
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      const paths = [...e.dataTransfer.files].map((f) => sc.pathForFile(f)).filter(Boolean)
      const expanded = await sc.expand(paths)
      if (!expanded.length) return toast('지원하는 파일이 없습니다.')
      setFiles((x) => [...new Set([...x, ...expanded])])
      if (view !== 'convert' && view !== 'edit') setView('convert')
      if (view === 'edit' && expanded.length === 1 && /\.pdf$/i.test(expanded[0])) setEditPath(expanded[0])
    }
    const paste = async (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea')) return
      const t = e.clipboardData?.getData('text') ?? ''
      const urls = await sc.extractUrls(t)
      if (urls.length) {
        setLinks(urls)
        setView('download')
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [view, toast])

  if (!settings) return null
  const running = jobs.filter((j) => j.status === 'running').length
  const officeOn = engines && (engines.office.word || engines.office.excel || engines.office.powerpoint)

  const NAV: [View, string, React.ReactElement][] = [
    ['convert', '변환', <IcGrid key="g" />],
    ['download', '영상 다운로드', <IcDown key="d" />],
    ['edit', 'PDF 편집', <IcPdf key="p" />],
    ['jobs', '작업 · 결과', <IcJobs key="j" />]
  ]

  return (
    <div className={cls('app', `platform-${platform}`, dragging && 'dragging')}>
      <header className="topbar drag">
        <div className="wordmark">
          <span className="sq">
            <i style={{ background: 'var(--doc)' }} />
            <i style={{ background: 'var(--image)' }} />
            <i style={{ background: 'var(--pdf)' }} />
            <i style={{ background: 'var(--video)' }} />
          </span>
          SUPER CONVERSIONS
        </div>
        <div className="chips nodrag">
          {upd?.status === 'downloading' && (
            <span className="chip" title="백그라운드에서 내려받는 중">
              <span className="dot" />v{upd.version} 내려받는 중 {Math.round((upd.progress ?? 0) * 100)}%
            </span>
          )}
          {upd?.status === 'ready' && (
            <button className="chip update" onClick={() => sc.installUpdate()} title="지금 재시작해서 적용합니다. 나중에 앱을 닫으면 자동 적용됩니다.">
              <span className="dot" />v{upd.version} 업데이트 · 재시작
            </button>
          )}
          {engines ? (
            <>
              <span className={cls('chip', officeOn ? 'on' : engines.libreoffice ? 'warn' : '')} title={officeOn ? 'MS Office로 원본 서식 그대로 변환' : engines.libreoffice ? 'LibreOffice로 변환 (서식 일부 차이)' : '문서 변환 엔진 없음'}>
                <span className="dot" />
                {officeOn ? 'Office' : engines.libreoffice ? 'LibreOffice' : 'Office 없음'}
              </span>
              {platform === 'win32' && (
                <span className={cls('chip', engines.hancom ? 'on' : 'warn')}>
                  <span className="dot" />
                  {engines.hancom ? '한컴' : '한컴 없음 · 내장'}
                </span>
              )}
              <span className={cls('chip', engines.hwEncoders.length ? 'on' : '')}>
                <span className="dot" />
                {engines.hwEncoders.length ? 'GPU 가속' : 'CPU 인코딩'}
              </span>
            </>
          ) : (
            <span className="chip">엔진 확인 중…</span>
          )}
        </div>
      </header>
      <nav className="rail">
        {NAV.map(([v, label, icon]) => (
          <button key={v} className={cls(view === v && 'active')} onClick={() => setView(v)} aria-label={label}>
            {icon}
            {v === 'jobs' && running > 0 && <span className="badge">{running}</span>}
            <span className="tip">{label}</span>
          </button>
        ))}
        <span className="spacer" />
        <button className={cls(view === 'settings' && 'active')} onClick={() => setView('settings')} aria-label="설정">
          <IcGear />
          <span className="tip">설정</span>
        </button>
      </nav>
      <main className="view">
        {view === 'convert' && (
          <ConvertView
            files={files}
            setFiles={setFiles}
            jobs={jobs}
            settings={settings}
            setSettings={setSettings}
            engines={engines}
            pendingAction={pendingAction}
            clearPendingAction={() => setPendingAction(null)}
            onOpenEditor={(p) => {
              setEditPath(p)
              setView('edit')
            }}
            onLinks={(u) => {
              setLinks(u)
              setView('download')
            }}
            toast={toast}
          />
        )}
        {view === 'download' && <DownloadView incoming={links} clearIncoming={() => setLinks([])} settings={settings} setSettings={setSettings} jobs={jobs} toast={toast} />}
        {view === 'edit' && <PdfEditor path={editPath} settings={settings} onClose={() => (setEditPath(null), setView('convert'))} toast={toast} />}
        {view === 'jobs' && <JobsView jobs={jobs} />}
        {view === 'settings' && <SettingsView settings={settings} setSettings={setSettings} engines={engines} refreshEngines={refreshEngines} toast={toast} />}
        {dragging && <div className="drop-veil">놓으면 추가됩니다</div>}
      </main>
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}
