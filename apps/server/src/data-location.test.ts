import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDataLease } from './data-lease.js'
import { storeLocation } from './data-location.js'
import { DatabaseSync } from './sqlite.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harness-data-migrate-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function crashedDatabase() {
  const legacy = path.join(root, 'harness.db')
  execFileSync(
    process.execPath,
    [
      '-e',
      `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE saved (value TEXT); INSERT INTO saved VALUES (\\'durable\\')');
    process.exit(0);
  `,
      legacy,
    ],
    { windowsHide: true, stdio: 'pipe' },
  )
  expect(existsSync(`${legacy}-wal`)).toBe(true)
  return legacy
}

describe('database location migration', () => {
  it('recovers committed WAL data before moving a crashed legacy database', () => {
    const legacy = crashedDatabase()
    const current = storeLocation({ HARNESS_DATA_DIR: root })
    expect(current).toBe(path.join(root, 'tastecode.db'))
    expect(existsSync(legacy)).toBe(false)
    const db = new DatabaseSync(current)
    try {
      expect(db.prepare('SELECT value FROM saved').get()).toMatchObject({ value: 'durable' })
    } finally {
      db.close()
    }
    expect(existsSync(`${legacy}-wal`)).toBe(false)
    expect(existsSync(`${legacy}-shm`)).toBe(false)
  })

  it.each(['legacy', 'current'])('does not migrate while the %s data lease is held', (owner) => {
    const legacy = crashedDatabase()
    const current = path.join(root, 'tastecode.db')
    const release = acquireDataLease(owner === 'legacy' ? legacy : current)
    try {
      expect(() => storeLocation({ HARNESS_DATA_DIR: root })).toThrow(/Close TasteCode/)
      expect(existsSync(legacy)).toBe(true)
      expect(existsSync(current)).toBe(false)
    } finally {
      release()
    }
  })

  it('never overwrites an existing current database with legacy data', () => {
    const legacy = crashedDatabase()
    const current = path.join(root, 'tastecode.db')
    const db = new DatabaseSync(current)
    db.exec('CREATE TABLE current_data (value TEXT)')
    db.close()
    expect(storeLocation({ HARNESS_DATA_DIR: root })).toBe(current)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(`${legacy}-wal`)).toBe(true)
  })
})

describe('default database location', () => {
  it.each(['', 'relative-data'])('ignores a %j platform data directory', (value) => {
    // XDG treats empty and relative XDG_DATA_HOME as unset; APPDATA gets the same
    // treatment so an exported but blank variable never lands in the working directory.
    const location = storeLocation({ XDG_DATA_HOME: value, APPDATA: value })
    expect(path.isAbsolute(location)).toBe(true)
    expect(location.startsWith(os.homedir())).toBe(true)
  })
})
