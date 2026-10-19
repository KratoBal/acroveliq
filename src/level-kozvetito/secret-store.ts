// The relay's own secret store for the two OAuth client values (task parancssor-f-titok-urlap, contract v1 section 2.4).
// The compose secrets under `titkok/` are single-file bind mounts: a rename cannot replace them, so they are never
// written here. This store lives in its own writable directory and keeps, per target:
//
//   <target>.v<N>     one version of the value, mode 0400, never rewritten
//   <target>.aktiv    the pointer, one small JSON document {"aktiv": N, "elozo": M | null}, replaced by rename
//
// Version 0 is the legacy compose-secret file named in the settings: with no pointer the target reads from it, and it
// is the "previous" of the first write. A rotation is OPEN while `elozo` is not null: the previous value stays until
// `lezar` (close) or can be put back with `visszaall`. At most two versions are alive per target.
//
// Every change is: write a temp file in the same directory, fsync it, rename it, fsync the directory. A crash between
// two steps leaves either the old state or the new one, never a half-written active value; an unreferenced version
// file (a crash between the version rename and the pointer rename) is removed by the next write.
import { chmodSync, closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { Refusal } from './errors.js'

/** A version number above this is no version the relay wrote: the pointer is refused. */
const MAX_VERSION = 1_000_000

interface Pointer {
  aktiv: number
  elozo: number | null
}

export interface SecretState {
  /** the active version; 0 is the legacy compose-secret file */
  verzio: number
  /** a rotation is open: the previous value is kept */
  rotacioNyitva: boolean
}

export interface SecretStoreOptions {
  dir: string
  /** target name -> its legacy compose-secret file (version 0). The targets are this list and nothing else. */
  legacy: Readonly<Record<string, string>>
}

/** Reads a secret file: one value, no whitespace (the same rule the relay's start applies). */
export function readSecretFile(path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (value === '' || /\s/.test(value)) throw new Error('secret file is empty or has whitespace')
  return value
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Writes `content` to `path` through a temp file in the same directory: fsync, then rename, then fsync of the directory. */
function replaceFile(dir: string, tempPrefix: string, path: string, content: string, mode: number): void {
  const temp = join(dir, `${tempPrefix}${process.pid}-${randomBytes(6).toString('hex')}`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      writeSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, mode)
    renameSync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // the temp file may already be gone (renamed); nothing else was changed
    }
    throw err
  }
  fsyncDir(dir)
}

export class SecretStore {
  constructor(private readonly opts: SecretStoreOptions) {}

  private known(target: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.opts.legacy, target)) throw new Refusal(404, 'ismeretlen-cel')
  }

  private versionPath(target: string, n: number): string {
    return join(this.opts.dir, `${target}.v${n}`)
  }

  /** Temp files carry the target's name, so the sweep of one target never removes the temp file of a write in progress on another. */
  private tempPrefix(target: string): string {
    return `.tmp-${target}-`
  }

  private pointerPath(target: string): string {
    return join(this.opts.dir, `${target}.aktiv`)
  }

  private readPointer(target: string): Pointer {
    let raw: string
    try {
      raw = readFileSync(this.pointerPath(target), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { aktiv: 0, elozo: null }
      throw err
    }
    let p: Partial<Pointer>
    try {
      p = JSON.parse(raw) as Partial<Pointer>
    } catch {
      throw new Error('secret pointer is malformed')
    }
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('secret pointer is malformed')
    // a damaged or foreign pointer STOPS the target (an exception, never a fallback to the compose secret): the active value
    // is then not known, and guessing one is how a rotated-away secret would come back to life
    const version = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_VERSION
    const ok = version(p.aktiv) && (p.elozo === null || (version(p.elozo) && p.elozo !== p.aktiv))
    if (!ok) throw new Error('secret pointer is malformed')
    return { aktiv: p.aktiv as number, elozo: p.elozo as number | null }
  }

  private writePointer(target: string, pointer: Pointer): void {
    replaceFile(this.opts.dir, this.tempPrefix(target), this.pointerPath(target), `${JSON.stringify(pointer)}\n`, 0o600)
  }

  private valueOf(target: string, n: number): string {
    return readSecretFile(n === 0 ? this.opts.legacy[target]! : this.versionPath(target, n))
  }

  /** The active value of a target. Read at the moment of use, so a new value is taken without a restart. */
  read(target: string): string {
    this.known(target)
    return this.valueOf(target, this.readPointer(target).aktiv)
  }

  state(target: string): SecretState {
    this.known(target)
    const p = this.readPointer(target)
    return { verzio: p.aktiv, rotacioNyitva: p.elozo !== null }
  }

  /**
   * Removes every version file of the target that is not in `keep` (the active one), and its temp files. The state is
   * the POINTER; a file the pointer does not name is unreachable, so removing it is always safe. Called under the
   * target's lock by `write` and `close`, so a crash leftover (an unreferenced version, a temp file) never blocks a
   * later rotation and never outlives the next one.
   */
  private sweep(target: string, keep: ReadonlySet<number>): void {
    const own = new RegExp(`^${target}\\.v(\\d+)$`)
    for (const name of readdirSync(this.opts.dir)) {
      const m = own.exec(name)
      if ((m && !keep.has(Number(m[1]))) || name.startsWith(this.tempPrefix(target))) {
        try {
          unlinkSync(join(this.opts.dir, name))
        } catch {
          // already gone
        }
      }
    }
  }

  /**
   * Stores a new value and makes it active. `preflight` runs first with the candidate and throws to refuse it:
   * then nothing on disk has changed. The previous value stays (a rotation is open) until `close`.
   */
  async write(target: string, value: string, preflight: (candidate: string) => Promise<void>): Promise<SecretState> {
    this.known(target)
    const pointer = this.readPointer(target)
    if (pointer.elozo !== null) throw new Refusal(409, 'rotacio-nyitva')
    await preflight(value)
    // an unreferenced file (a crash before the pointer was replaced) is removed before the next number is taken
    this.sweep(target, new Set([pointer.aktiv]))
    const next = pointer.aktiv + 1
    replaceFile(this.opts.dir, this.tempPrefix(target), this.versionPath(target, next), `${value}\n`, 0o400)
    this.writePointer(target, { aktiv: next, elozo: pointer.aktiv })
    return { verzio: next, rotacioNyitva: true }
  }

  /** Closes the rotation: the previous value is deleted (the pointer first, so a crash leaves only an unreferenced file). */
  close(target: string): SecretState {
    this.known(target)
    const pointer = this.readPointer(target)
    if (pointer.elozo === null) throw new Refusal(409, 'nincs-nyitott-rotacio')
    this.writePointer(target, { aktiv: pointer.aktiv, elozo: null })
    this.sweep(target, new Set([pointer.aktiv]))
    return { verzio: pointer.aktiv, rotacioNyitva: false }
  }

  /** Puts the previous value back as the active one; the rotation stays open until someone closes it. */
  rollBack(target: string): SecretState {
    this.known(target)
    const pointer = this.readPointer(target)
    if (pointer.elozo === null) throw new Refusal(409, 'nincs-nyitott-rotacio')
    // the previous value must still be readable BEFORE the pointer moves onto it
    this.valueOf(target, pointer.elozo)
    this.writePointer(target, { aktiv: pointer.elozo, elozo: pointer.aktiv })
    return { verzio: pointer.elozo, rotacioNyitva: true }
  }
}
