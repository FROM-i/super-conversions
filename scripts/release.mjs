#!/usr/bin/env node
// Usage: npm run release:patch | release:minor | release:major
// 1) checks the tree is clean  2) bumps package.json version
// 3) prepends commit summaries since the last tag to CHANGELOG.md
// 4) commits, tags vX.Y.Z, pushes → GitHub Actions builds & publishes installers,
//    and installed apps pick the update up automatically.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim()
const kind = process.argv[2] ?? 'patch'
if (!['patch', 'minor', 'major'].includes(kind)) throw new Error('patch | minor | major')

if (sh('git status --porcelain')) {
  console.error('✗ 커밋하지 않은 변경이 있습니다. 먼저 커밋해 주세요.')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [ma, mi, pa] = pkg.version.split('.').map(Number)
const next = kind === 'major' ? `${ma + 1}.0.0` : kind === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`

let last = ''
try { last = sh('git describe --tags --abbrev=0') } catch { /* first release */ }
const log = sh(`git log ${last ? last + '..HEAD' : ''} --pretty=format:"- %s" --no-merges`)
  .split('\n').filter((l) => l && !/^- (chore\(release\)|Merge)/.test(l)).join('\n') || '- 유지보수'

const date = new Date().toISOString().slice(0, 10)
const prev = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8').replace(/^# 변경 기록\n+/, '') : ''
writeFileSync('CHANGELOG.md', `# 변경 기록\n\n## v${next} — ${date}\n\n${log}\n\n${prev}`)

pkg.version = next
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
sh('npm install --package-lock-only --ignore-scripts --silent')

sh('git add package.json package-lock.json CHANGELOG.md')
sh(`git commit -m "chore(release): v${next}"`)
sh(`git tag v${next}`)
sh('git push origin HEAD')
sh(`git push origin v${next}`)
console.log(`✓ v${next} 태그를 올렸습니다. GitHub Actions에서 설치파일 빌드가 시작됩니다.`)
