// Frameless grid that pops up at the cursor when launched from Explorer / Finder.
import { useEffect, useState } from 'react'
import { ACTION_BY_ID } from '@shared/formats'
import type { Job, Settings } from '@shared/types'
import { sc } from '../lib/api'
import GridMenu, { type GridPick } from '../components/GridMenu'

export default function Overlay() {
  const [files, setFiles] = useState<string[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [job, setJob] = useState<Job | null>(null)

  useEffect(() => {
    document.body.classList.add('overlay-body')
    sc.getSettings().then(setSettings)
    const off1 = sc.onOverlayFiles(setFiles)
    const off2 = sc.onJob((j) => setJob((cur) => (cur && cur.id === j.id ? j : cur)))
    const off3 = sc.onOverlayBlur(() => setJob((cur) => (cur && cur.status === 'running' ? cur : (sc.overlayClose(), cur))))
    return () => {
      off1()
      off2()
      off3()
    }
  }, [])

  useEffect(() => {
    if (job && job.status !== 'running' && job.status !== 'queued') {
      const t = setTimeout(() => sc.overlayClose(), job.status === 'done' ? 5000 : 12000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [job])

  const pick = async (g: GridPick) => {
    const runNow = (settings?.overlayRunsImmediately ?? true) !== g.immediate && g.action !== 'pdf.edit'
    if (!runNow) {
      sc.overlayOpenMain(g.files, g.action)
      return
    }
    const j = await sc.start(g.action, g.files)
    setJob(j)
  }

  if (!files.length) return null
  const total = job ? job.files.reduce((s, f) => s + (f.status === 'done' || f.status === 'error' ? 1 : f.progress), 0) / job.files.length : 0
  const failed = job?.files.filter((f) => f.status === 'error') ?? []

  const center = job ? (
    <>
      <svg className="ring" viewBox="0 0 100 100" preserveAspectRatio="none">
        <rect x="0" y="0" width="100" height="100" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - total * 100} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="hint">{job.action !== 'download' ? ACTION_BY_ID[job.action].label : ''}</span>
      <span className="lab">
        {job.status === 'running' || job.status === 'queued' ? `${Math.round(total * 100)}%` : failed.length ? 'CHECK' : 'DONE'}
      </span>
      <span className="count" title={failed[0]?.message}>
        {job.status === 'done' && job.outDirs[0] ? (
          <button style={{ textDecoration: 'underline', color: 'inherit' }} onClick={() => (sc.open(job.outDirs[0]), sc.overlayClose())}>
            폴더 열기 ↗
          </button>
        ) : failed.length ? (
          `${failed.length}개 실패`
        ) : (
          `${job.files.length}개 처리 중`
        )}
      </span>
    </>
  ) : undefined

  return (
    <div className="overlay-root">
      <GridMenu files={files} cell={112} onPick={pick} onClose={() => sc.overlayClose()} center={center} locked={!!job && job.status === 'running'} />
      {failed.length > 0 && (
        <button className="toast" style={{ bottom: 6, fontSize: 11 }} onClick={() => sc.overlayOpenMain(files)}>
          {failed[0].message?.slice(0, 80)} — 자세히
        </button>
      )}
    </div>
  )
}
