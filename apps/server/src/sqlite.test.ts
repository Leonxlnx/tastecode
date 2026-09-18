import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('SQLite startup', () => {
  it('loads SQLite quietly, restores the warning handler, and keeps other warnings visible', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict'
          const emitWarning = process.emitWarning
          const { DatabaseSync } = await import(${JSON.stringify(new URL('./sqlite.ts', import.meta.url).href)})
          assert.equal(process.emitWarning, emitWarning)
          const db = new DatabaseSync(':memory:')
          try {
            db.exec('CREATE TABLE probe (value TEXT)')
            db.prepare('INSERT INTO probe VALUES (?)').run('saved')
            assert.equal(db.prepare('SELECT value FROM probe').get().value, 'saved')
          } finally {
            db.close()
          }
          process.emitWarning('Other experimental feature', 'ExperimentalWarning')
          process.emitWarning('Other warning')
        `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('SQLite is an experimental feature')
    expect(result.stderr).toContain('ExperimentalWarning: Other experimental feature')
    expect(result.stderr).toContain('Warning: Other warning')
  })
})
