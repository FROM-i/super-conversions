import { useEffect, useState } from 'react'
import type { EngineStatus, Settings } from '@shared/types'
import { sc } from '../lib/api'
import { cls } from '../lib/util'
import { Field, Seg, Text, Toggle } from '../components/Fields'
import SignatureModal from '../components/SignatureModal'
import { IcPlus, IcTrash } from '../lib/icons'

type Sec = 'sign' | 'library' | 'output' | 'engine' | 'fonts' | 'download' | 'system'
const SECS: [Sec, string][] = [
  ['sign', '서명·직인'],
  ['library', '스크린샷 라이브러리'],
  ['output', '저장 규칙'],
  ['engine', '변환 엔진'],
  ['fonts', '폰트'],
  ['download', '다운로드'],
  ['system', '연동·업데이트']
]

interface Props {
  settings: Settings
  setSettings: (s: Settings) => void
  engines: EngineStatus | null
  refreshEngines: () => void
  toast: (m: string) => void
}

export default function SettingsView({ settings, setSettings, engines, refreshEngines, toast }: Props) {
  const [sec, setSec] = useState<Sec>('sign')
  const [modal, setModal] = useState(false)
  const [sigImgs, setSigImgs] = useState<Record<string, string>>({})
  const [info, setInfo] = useState<{ version: string; platform: string } | null>(null)
  const [folders, setFolders] = useState<{ path: string; nameFilter: boolean; label: string }[]>([])
  useEffect(() => {
    if (sec === 'library') sc.libraryFolders().then(setFolders)
  }, [sec, settings.libraryExtraFolders])
  const save = async (p: Partial<Settings>) => setSettings(await sc.saveSettings(p))

  useEffect(() => {
    sc.appInfo().then(setInfo)
  }, [])
  useEffect(() => {
    ;(async () => {
      const m: Record<string, string> = {}
      for (const s of settings.signatures) m[s.id] = (await sc.getSignature(s.id)) ?? ''
      setSigImgs(m)
    })()
  }, [settings.signatures])

  const isMac = info?.platform === 'darwin'

  return (
    <div className="settings">
      <nav>
        {SECS.map(([k, l]) => (
          <button key={k} className={cls(sec === k && 'on')} onClick={() => setSec(k)}>
            {l}
          </button>
        ))}
        <div className="muted mono" style={{ fontSize: 11, padding: '20px 12px' }}>
          v{info?.version}
        </div>
      </nav>
      <div className="page">
        {sec === 'sign' && (
          <section>
            <h2>서명·직인</h2>
            <p className="lead">여기 저장한 서명은 PDF와 이미지 어디에나 찍을 수 있습니다. 그리드의 SIGN 칸 또는 PDF 편집기에서 사용하세요.</p>
            <div className="sig-grid">
              {settings.signatures.map((s) => (
                <div key={s.id} className="sig">
                  <div className="img">{sigImgs[s.id] && <img src={sigImgs[s.id]} alt={s.name} />}</div>
                  <div className="bot">
                    <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </span>
                    {settings.defaultSignatureId === s.id ? (
                      <span className="chip on">
                        <span className="dot" />
                        기본
                      </span>
                    ) : (
                      <button className="btn ghost" style={{ height: 24, padding: '0 6px' }} onClick={() => save({ defaultSignatureId: s.id })}>
                        기본으로
                      </button>
                    )}
                    <button
                      className="btn ghost"
                      style={{ height: 24, padding: '0 6px' }}
                      onClick={async () => {
                        setSettings(await sc.removeSignature(s.id))
                        toast('삭제했습니다.')
                      }}
                      aria-label="삭제"
                    >
                      <IcTrash />
                    </button>
                  </div>
                </div>
              ))}
              <button className="sig" style={{ placeItems: 'center', display: 'grid', minHeight: 150, border: '1px dashed var(--line-strong)' }} onClick={() => setModal(true)}>
                <span className="row" style={{ fontWeight: 500 }}>
                  <IcPlus /> 새 서명·직인
                </span>
              </button>
            </div>
          </section>
        )}

        {sec === 'library' && (
          <section>
            <h2>스크린샷 라이브러리</h2>
            <p className="lead">운영체제가 스크린샷을 저장하는 폴더를 지켜보다가, 새 스크린샷이 생기면 라이브러리 폴더로 모읍니다.</p>
            <div className="card">
              <Toggle on={settings.libraryEnabled} onChange={(v) => save({ libraryEnabled: v })} label="스크린샷 자동 수집" />
              <Field label="라이브러리 폴더" help="모인 스크린샷이 저장되는 곳입니다. 여기서 변환한 결과는 이 폴더 안의 SUPER CONVERSIONS/V번호에 저장됩니다.">
                <div className="row">
                  <Text value={settings.libraryDir} onChange={(v) => save({ libraryDir: v })} placeholder="사진/SUPER CONVERSIONS Library" />
                  <button
                    className="btn"
                    onClick={async () => {
                      const d = await sc.pickFolder()
                      if (d) save({ libraryDir: d })
                    }}
                  >
                    변경
                  </button>
                </div>
              </Field>
              <Field label="모으는 방식" help={settings.libraryCollectMode === 'move' ? '원래 위치(바탕화면 등)에서 라이브러리로 옮깁니다. 바탕화면이 깔끔해집니다.' : '원래 위치에 그대로 두고 라이브러리에 사본을 만듭니다.'}>
                <Seg value={settings.libraryCollectMode} options={[['move', '옮기기'], ['copy', '복사하기']]} onChange={(v) => save({ libraryCollectMode: v })} />
              </Field>
              <Field label="지켜보는 폴더" help="바탕화면처럼 다른 파일도 있는 폴더는 이름이 '스크린샷·Screenshot·화면 캡처'로 시작하는 이미지만 모읍니다.">
                <div style={{ display: 'grid', gap: 4 }}>
                  {folders.map((f) => (
                    <div key={f.path} className="row" style={{ fontSize: 'var(--fs-s)' }}>
                      <span className="chip">{f.label}</span>
                      <span className="mono muted grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>
                        {f.path}
                      </span>
                      {settings.libraryExtraFolders.includes(f.path) && (
                        <button className="btn ghost" style={{ height: 24 }} onClick={() => save({ libraryExtraFolders: settings.libraryExtraFolders.filter((x) => x !== f.path) })}>
                          빼기
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    className="btn ghost"
                    style={{ justifySelf: 'start' }}
                    onClick={async () => {
                      const d = await sc.pickFolder()
                      if (d && !settings.libraryExtraFolders.includes(d)) save({ libraryExtraFolders: [...settings.libraryExtraFolders, d] })
                    }}
                  >
                    + 폴더 추가 (캡처 도구가 저장하는 곳 등)
                  </button>
                </div>
              </Field>
              <Toggle
                on={settings.libraryClipboard}
                onChange={(v) => save({ libraryClipboard: v })}
                label="클립보드에 복사된 이미지도 수집"
                help="파일로 저장하지 않고 클립보드로만 복사하는 캡처(예: Win ⇧ S에서 자동 저장을 끈 경우, ⌘ ⌃ ⇧ 4)를 잡아냅니다. 웹에서 복사한 이미지도 함께 모입니다."
              />
              <Toggle on={settings.closeToTray} onChange={(v) => save({ closeToTray: v })} label="창을 닫아도 트레이에서 계속 수집" help={isMac ? '메뉴 막대 아이콘에서 다시 열 수 있습니다.' : '작업 표시줄 오른쪽 트레이 아이콘에서 다시 열 수 있습니다.'} />
              <Toggle on={settings.launchAtLogin} onChange={(v) => save({ launchAtLogin: v })} label="컴퓨터를 켜면 자동으로 시작" help="창 없이 트레이에서 시작해 바로 수집합니다." />
            </div>
          </section>
        )}

        {sec === 'output' && (
          <section>
            <h2>저장 규칙</h2>
            <p className="lead">원본 파일 옆에 폴더를 만들고, 실행할 때마다 버전 폴더를 새로 만듭니다.</p>
            <div className="card">
              <Field label="결과 폴더 이름" help={<span className="mono">원본폴더/{settings.outputFolderName}/V1, V2, V3 …/원본파일명.새확장자</span>}>
                <Text value={settings.outputFolderName} onChange={(v) => save({ outputFolderName: v || 'SUPER CONVERSIONS' })} />
              </Field>
              <Field label="동시 처리 개수" help="이미지·PDF 작업에 적용됩니다. Office·영상 작업은 안정성을 위해 하나씩 처리합니다.">
                <Seg value={settings.concurrency} options={[[1, '1'], [2, '2'], [4, '4'], [6, '6']]} onChange={(v) => save({ concurrency: v })} />
              </Field>
              <Toggle on={settings.overlayRunsImmediately} onChange={(v) => save({ overlayRunsImmediately: v })} label="우클릭 그리드에서 바로 실행" help="탐색기/Finder 우클릭으로 연 그리드에서 칸을 누르면 저장된 기본값으로 즉시 변환합니다. Shift+클릭하면 옵션 창이 열립니다." />
            </div>
          </section>
        )}

        {sec === 'engine' && (
          <section>
            <h2>변환 엔진</h2>
            <p className="lead">설치된 프로그램을 자동으로 찾아 가장 서식 보존이 좋은 엔진을 씁니다.</p>
            <div className="card">
              <Field label="감지된 엔진" right={<button className="btn ghost" style={{ height: 24 }} onClick={refreshEngines}>다시 확인</button>}>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {engines ? (
                    <>
                      <span className={cls('chip', engines.office.word && 'on')}><span className="dot" />Word</span>
                      <span className={cls('chip', engines.office.excel && 'on')}><span className="dot" />Excel</span>
                      <span className={cls('chip', engines.office.powerpoint && 'on')}><span className="dot" />PowerPoint</span>
                      <span className={cls('chip', engines.hancom && 'on')}><span className="dot" />한컴오피스{isMac ? ' (Windows 전용)' : ''}</span>
                      <span className={cls('chip', engines.libreoffice && 'on')}><span className="dot" />LibreOffice</span>
                      <span className={cls('chip', engines.ffmpeg && 'on')}><span className="dot" />FFmpeg</span>
                      <span className={cls('chip', engines.hwEncoders.length > 0 && 'on')}><span className="dot" />GPU 인코더 {engines.hwEncoders.length}</span>
                    </>
                  ) : (
                    <span className="muted">확인 중…</span>
                  )}
                </div>
              </Field>
              <Field label="Office 문서 기본 엔진" help="자동: MS Office가 있으면 Office로, 없으면 LibreOffice로 변환합니다.">
                <Seg value={settings.officeEngine} options={[['auto', '자동'], ['office', 'MS Office만'], ['libreoffice', 'LibreOffice만']]} onChange={(v) => save({ officeEngine: v })} />
              </Field>
              <Field label="LibreOffice 경로" help="Office가 없는 PC의 대체 엔진입니다. 설치하지 않았다면 아래 버튼으로 내려받으세요(무료).">
                <div className="row">
                  <Text value={settings.sofficePath} onChange={(v) => save({ sofficePath: v })} placeholder={engines?.libreoffice ?? '자동 감지'} />
                  <button className="btn" onClick={() => sc.external('https://www.libreoffice.org/download/download-libreoffice/')}>
                    설치
                  </button>
                </div>
              </Field>
            </div>
          </section>
        )}

        {sec === 'fonts' && (
          <section>
            <h2>폰트</h2>
            <p className="lead">변환 전에 문서가 쓰는 폰트가 이 PC에 있는지 확인하고, 변환 후 PDF에 폰트가 모두 들어갔는지 검사합니다.</p>
            <div className="card">
              <Toggle on={settings.preflightFonts} onChange={(v) => save({ preflightFonts: v })} label="변환 전 폰트 점검 (프리플라이트)" help="DOCX·PPTX·XLSX·HWPX에서 사용 폰트를 읽어 없는 폰트를 결과 리포트에 표시합니다." />
              <Field label="폰트 이름 별칭" help="한글 이름 ↔ 영문 이름을 같은 폰트로 인식합니다. 한 줄에 하나씩 '한글=영문'.">
                <textarea
                  className="inp mono"
                  style={{ minHeight: 200, fontSize: 12 }}
                  defaultValue={Object.entries(settings.fontAliases)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n')}
                  onBlur={(e) => {
                    const m: Record<string, string> = {}
                    for (const line of e.target.value.split('\n')) {
                      const [k, v] = line.split('=').map((s) => s?.trim())
                      if (k && v) m[k] = v
                    }
                    save({ fontAliases: m })
                  }}
                />
              </Field>
            </div>
          </section>
        )}

        {sec === 'download' && (
          <section>
            <h2>다운로드</h2>
            <p className="lead">YouTube·TikTok·Pinterest·Instagram·Threads 등의 영상을 내려받습니다.</p>
            <div className="card">
              <Field label="저장 위치" help="이 폴더 아래 SUPER CONVERSIONS/V번호 폴더가 만들어집니다.">
                <Text value={settings.downloadDir} onChange={(v) => save({ downloadDir: v })} />
              </Field>
              <Field label="로그인 쿠키를 가져올 브라우저" help="Instagram·일부 YouTube 영상은 로그인이 필요합니다. 평소 로그인해 둔 브라우저를 고르세요. 쿠키는 다운로드할 때만 읽고 저장하지 않습니다.">
                <Seg value={settings.cookiesBrowser} options={[['none', '사용 안 함'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['whale', 'Whale'], ['safari', 'Safari'], ['firefox', 'Firefox']]} onChange={(v) => save({ cookiesBrowser: v })} />
              </Field>
              <Toggle on={settings.autoUpdateDownloader} onChange={(v) => save({ autoUpdateDownloader: v })} label="다운로드 엔진 자동 업데이트" help="플랫폼이 구조를 바꾸면 엔진 업데이트가 필요합니다. 하루 한 번 확인합니다." />
            </div>
          </section>
        )}

        {sec === 'system' && (
          <section>
            <h2>연동·업데이트</h2>
            <p className="lead">운영체제 우클릭 메뉴에서 바로 변환 그리드를 열 수 있습니다.</p>
            <div className="card">
              <Toggle
                on={settings.shellIntegration}
                onChange={async (v) => {
                  const r = await sc.shellIntegration(v)
                  toast(r.message)
                  setSettings(await sc.getSettings())
                }}
                label={isMac ? 'Finder 우클릭 › 빠른 동작에 추가' : '파일 탐색기 우클릭 메뉴에 추가'}
                help={isMac ? 'Finder에서 파일을 우클릭 › 빠른 동작 › Super Conversions. "다음으로 열기"에도 등록되어 있습니다.' : 'Windows 11은 "더 많은 옵션 표시" 안에 나타납니다. 코드서명 후 최상단 메뉴로 옮길 예정입니다.'}
              />
              <Toggle on={settings.autoUpdateApp} onChange={(v) => save({ autoUpdateApp: v })} label="앱 자동 업데이트" help="GitHub Releases에서 새 버전을 확인해 백그라운드로 내려받고, 다음 실행 때 적용합니다." />
              <Field label="업데이트 확인">
                <div className="row">
                  <button
                    className="btn"
                    onClick={async () => {
                      const s = await sc.checkUpdate()
                      toast(s.status === 'error' ? s.message ?? '확인 실패' : s.status === 'downloading' ? `새 버전 ${s.version}을 내려받는 중입니다.` : s.status === 'ready' ? `새 버전 ${s.version}이 준비되었습니다.` : '최신 버전입니다.')
                    }}
                  >
                    지금 확인
                  </button>
                  <span className="muted mono">현재 v{info?.version}</span>
                </div>
              </Field>
              <Field label="화면 테마">
                <Seg
                  value={settings.theme}
                  options={[['system', '시스템'], ['light', '라이트'], ['dark', '다크']]}
                  onChange={(v) => save({ theme: v })}
                />
              </Field>
            </div>
          </section>
        )}
      </div>
      {modal && <SignatureModal onClose={() => setModal(false)} onSaved={async () => setSettings(await sc.getSettings())} />}
    </div>
  )
}
