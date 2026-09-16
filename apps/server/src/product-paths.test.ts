import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateProductFile } from './product-paths.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TasteCode storage migration', () => {
  it('moves a legacy file once and keeps an existing TasteCode file authoritative', () => {
    const root = os.tmpdir()
    const unique = `tastecode-storage-${Date.now()}-${Math.random()}`
    const legacy = path.join(root, unique, 'PersonalHarness', 'harness.db')
    const current = path.join(root, unique, 'TasteCode', 'tastecode.db')
    roots.push(path.join(root, unique))
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, 'history')

    expect(migrateProductFile(current, legacy)).toBe(current)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(legacy)).toBe(false)

    writeFileSync(legacy, 'stale')
    expect(migrateProductFile(current, legacy)).toBe(current)
    expect(existsSync(legacy)).toBe(true)
  })

  it('carries wal and shm sidecars over with the database', () => {
    const root = os.tmpdir()
    const unique = `tastecode-storage-${Date.now()}-${Math.random()}`
    const legacy = path.join(root, unique, 'PersonalHarness', 'harness.db')
    const current = path.join(root, unique, 'TasteCode', 'tastecode.db')
    roots.push(path.join(root, unique))
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, 'history')
    writeFileSync(`${legacy}-wal`, 'uncheckpointed tail')
    writeFileSync(`${legacy}-shm`, 'shared memory')

    expect(migrateProductFile(current, legacy)).toBe(current)
    expect(existsSync(`${current}-wal`)).toBe(true)
    expect(existsSync(`${current}-shm`)).toBe(true)
    expect(existsSync(`${legacy}-wal`)).toBe(false)
    expect(existsSync(`${legacy}-shm`)).toBe(false)
  })
})
