import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FEEDBACK_CONFIG_ENV,
  FEEDBACK_KEY_ENV,
  FEEDBACK_URL_ENV,
  parseEndpointFile,
  takeFeedbackConfig,
  validateFeedbackEndpoint,
} from './feedback-config.js'

const URL = 'https://feedback.test/api/feedback'
const KEY = 'fb_test_000'

afterEach(() => vi.unstubAllEnvs())

function files(entries: Record<string, string>) {
  const read: string[] = []
  return {
    read,
    readText: (file: string) => {
      read.push(file)
      return entries[file]
    },
  }
}

describe('takeFeedbackConfig', () => {
  it('prefers the environment and removes every feedback variable from it', () => {
    const env: NodeJS.ProcessEnv = {
      [FEEDBACK_URL_ENV]: URL,
      [FEEDBACK_KEY_ENV]: KEY,
      [FEEDBACK_CONFIG_ENV]: '/packaged/feedback.env',
      PATH: '/bin',
    }
    const disk = files({
      '/packaged/feedback.env': `${FEEDBACK_URL_ENV}=https://other.test/\n${FEEDBACK_KEY_ENV}=fb_other_0000`,
    })
    expect(takeFeedbackConfig(env, disk.readText)).toEqual({ endpoint: { url: URL, key: KEY } })
    expect(env).toEqual({ PATH: '/bin' })
    expect(disk.read).toEqual([])
  })

  it('reads the packaged endpoint file a desktop build points at', () => {
    const env: NodeJS.ProcessEnv = { [FEEDBACK_CONFIG_ENV]: '/packaged/feedback.env' }
    const disk = files({
      '/packaged/feedback.env': `# generated\n${FEEDBACK_URL_ENV}="${URL}"\n${FEEDBACK_KEY_ENV}=${KEY}\n`,
    })
    expect(takeFeedbackConfig(env, disk.readText)).toEqual({ endpoint: { url: URL, key: KEY } })
    expect(env).toEqual({})
  })

  it('falls back to the local config directory used in development', () => {
    vi.stubEnv('HARNESS_CONFIG_DIR', path.join('cfg'))
    const disk = files({
      [path.join('cfg', 'trecko-feedback.env')]:
        `${FEEDBACK_URL_ENV}=${URL}\r\n${FEEDBACK_KEY_ENV}=${KEY}\r\n`,
    })
    expect(takeFeedbackConfig({}, disk.readText)).toEqual({ endpoint: { url: URL, key: KEY } })
  })

  it('reports nothing configured without reading a secret anywhere', () => {
    vi.stubEnv('HARNESS_CONFIG_DIR', path.join('empty'))
    expect(takeFeedbackConfig({}, files({}).readText)).toEqual({})
  })

  it.each([
    { url: 'http://feedback.test/api/feedback', key: KEY },
    { url: 'https://user:pass@feedback.test/api', key: KEY },
    { url: 'not a url', key: KEY },
    { url: URL, key: 'sk-not-a-feedback-key' },
    { url: URL, key: 'fb_short' },
    { url: URL, key: '' },
    { url: '', key: KEY },
  ])('marks an unusable endpoint invalid instead of using it: $url', ({ url, key }) => {
    const env: NodeJS.ProcessEnv = { [FEEDBACK_URL_ENV]: url, [FEEDBACK_KEY_ENV]: key }
    expect(takeFeedbackConfig(env, files({}).readText)).toEqual({ invalid: true })
    expect(env).toEqual({})
  })
})

describe('feedback endpoint parsing', () => {
  it('accepts loopback http for local fakes only', () => {
    expect(
      validateFeedbackEndpoint({ url: 'http://127.0.0.1:4999/api/feedback', key: KEY }),
    ).toEqual({ url: 'http://127.0.0.1:4999/api/feedback', key: KEY })
    expect(validateFeedbackEndpoint({ url: 'http://localhost:4999/', key: KEY })).toBeUndefined()
  })

  it('reads only the two feedback names, with comments, quotes and export', () => {
    expect(
      parseEndpointFile(
        [
          '# TasteCode feedback',
          `export ${FEEDBACK_URL_ENV}='${URL}'`,
          `${FEEDBACK_KEY_ENV}=${KEY} # team key`,
          'OTHER_SECRET=ignored',
        ].join('\n'),
      ),
    ).toEqual({ url: URL, key: KEY })
    expect(parseEndpointFile(undefined)).toBeUndefined()
  })
})
