// Explorer (Windows) / Finder (macOS) right-click integration.
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import os from 'os'
import { isMac, isWin, run } from './tools'

const WIN_KEYS = ['HKCU\\Software\\Classes\\*\\shell\\SuperConversions', 'HKCU\\Software\\Classes\\Directory\\shell\\SuperConversions']

export async function setShellIntegration(enable: boolean): Promise<{ ok: boolean; message: string }> {
  try {
    if (isWin) return enable ? await winInstall() : await winRemove()
    if (isMac) return enable ? await macInstall() : await macRemove()
    return { ok: false, message: '이 운영체제에서는 지원하지 않습니다.' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

async function winInstall() {
  const exe = app.getPath('exe')
  for (const key of WIN_KEYS) {
    await run('reg', ['add', key, '/v', 'MUIVerb', '/d', 'Super Conversions', '/f'])
    await run('reg', ['add', key, '/v', 'Icon', '/d', `"${exe}",0`, '/f'])
    await run('reg', ['add', key, '/v', 'MultiSelectModel', '/d', 'Player', '/f'])
    const r = await run('reg', ['add', `${key}\\command`, '/ve', '/d', `"${exe}" --sc-grid "%1"`, '/f'])
    if (r.code !== 0) throw new Error(r.stderr || '레지스트리 등록 실패')
  }
  return { ok: true, message: '탐색기 우클릭 메뉴에 등록했습니다. Windows 11에서는 "더 많은 옵션 표시" 안에 나타납니다.' }
}
async function winRemove() {
  for (const key of WIN_KEYS) await run('reg', ['delete', key, '/f'])
  return { ok: true, message: '탐색기 우클릭 메뉴에서 제거했습니다.' }
}

// ---- macOS Quick Action (Automator service) ----
const wfDir = () => join(os.homedir(), 'Library', 'Services', 'Super Conversions.workflow')

async function macInstall() {
  const exe = app.getPath('exe')
  const cmd = `"${exe}" --sc-grid "$@" > /dev/null 2>&1 &`
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSServices</key>
  <array><dict>
    <key>NSBackgroundColorName</key><string>background</string>
    <key>NSIconName</key><string>NSActionTemplate</string>
    <key>NSMenuItem</key><dict><key>default</key><string>Super Conversions</string></dict>
    <key>NSMessage</key><string>runWorkflowAsService</string>
    <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
    <key>NSSendFileTypes</key><array><string>public.item</string></array>
  </dict></array>
</dict></plist>`
  const uuid = () => crypto.randomUUID().toUpperCase()
  const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>AMApplicationBuild</key><string>523</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array><dict><key>action</key><dict>
    <key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
    <key>AMActionVersion</key><string>2.0.3</string>
    <key>AMApplication</key><array><string>Automator</string></array>
    <key>AMParameterProperties</key><dict><key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/></dict>
    <key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
    <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
    <key>ActionName</key><string>Run Shell Script</string>
    <key>ActionParameters</key><dict>
      <key>COMMAND_STRING</key><string>${xmlEsc(cmd)}</string>
      <key>CheckedForUserDefaultShell</key><true/>
      <key>inputMethod</key><integer>1</integer>
      <key>shell</key><string>/bin/zsh</string>
      <key>source</key><string></string>
    </dict>
    <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
    <key>CFBundleVersion</key><string>2.0.3</string>
    <key>CanShowSelectedItemsWhenRun</key><false/>
    <key>CanShowWhenRun</key><true/>
    <key>Category</key><array><string>AMCategoryUtilities</string></array>
    <key>Class Name</key><string>RunShellScriptAction</string>
    <key>InputUUID</key><string>${uuid()}</string>
    <key>Keywords</key><array><string>Shell</string><string>Script</string></array>
    <key>OutputUUID</key><string>${uuid()}</string>
    <key>UUID</key><string>${uuid()}</string>
    <key>UnlocalizedApplications</key><array><string>Automator</string></array>
    <key>arguments</key><dict/>
    <key>isViewVisible</key><integer>1</integer>
    <key>location</key><string>309.000000:253.000000</string>
    <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
  </dict><key>isViewVisible</key><integer>1</integer></dict></array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key><dict>
    <key>applicationBundleIDsByPath</key><dict/>
    <key>applicationPaths</key><array/>
    <key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>presentationMode</key><integer>15</integer>
    <key>processesInput</key><false/>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key><false/>
    <key>systemImageName</key><string>NSActionTemplate</string>
    <key>useAutomaticInputType</key><false/>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict></plist>`
  await fs.mkdir(join(wfDir(), 'Contents'), { recursive: true })
  await fs.writeFile(join(wfDir(), 'Contents', 'Info.plist'), info)
  await fs.writeFile(join(wfDir(), 'Contents', 'document.wflow'), doc)
  await run('/System/Library/CoreServices/pbs', ['-flush']).catch(() => undefined)
  return { ok: true, message: 'Finder 우클릭 › 빠른 동작(또는 서비스)에 "Super Conversions"를 추가했습니다. 보이지 않으면 시스템 설정 › 키보드 › 키보드 단축키 › 서비스에서 켜 주세요.' }
}
async function macRemove() {
  await fs.rm(wfDir(), { recursive: true, force: true })
  return { ok: true, message: 'Finder 빠른 동작을 제거했습니다.' }
}
