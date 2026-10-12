import { useEffect, useMemo, useState } from 'react'
import { ACTION_BY_ID, CATEGORY_META, type ActionId } from '@shared/formats'
import { DEFAULT_OPTIONS } from '@shared/defaults'
import type { ActionOptions, EngineStatus, Settings } from '@shared/types'
import { sc } from '../lib/api'
import { cls, toneOf } from '../lib/util'
import { Anchor9, Field, Num, Range, Seg, Text, Toggle } from './Fields'

interface Props {
  action: ActionId
  files: string[]
  settings: Settings
  engines: EngineStatus | null
  onRun: (o: ActionOptions, savePreset: boolean) => void
  onClose: () => void
}

export default function OptionsPanel({ action, files, settings, engines, onRun, onClose }: Props) {
  const def = ACTION_BY_ID[action]
  const base = useMemo(() => ({ ...DEFAULT_OPTIONS[action], ...(settings.presets[action] ?? {}) }), [action, settings.presets])
  const [o, setO] = useState<ActionOptions>(base)
  const [savePreset, setSavePreset] = useState(false)
  const [sigs, setSigs] = useState<Record<string, string>>({})
  useEffect(() => setO(base), [base])
  const set = (p: Partial<ActionOptions>) => setO((x) => ({ ...x, ...p }))

  const needsSig = action === 'img.sign' || action === 'pdf.sign'
  useEffect(() => {
    if (!needsSig) return
    ;(async () => {
      const m: Record<string, string> = {}
      for (const s of settings.signatures) m[s.id] = (await sc.getSignature(s.id)) ?? ''
      setSigs(m)
    })()
  }, [needsSig, settings.signatures])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        e.preventDefault()
        onRun(o, savePreset)
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const cat = def.category
  const isOffice = cat === 'doc' || cat === 'slide' || cat === 'sheet'
  const officeKind = cat === 'slide' ? 'powerpoint' : cat === 'sheet' ? 'excel' : 'word'
  const hasOffice = engines ? engines.office[officeKind] : false

  const imageFields = (
    <>
      {(action === 'img.resize' || action === 'img.sign') && (
        <Field label="저장 포맷">
          <Seg
            value={o.keepFormat === false ? o.format : 'keep'}
            options={[
              ['keep', '원본 유지'],
              ['jpg', 'JPG'],
              ['png', 'PNG'],
              ['webp', 'WEBP']
            ]}
            onChange={(v) => (v === 'keep' ? set({ keepFormat: true }) : set({ keepFormat: false, format: v as ActionOptions['format'] }))}
          />
        </Field>
      )}
      {action !== 'img.sign' && (
        <>
          <Field label="크기 조정">
            <Seg
              value={o.resize}
              options={[
                ['none', '원본'],
                ['long', '긴 변'],
                ['width', '가로'],
                ['percent', '%'],
                ['exact', '정확히']
              ]}
              onChange={(v) => set({ resize: v })}
            />
            {(o.resize === 'long' || o.resize === 'width' || o.resize === 'height') && <Num value={o.size} onChange={(v) => set({ size: v })} suffix="px" min={1} />}
            {o.resize === 'percent' && <Num value={o.size} onChange={(v) => set({ size: v })} suffix="%" min={1} max={400} />}
            {o.resize === 'exact' && (
              <>
                <div className="row">
                  <Num value={o.width} onChange={(v) => set({ width: v })} placeholder="가로" />
                  <span className="muted">×</span>
                  <Num value={o.height} onChange={(v) => set({ height: v })} placeholder="세로" suffix="px" />
                </div>
                <Seg value={o.fit} options={[['cover', '꽉 채워 자르기'], ['contain', '여백 두고 맞춤'], ['fill', '늘리기']]} onChange={(v) => set({ fit: v })} />
              </>
            )}
          </Field>
          {action !== 'img.tiff' && (
            <Field label="목표 용량" help="지정하면 품질 → 크기 순으로 자동 조정해 이 용량 이하로 맞춥니다.">
              <Num value={o.targetKB || undefined} onChange={(v) => set({ targetKB: v })} suffix="KB 이하" placeholder="제한 없음" min={1} />
            </Field>
          )}
        </>
      )}
      {action !== 'img.png' && action !== 'img.tiff' && (
        <Field label="품질" right={o.quality}>
          <Range value={o.quality ?? 88} onChange={(v) => set({ quality: v })} min={30} max={100} />
        </Field>
      )}
      <Toggle on={!!o.stripMeta} onChange={(v) => set({ stripMeta: v })} label="메타데이터 제거 (위치·카메라 정보)" />
      {action === 'img.jpg' && (
        <Field label="투명 영역 배경색">
          <div className="row">
            <input type="color" value={o.background ?? '#ffffff'} onChange={(e) => set({ background: e.target.value })} style={{ width: 40, height: 32, border: '1px solid var(--line-strong)', background: 'none' }} />
            <span className="mono muted">{o.background}</span>
          </div>
        </Field>
      )}
    </>
  )

  const stampFields = (
    <>
      <Field label="서명·직인">
        {settings.signatures.length === 0 ? (
          <div className="note">저장된 서명이 없습니다. 설정 › 서명·직인에서 먼저 등록해 주세요.</div>
        ) : (
          <div className="sig-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', margin: 0 }}>
            {settings.signatures.map((s) => (
              <button key={s.id} className="sig" style={{ gridTemplateRows: '64px auto', outline: (o.signatureId ?? settings.defaultSignatureId) === s.id ? '2px solid var(--ink)' : undefined }} onClick={() => set({ signatureId: s.id })}>
                <div className="img">{sigs[s.id] && <img src={sigs[s.id]} alt="" style={{ maxHeight: 48 }} />}</div>
                <div className="bot" style={{ fontSize: 11 }}>{s.name}</div>
              </button>
            ))}
          </div>
        )}
      </Field>
      <Field label="위치">
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <Anchor9 value={o.anchor} onChange={(a) => set({ anchor: a })} />
          <div style={{ flex: 1, display: 'grid', gap: 8 }}>
            <div className="lbl" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}>
              <span>크기</span>
              <span className="mono">{o.sizePct}%</span>
            </div>
            <Range value={o.sizePct ?? 18} onChange={(v) => set({ sizePct: v })} min={4} max={60} />
            <div className="lbl" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}>
              <span>여백</span>
              <span className="mono">{o.marginPct}%</span>
            </div>
            <Range value={o.marginPct ?? 4} onChange={(v) => set({ marginPct: v })} min={0} max={20} />
          </div>
        </div>
      </Field>
      <Field label="불투명도" right={`${Math.round((o.opacity ?? 1) * 100)}%`}>
        <Range value={Math.round((o.opacity ?? 1) * 100)} onChange={(v) => set({ opacity: v / 100 })} min={10} max={100} />
      </Field>
      {action === 'pdf.sign' && (
        <Field label="찍을 페이지">
          <Seg value={o.stampPages} options={[['last', '마지막'], ['first', '첫 장'], ['all', '모든 장'], ['custom', '직접']]} onChange={(v) => set({ stampPages: v })} />
          {o.stampPages === 'custom' && <Text value={o.pageList} onChange={(v) => set({ pageList: v })} placeholder="예: 1, 3-5" />}
        </Field>
      )}
    </>
  )

  const officeFields = (
    <>
      <Field label="변환 엔진" help={hasOffice ? 'Microsoft Office가 설치되어 있어 원본 서식 그대로 변환합니다.' : 'Office가 없어 LibreOffice로 변환합니다. 서식이 일부 달라질 수 있습니다.'}>
        <Seg value={o.engine} options={[['auto', '자동'], ['office', 'MS Office'], ['libreoffice', 'LibreOffice']]} onChange={(v) => set({ engine: v })} />
      </Field>
      {cat === 'sheet' && action === 'sheet.pdf' && (
        <>
          <Field label="시트 맞춤" help="표가 여러 장으로 잘리는 문제를 막습니다.">
            <Seg value={o.sheetFit} options={[['original', '원본 인쇄설정'], ['width', '열 너비에 맞춤'], ['onepage', '시트당 1페이지']]} onChange={(v) => set({ sheetFit: v })} />
          </Field>
          <Field label="용지 방향">
            <Seg value={o.orientation} options={[['original', '원본'], ['portrait', '세로'], ['landscape', '가로']]} onChange={(v) => set({ orientation: v })} />
          </Field>
        </>
      )}
      {cat === 'doc' && action === 'doc.pdf' && <Toggle on={!!o.bitmapMissingFonts} onChange={(v) => set({ bitmapMissingFonts: v })} label="포함 불가 폰트는 이미지로 고정" help="라이선스상 PDF에 넣을 수 없는 폰트를 비트맵으로 바꿔 모양을 지킵니다." />}
      {/\.(jpg|png)$/.test(action) && (
        <Field label="해상도" right={`${o.dpi} dpi`}>
          <Seg value={o.dpi} options={[[96, '96'], [150, '150'], [200, '200'], [300, '300']]} onChange={(v) => set({ dpi: v })} />
        </Field>
      )}
    </>
  )

  const hwpFields = (
    <>
      <Field
        label="변환 엔진"
        help={engines?.hancom ? '한컴오피스가 설치되어 있어 원본 그대로 변환합니다.' : '한컴오피스가 없어 내장 변환기(베타)를 씁니다. 텍스트·표 위주로 옮겨집니다.'}
      >
        <Seg value={o.engine === 'builtin' ? 'builtin' : 'auto'} options={[['auto', '자동'], ['builtin', '내장 변환기']]} onChange={(v) => set({ engine: v })} />
      </Field>
      {action === 'doc.hwp' && (
        <Field label="저장 형식" help={engines?.hancom ? undefined : 'HWP(구형)는 한컴오피스가 있어야 만들 수 있습니다.'}>
          <Seg value={o.hwpTarget} options={[['hwpx', 'HWPX'], ['hwp', 'HWP']]} onChange={(v) => set({ hwpTarget: v })} />
        </Field>
      )}
      {action === 'hwp.jpg' && (
        <Field label="해상도">
          <Seg value={o.dpi} options={[[96, '96'], [150, '150'], [200, '200'], [300, '300']]} onChange={(v) => set({ dpi: v })} />
        </Field>
      )}
    </>
  )

  const pdfFields = (() => {
    switch (action) {
      case 'pdf.jpg':
      case 'pdf.png':
        return (
          <>
            <Field label="해상도" right={`${o.dpi} dpi`}>
              <Seg value={o.dpi} options={[[72, '72'], [150, '150'], [200, '200'], [300, '300']]} onChange={(v) => set({ dpi: v })} />
            </Field>
            <Field label="페이지" help="비워 두면 전체. 예: 1-3, 5">
              <Text value={o.pages === 'all' ? '' : o.pages} onChange={(v) => set({ pages: v || 'all' })} placeholder="전체" />
            </Field>
            {action === 'pdf.jpg' && (
              <Field label="품질" right={o.quality}>
                <Range value={o.quality ?? 90} onChange={(v) => set({ quality: v })} min={40} max={100} />
              </Field>
            )}
          </>
        )
      case 'pdf.compress':
        return (
          <Field label="압축 강도" help="문서 안의 사진을 다시 압축합니다. 글자와 벡터는 그대로 유지됩니다.">
            <Seg value={o.level} options={[['low', '가볍게'], ['medium', '보통'], ['high', '강하게']]} onChange={(v) => set({ level: v })} />
          </Field>
        )
      case 'pdf.merge':
        return (
          <Field label="파일명" help={`선택한 순서대로 ${files.length}개를 합칩니다. 순서는 보드에서 드래그로 바꿀 수 있습니다.`}>
            <Text value={o.name} onChange={(v) => set({ name: v })} />
          </Field>
        )
      case 'pdf.split':
        return (
          <Field label="나누는 방식">
            <Seg value={o.splitMode} options={[['each', '한 장씩'], ['every', 'N장씩'], ['ranges', '범위 지정']]} onChange={(v) => set({ splitMode: v })} />
            {o.splitMode === 'every' && <Num value={o.every} onChange={(v) => set({ every: v })} suffix="장씩" min={1} />}
            {o.splitMode === 'ranges' && <Text value={o.ranges} onChange={(v) => set({ ranges: v })} placeholder="예: 1-3; 4-10; 11-" />}
          </Field>
        )
      case 'pdf.encrypt':
        return (
          <>
            <Field label="열기 암호">
              <Text type="password" value={o.userPassword} onChange={(v) => set({ userPassword: v })} placeholder="필수" />
            </Field>
            <Field label="권한 암호" help="비워 두면 자동 생성됩니다.">
              <Text type="password" value={o.ownerPassword} onChange={(v) => set({ ownerPassword: v })} placeholder="선택" />
            </Field>
            <Toggle on={!!o.allowPrint} onChange={(v) => set({ allowPrint: v })} label="인쇄 허용" />
            <Toggle on={!!o.allowCopy} onChange={(v) => set({ allowCopy: v })} label="내용 복사 허용" />
            <Toggle on={!!o.allowEdit} onChange={(v) => set({ allowEdit: v })} label="편집 허용" />
          </>
        )
      case 'pdf.sign':
        return stampFields
    }
    return null
  })()

  const videoFields = (() => {
    const q = (
      <Field label="화질">
        <Seg value={o.vquality} options={[['high', '높음'], ['medium', '보통'], ['low', '작게']]} onChange={(v) => set({ vquality: v })} />
      </Field>
    )
    const enc = (
      <>
        <Field label="코덱">
          <Seg value={o.codec} options={[['h264', 'H.264 (호환)'], ['h265', 'H.265 (고효율)']]} onChange={(v) => set({ codec: v })} />
        </Field>
        <Toggle on={!!o.hwaccel} onChange={(v) => set({ hwaccel: v })} label="그래픽카드 가속" help={engines?.hwEncoders.length ? `사용 가능: ${engines.hwEncoders.join(', ')}` : '사용 가능한 하드웨어 인코더가 없으면 자동으로 CPU를 씁니다.'} />
      </>
    )
    switch (action) {
      case 'vid.mp4':
      case 'vid.mov':
        return (
          <>
            <Toggle on={!!o.remux} onChange={(v) => set({ remux: v })} label="가능하면 무손실 변환" help="원본이 H.264/HEVC면 재인코딩 없이 컨테이너만 바꿉니다. 화질 손실 0, 몇 초면 끝납니다." />
            {q}
            {enc}
          </>
        )
      case 'vid.webm':
        return q
      case 'vid.gif':
        return (
          <>
            <Field label="구간" help="초 또는 mm:ss. 끝을 비우면 영상 끝까지.">
              <div className="row">
                <Text value={o.start} onChange={(v) => set({ start: v })} placeholder="시작" />
                <span className="muted">→</span>
                <Text value={o.end} onChange={(v) => set({ end: v })} placeholder="끝" />
              </div>
            </Field>
            <Field label="가로 크기">
              <Seg value={o.gifWidth} options={[[480, '480'], [720, '720'], [960, '960'], [1280, '1280']]} onChange={(v) => set({ gifWidth: v })} />
            </Field>
            <Field label="프레임" right={`${o.fps} fps`}>
              <Range value={o.fps ?? 15} onChange={(v) => set({ fps: v })} min={5} max={30} />
            </Field>
          </>
        )
      case 'vid.audio':
        return (
          <>
            <Field label="오디오 포맷">
              <Seg value={o.audioFormat} options={[['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV']]} onChange={(v) => set({ audioFormat: v })} />
            </Field>
            {o.audioFormat !== 'wav' && (
              <Field label="비트레이트">
                <Seg value={o.audioBitrate} options={[[128, '128k'], [192, '192k'], [256, '256k'], [320, '320k']]} onChange={(v) => set({ audioBitrate: v })} />
              </Field>
            )}
          </>
        )
      case 'vid.compress':
        return (
          <>
            <Field label="목표 용량" help="지정하면 비트레이트를 계산해 맞춥니다. 비우면 화질 기준으로 줄입니다.">
              <Num value={o.targetMB || undefined} onChange={(v) => set({ targetMB: v })} suffix="MB" placeholder="화질 기준" min={1} />
            </Field>
            {q}
            <Field label="최대 해상도">
              <Seg value={o.height} options={[[0, '원본'], [1080, '1080p'], [720, '720p'], [480, '480p']]} onChange={(v) => set({ height: v || undefined })} />
            </Field>
            {enc}
          </>
        )
      case 'vid.resize':
        return (
          <>
            <Field label="해상도 (세로 기준)">
              <Seg value={o.height} options={[[2160, '4K'], [1440, '1440'], [1080, '1080'], [720, '720'], [480, '480']]} onChange={(v) => set({ height: v })} />
            </Field>
            {q}
            {enc}
          </>
        )
      case 'vid.trim':
        return (
          <>
            <Field label="구간" help="초(90) 또는 시:분:초(1:30). 끝을 비우면 영상 끝까지.">
              <div className="row">
                <Text value={o.start} onChange={(v) => set({ start: v })} placeholder="시작" />
                <span className="muted">→</span>
                <Text value={o.end} onChange={(v) => set({ end: v })} placeholder="끝" />
              </div>
            </Field>
            <Toggle on={!!o.trimCopy} onChange={(v) => set({ trimCopy: v })} label="빠른 자르기 (무손실)" help="키프레임 단위로 잘려 시작이 1~2초 어긋날 수 있습니다. 끄면 정확하게 다시 인코딩합니다." />
          </>
        )
    }
    if (cat === 'audio' && (action === 'aud.mp3' || action === 'aud.m4a'))
      return (
        <Field label="비트레이트">
          <Seg value={o.audioBitrate} options={[[128, '128k'], [192, '192k'], [256, '256k'], [320, '320k']]} onChange={(v) => set({ audioBitrate: v })} />
        </Field>
      )
    return null
  })()

  let body: React.ReactNode = null
  if (cat === 'image') body = action === 'img.pdf' ? (
    <>
      <Field label="묶는 방식">
        <Seg value={o.mode} options={[['merge', '하나의 PDF로'], ['each', '파일마다 PDF']]} onChange={(v) => set({ mode: v })} />
      </Field>
      <Field label="페이지 크기">
        <Seg value={o.pageSize} options={[['original', '이미지 크기'], ['a4', 'A4 세로'], ['a4-landscape', 'A4 가로']]} onChange={(v) => set({ pageSize: v })} />
      </Field>
      <Field label="여백" right={`${o.marginMm}mm`}>
        <Range value={o.marginMm ?? 0} onChange={(v) => set({ marginMm: v })} min={0} max={30} />
      </Field>
    </>
  ) : action === 'img.sign' ? (
    <>
      {stampFields}
      {imageFields}
    </>
  ) : (
    imageFields
  )
  else if (isOffice) body = action === 'doc.hwp' ? hwpFields : officeFields
  else if (cat === 'hwp') body = hwpFields
  else if (cat === 'pdf') body = pdfFields
  else body = videoFields

  return (
    <aside className={cls('panel', toneOf(cat))}>
      <div className="panel-head">
        <span className="bar" />
        <div className="row">
          <span className="cap">{CATEGORY_META[cat].label} → </span>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose} aria-label="닫기">
            Esc
          </button>
        </div>
        <div className="big">{def.label}</div>
        <div className="muted">
          {def.hint} · {files.length}개 파일
        </div>
      </div>
      <div className="panel-body">{body ?? <div className="field help">추가 옵션 없이 바로 변환합니다.</div>}</div>
      <div className="panel-foot">
        <Toggle on={savePreset} onChange={setSavePreset} label="이 설정을 기본값으로 저장" />
        <button className="btn solid big" onClick={() => onRun(o, savePreset)} disabled={(action === 'pdf.encrypt' && !o.userPassword) || (needsSig && settings.signatures.length === 0)}>
          변환 시작 <span className="kbd" style={{ color: 'inherit', borderColor: 'currentColor' }}>Enter</span>
        </button>
      </div>
    </aside>
  )
}
