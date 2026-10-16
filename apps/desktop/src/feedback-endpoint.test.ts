import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  feedbackEnvFile,
  parseFeedbackEnv,
  resolveFeedbackEndpoint,
  writeFeedbackResource,
} from '../scripts/feedback-endpoint.js'

// Fake values only. A real inbox key must never appear in this repository.
const URL = 'https://feedback.test/api/feedback'
const KEY = 'fb_test_000'
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const fileAt =
  (files: Record<string, string>) =>
  (file: string): string | undefined =>
    files[path.normalize(file)]

describe('feedback endpoint at build time', () => {
  it('takes an explicit environment first and refuses an unusable one', () => {
    expect(
      resolveFeedbackEndpoint({
        env: { TASTECODE_FEEDBACK_URL: URL, TASTECODE_FEEDBACK_KEY: KEY },
        home: 'home',
        read: () => {
          throw new Error('must not read the local file')
        },
      }),
    ).toEqual({ endpoint: { url: URL, key: KEY }, source: 'environment' })
    expect(() =>
      resolveFeedbackEndpoint({
        env: { TASTECODE_FEEDBACK_URL: 'http://feedback.test/', TASTECODE_FEEDBACK_KEY: KEY },
      }),
    ).toThrow('https endpoint')
  })

  it("falls back to the maintainer's local file, honoring the config directory", () => {
    const text = `# local\nTASTECODE_FEEDBACK_URL=${URL}\nTASTECODE_FEEDBACK_KEY="${KEY}"\n`
    expect(
      resolveFeedbackEndpoint({
        env: {},
        home: 'home',
        read: fileAt({ [path.join('home', '.tastecode', 'trecko-feedback.env')]: text }),
      }),
    ).toEqual({ endpoint: { url: URL, key: KEY }, source: 'config file' })
    expect(
      resolveFeedbackEndpoint({
        env: { HARNESS_CONFIG_DIR: 'cfg' },
        home: 'home',
        read: fileAt({ [path.join('cfg', 'trecko-feedback.env')]: text }),
      }).endpoint,
    ).toEqual({ url: URL, key: KEY })
  })

  it('builds without feedback when nothing usable is configured', () => {
    expect(resolveFeedbackEndpoint({ env: {}, home: 'home', read: () => undefined })).toEqual({
      source: 'none',
    })
    expect(
      resolveFeedbackEndpoint({
        env: {},
        home: 'home',
        read: () => 'TASTECODE_FEEDBACK_URL=https://feedback.test/\nTASTECODE_FEEDBACK_KEY=nope',
      }),
    ).toEqual({ source: 'invalid config file' })
  })

  it('reads only the two feedback names', () => {
    expect(
      parseFeedbackEnv(
        `export TASTECODE_FEEDBACK_URL='${URL}'\nOTHER=x\nTASTECODE_FEEDBACK_KEY=${KEY} # note`,
      ),
    ).toEqual({ url: URL, key: KEY })
  })

  it('writes the resource and logs only the inbox host', () => {
    const outdir = mkdtempSync(path.join(os.tmpdir(), 'tastecode-feedback-resource-'))
    temporary.push(outdir)
    const line = writeFeedbackResource(outdir, {
      env: { TASTECODE_FEEDBACK_URL: URL, TASTECODE_FEEDBACK_KEY: KEY },
    })
    expect(line).toBe('feedback endpoint: feedback.test (from environment)')
    expect(line).not.toContain(KEY)
    const written = readFileSync(path.join(outdir, 'feedback', 'feedback.env'), 'utf8')
    expect(parseFeedbackEnv(written)).toEqual({ url: URL, key: KEY })

    expect(writeFeedbackResource(outdir, { env: {}, home: outdir })).toBe(
      'feedback endpoint: none (none)',
    )
    expect(readFileSync(path.join(outdir, 'feedback', 'feedback.env'), 'utf8')).toBe(
      feedbackEnvFile(undefined),
    )
    expect(parseFeedbackEnv(feedbackEnvFile(undefined))).toEqual({})
  })
})
