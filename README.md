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
npx electron . --sc-selftest ./_selftest   # 엔진 전체 자가 테스트 (샘플 생성 → 모든 변환 실행)
```

## 배포 (GitHub Releases)

1. `package.json`의 `version`을 올립니다.
2. 태그를 푸시합니다: `git tag v0.1.1 && git push origin v0.1.1`
3. GitHub Actions가 Windows `.exe`, macOS `.dmg`(Apple Silicon)를 빌드해 Release에 올립니다.
4. 설치된 앱은 자동 업데이트로 새 버전을 받습니다. (저장소가 Public이어야 합니다.)

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
