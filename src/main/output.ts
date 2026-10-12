import { promises as fs, existsSync } from 'fs'
import { dirname, join, basename, extname } from 'path'
import { getSettings } from './settings'

/**
 * One job = one version folder per source directory:
 *   <source dir>/SUPER CONVERSIONS/V<n>/<original name>.<new ext>
 * n = highest existing V + 1. Folders are created lazily, once per job.
 */
export class OutputPlanner {
  private vdirs = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()
  private taken = new Set<string>()

  constructor(private overrideBase?: string) {}

  dirFor(sourcePath: string): Promise<string> {
    const srcDir = this.overrideBase ?? dirname(sourcePath)
    // memoise the promise so parallel workers in one job share a single V folder
    let p = this.pending.get(srcDir)
    if (!p) {
      p = this.createVersionDir(srcDir)
      this.pending.set(srcDir, p)
    }
    return p
  }

  private async createVersionDir(srcDir: string): Promise<string> {
    const root = join(srcDir, getSettings().outputFolderName || 'SUPER CONVERSIONS')
    await fs.mkdir(root, { recursive: true })
    let max = 0
    for (const name of await fs.readdir(root)) {
      const m = /^V(\d+)$/i.exec(name)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    // claim atomically: a concurrent job in the same folder gets the next number
    for (let n = max + 1; ; n++) {
      const v = join(root, `V${n}`)
      try {
        await fs.mkdir(v)
        this.vdirs.set(srcDir, v)
        return v
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
  }

  /** Output path keeping the original base name; collisions get " (2)", " (3)"… */
  async pathFor(sourcePath: string, ext: string, suffix = ''): Promise<string> {
    const dir = await this.dirFor(sourcePath)
    return this.unique(dir, basename(sourcePath, extname(sourcePath)) + suffix, ext)
  }

  async pathNamed(sourcePath: string, name: string, ext: string): Promise<string> {
    const dir = await this.dirFor(sourcePath)
    return this.unique(dir, name, ext)
  }

  unique(dir: string, stem: string, ext: string): string {
    const clean = stem.replace(/[\\/:*?"<>|]/g, '_')
    let n = 1
    let p = join(dir, `${clean}.${ext}`)
    while (this.taken.has(p) || existsSync(p)) {
      n++
      p = join(dir, `${clean} (${n}).${ext}`)
    }
    this.taken.add(p)
    return p
  }

  get dirs(): string[] {
    return [...this.vdirs.values()]
  }
}

/** Parse "1-3,5,8-" into 0-based indices within [0,count). */
export function parsePageList(spec: string | undefined, count: number): number[] {
  if (!spec || spec.trim() === '' || spec.trim().toLowerCase() === 'all') return [...Array(count).keys()]
  const out: number[] = []
  for (const part of spec.split(',')) {
    const t = part.trim()
    if (!t) continue
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(t)
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1
      const b = m[2] ? parseInt(m[2], 10) : count
      for (let i = a; i <= b; i++) if (i >= 1 && i <= count) out.push(i - 1)
    } else if (/^\d+$/.test(t)) {
      const i = parseInt(t, 10)
      if (i >= 1 && i <= count) out.push(i - 1)
    }
  }
  return [...new Set(out)]
}
