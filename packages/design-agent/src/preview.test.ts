import { describe, expect, it } from 'vitest'
import { parsePreviewPlan } from './preview.js'

const plan = {
  version: 1,
  command: 'pnpm',
  args: ['dev', '--host', '127.0.0.1'],
  cwd: '.',
  url: 'http://127.0.0.1:5173',
  readyPattern: 'ready',
  viewports: [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
  ],
}

describe('preview plan', () => {
  it('normalizes a shell-free local preview plan', () => {
    expect(parsePreviewPlan(plan)).toMatchObject({
      command: 'pnpm',
      url: 'http://127.0.0.1:5173/',
      viewports: [{ name: 'desktop' }, { name: 'mobile' }],
    })
  })

  it('rejects remote preview targets', () => {
    expect(() => parsePreviewPlan({ ...plan, url: 'https://example.com' })).toThrow(
      'must use http://127.0.0.1',
    )
  })

  it('rejects shell command composition', () => {
    expect(() => parsePreviewPlan({ ...plan, command: 'pnpm && upload' })).toThrow(
      'must be an executable name',
    )
  })

  it('rejects cwd traversal', () => {
    expect(() => parsePreviewPlan({ ...plan, cwd: '../other-project' })).toThrow(
      'must stay inside the workspace',
    )
  })
})
