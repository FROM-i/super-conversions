# Super Conversions

문서 · 이미지 · 영상 · PDF를 **한 곳에서** 변환하는 THE FROM의 로컬 설치형 데스크톱 툴입니다. 파일을 우클릭하면 3×3 정사각 그리드가 펼쳐지고, 원하는 변환을 고르면 끝입니다.

## 핵심 원칙: 서식 보존

| 대상 | 1순위 엔진 | 대체 엔진 |
|---|---|---|
| PPT·DOC·XLS → PDF/최신 포맷 | PC에 설치된 **MS Office**를 원격 조작 (Windows: COM, Mac: AppleScript) | LibreOffice (설치 시) |
| HWP/HWPX ↔ PDF·DOCX·HWP | **한컴오피스** (Windows) | 내장 변환기 (베타, 텍스트·표 중심) |
| 이미지 (JPG/PNG/WEBP/AVIF/TIFF/HEIC/PSD/SVG) | libvips (sharp) | — |
| 영상/오디오 | FFmpeg (GPU 가속 자동 감지) | CPU 인코딩 |
| PDF 편집·압축·병합·분할·암호·서명 | 내장 (pdf-lib, pdf.js) | — |
| 영상 다운로드 | yt-dlp (첫 사용 시 설치, 자동 업데이트) | Threads 전용 보조 추출기 |

변환 전 **폰트 프리플라이트**(문서가 쓰는 폰트가 PC에 있는지)와 변환 후 **포스트플라이트**(PDF 폰트 포함 여부, 페이지 수)를 자동 수행하고 결과 리포트에 표시합니다.

## 저장 규칙

```
원본폴더/SUPER CONVERSIONS/V1/원본파일명.새확장자
                          /V2/…   ← 실행할 때마다 +1
```

## 개발

```bash
npm install
npm run dev            # 개발 실행
npm run typecheck
npm run build          # out/ 빌드
npm run selftest       # 엔진 전체 자가 테스트 (샘플 생성 → 모든 변환 실행)
```

## 업데이트 배포 (GitHub Releases)

평소에는 `main`에 커밋·푸시만 하면 됩니다. 그때마다 CI가 타입 검사·빌드·엔진 자가 테스트를 돌립니다.

사용자에게 새 버전을 내보낼 때는 한 줄이면 됩니다.

```bash
npm run release:patch   # 0.1.0 → 0.1.1  (버그 수정)
npm run release:minor   # 0.1.x → 0.2.0  (기능 추가)
```

이 명령이 하는 일:

1. `package.json` 버전을 올리고, 지난 릴리스 이후 커밋 제목으로 `CHANGELOG.md`를 채웁니다.
2. 커밋 → `vX.Y.Z` 태그 → GitHub로 푸시합니다.
3. GitHub Actions가 Windows `.exe`, macOS `.dmg`·`.zip`을 빌드해 Releases에 올립니다.
4. 설치된 앱이 실행 시와 4시간마다 새 버전을 확인해 백그라운드로 내려받고, 상단에 **"업데이트 · 재시작"** 버튼을 띄웁니다. 누르지 않아도 다음에 앱을 닫을 때 자동 적용됩니다.

> 저장소는 Public이어야 설치된 앱이 토큰 없이 업데이트를 받을 수 있습니다.
> macOS 자동 설치는 서명된 빌드에서만 동작합니다(아래 Secrets 등록 전에는 사용자가 Releases에서 직접 내려받아야 합니다).

### macOS 서명·공증 (선택, 권장)

저장소 Settings › Secrets › Actions에 아래 값을 넣으면 자동으로 서명·공증됩니다. 없으면 서명 없이 빌드되며, 사용자는 첫 실행 때 우클릭 › 열기를 해야 합니다.

| Secret | 내용 |
|---|---|
| `MAC_CERT_P12_BASE64` | Developer ID Application 인증서(.p12)를 base64로 인코딩한 값 |
| `MAC_CERT_PASSWORD` | .p12 암호 |
| `APPLE_ID` | Apple Developer 계정 이메일 |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com에서 만든 앱 암호 |
| `APPLE_TEAM_ID` | 팀 ID (10자리) |

### Windows 코드서명 (추후)

인증서 없이 배포하면 첫 실행 때 SmartScreen 경고가 뜹니다(“추가 정보 › 실행”). 인증서를 구매하면 `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`를 추가하고, 탐색기 최상단 우클릭 메뉴(IExplorerCommand) 작업을 진행합니다.

## 알려진 한계

- HWP 내장 변환기는 한컴오피스가 없는 환경용 **베타**입니다. 복잡한 표·글상자·도형은 달라질 수 있습니다.
- HWPX → HWP(구형 바이너리) 저장은 한컴오피스가 있는 Windows에서만 가능합니다.
- Mac용 Office는 샌드박스 정책상 첫 변환 때 자동화 권한 허용 창이 뜹니다.
- Excel for Mac은 시트 맞춤(PageSetup) 자동화가 Windows보다 제한적입니다.
- macOS 빌드는 Apple Silicon(arm64) 전용입니다.

## 구조

```
src/
  shared/      변환 매트릭스·타입·기본값 (main/renderer 공용)
  main/        Electron 메인 — 작업 큐, 엔진, OS 연동
    engines/   image · video · office · hwp · docmodel · pdf · fonts · download
    scripts/   office-worker.ps1 (Windows Office/한컴 COM 워커)
  preload/     렌더러에 노출하는 API
  renderer/    React UI — 그리드 메뉴, 변환 보드, PDF 편집기, 다운로드, 설정
```
