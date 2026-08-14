import { describe, expect, it } from 'vitest'
import { designPreviewPrompt, parsePreviewPhaseOutput, parsePreviewPlan } from './preview.js'

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
  it('asks for a shell-free local plan and parses the response', () => {
    const prompt = designPreviewPrompt()
    expect(prompt).toContain('Preview Setup phase')
    expect(prompt).toContain('127.0.0.1')
    expect(prompt).toContain('Do not install dependencies')
    expect(prompt).toContain('Harness serves static projects itself')
    expect(prompt).not.toContain('write one small static file server')
    expect(parsePreviewPhaseOutput(JSON.stringify(plan))).toMatchObject({ command: 'pnpm' })
  })

  it('normalizes a Harness-owned static preview plan', () => {
    expect(
      parsePreviewPlan({
        version: 1,
        kind: 'static',
        entry: 'index.html',
        cwd: '.',
        url: 'http://127.0.0.1:4173/site/',
        viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
      }),
    ).toMatchObject({ kind: 'static', entry: 'index.html', url: 'http://127.0.0.1:4173/site/' })
  })

  it('keeps a static entry inside its preview root', () => {
    expect(() =>
      parsePreviewPlan({
        version: 1,
        kind: 'static',
        entry: '../secret.html',
        cwd: '.',
        url: 'http://127.0.0.1:4173/',
        viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
      }),
    ).toThrow('must stay inside the workspace')
  })

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

  it('rejects disallowed executables at parse time, so the model can correct', () => {
    // Leon's run died at execution with 'preview command is not allowed'
    // after the model chose python; parse-time rejection feeds the one
    // correction attempt instead of failing the whole flow.
    expect(() => parsePreviewPlan({ ...plan, command: 'python' })).toThrow(
      'must be one of bun, node, npm, pnpm, yarn',
    )
    expect(() => parsePreviewPlan({ ...plan, command: 'npx' })).toThrow('is not executed')
  })

  it('rejects cwd traversal', () => {
    expect(() => parsePreviewPlan({ ...plan, cwd: '../other-project' })).toThrow(
      'must stay inside the workspace',
    )
  })

  it('bounds capture work to supported viewport sizes', () => {
    expect(() =>
      parsePreviewPlan({
        ...plan,
        viewports: [{ name: 'oversized', width: 7_680, height: 4_320 }],
      }),
    ).toThrow('between 320 and 3840')
    expect(() =>
      parsePreviewPlan({
        ...plan,
        viewports: Array.from({ length: 5 }, (_, index) => ({
          name: `viewport-${index}`,
          width: 390,
          height: 844,
        })),
      }),
    ).toThrow('between one and four')
  })

  it('rejects duplicate capture dimensions before the desktop request', () => {
    expect(() =>
      parsePreviewPlan({
        ...plan,
        viewports: [
          { name: 'desktop', width: 1440, height: 1000 },
          { name: 'same-size', width: 1440, height: 1000 },
        ],
      }),
    ).toThrow('viewport dimensions must be unique')
  })
})
