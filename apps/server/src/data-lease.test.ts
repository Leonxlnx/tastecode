import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLease, canonicalDataPath } from './data-lease.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function database() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-data-lease-'))
  roots.push(root)
  return path.join(root, 'tastecode.db')
}
describe('database ownership', () => {
  it('refuses concurrent core or maintenance access and releases on close', () => {
    const file = database()
    const release = acquireDataLease(file)
    try {
      expect(() => acquireDataLease(file)).toThrow(/Close TasteCode/)
    } finally {
      release()
    }
    const next = acquireDataLease(file)
    next()
    next()
  })
  it('blocks another real process, and an exited owner needs no stale-file repair', () => {
    const file = database()
    const leaseFile = `${canonicalDataPath(file)}.owner.sqlite`
    const code =
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.argv[1]); try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); process.stdout.write("owned"); } catch(error) { process.stdout.write(String(error.errcode)); }'
    const run = () =>
      execFileSync(process.execPath, ['--no-warnings', '-e', code, leaseFile], {
        encoding: 'utf8',
        windowsHide: true,
      })
    const release = acquireDataLease(file)
    try {
      expect(run()).toBe('5')
    } finally {
      release()
    }
    expect(run()).toBe('owned')
    acquireDataLease(file)()
  })
  it('uses the same lock through a directory alias', () => {
    const file = database()
    const alias = `${path.dirname(file)}-alias`
    symlinkSync(path.dirname(file), alias, process.platform === 'win32' ? 'junction' : 'dir')
    roots.push(alias)
    const release = acquireDataLease(file)
    try {
      expect(() => acquireDataLease(path.join(alias, 'tastecode.db'))).toThrow(/Close TasteCode/)
    } finally {
      release()
    }
  })
})
