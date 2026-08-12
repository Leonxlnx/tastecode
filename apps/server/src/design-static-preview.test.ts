import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startStaticDesignPreview } from './design-static-preview.js'

let workspace: string | undefined

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

describe('static design preview review gate', () => {
  it('rejects an entry without a page heading before starting its server', async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-static-review-'))
    writeFileSync(path.join(workspace, 'index.html'), '<main><h2>Grid health</h2></main>')

    await expect(
      startStaticDesignPreview(workspace, {
        version: 1,
        kind: 'static',
        entry: 'index.html',
        cwd: '.',
        url: 'http://127.0.0.1:4173/',
        viewports: [{ name: 'mobile', width: 390, height: 844 }],
      }),
    ).rejects.toThrow('exactly one <h1>; found 0')
  })
})
