import { describe, expect, it } from 'vitest'
import {
  editionArgument,
  editionFromArguments,
  ownedServerEnvironment,
  packagedEdition,
  withDefaultSkills,
  withEdition,
  withFeedbackDetails,
} from './owned-server-env.js'

const html = (url: string) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${url}; img-src 'self'">`

describe('owned server endpoint', () => {
  it('uses the packaged renderer endpoint instead of an inherited port override', () => {
    const inherited = {
      HARNESS_PORT: '5555',
      HARNESS_HOST: '0.0.0.0',
      HARNESS_RENDERER_ORIGIN: 'http://127.0.0.1:5183',
      PATH: 'retained',
    }
    expect(ownedServerEnvironment(inherited, html('ws://127.0.0.1:4311'))).toEqual({
      HARNESS_PORT: '4311',
      HARNESS_HOST: '127.0.0.1',
      HARNESS_RENDERER_ORIGIN: 'file://',
      PATH: 'retained',
    })
    expect(inherited.HARNESS_PORT).toBe('5555')
  })

  it('honors a custom endpoint compiled into the renderer and its CSP', () => {
    expect(ownedServerEnvironment({}, html('ws://127.0.0.1:5555')).HARNESS_PORT).toBe('5555')
  })

  it('preserves isolated server ports while trusting only the file renderer', () => {
    expect(ownedServerEnvironment({ HARNESS_PORT: '5555' })).toEqual({
      HARNESS_PORT: '5555',
      HARNESS_RENDERER_ORIGIN: 'file://',
    })
  })

  it.each(['wss://example.com/', 'ws://192.168.1.1:4311', 'ws://user:pass@127.0.0.1:4311'])(
    'rejects an unsupported packaged endpoint %s',
    (url) => {
      expect(() => ownedServerEnvironment({}, html(url))).toThrow('loopback')
    },
  )

  it('rejects a missing or ambiguous endpoint instead of splitting server and renderer', () => {
    expect(() => ownedServerEnvironment({}, '<html></html>')).toThrow('no local server endpoint')
    expect(() =>
      ownedServerEnvironment({}, html('ws://127.0.0.1:4311 ws://127.0.0.1:5555')),
    ).toThrow('no local server endpoint')
  })
})

describe('server feedback details', () => {
  it('passes the app version and only the path of the packaged endpoint file', () => {
    const inherited = { PATH: 'retained' }
    expect(
      withFeedbackDetails(inherited, {
        appVersion: '0.1.2',
        feedbackConfig: '/Applications/Taste Code.app/Contents/Resources/feedback/feedback.env',
      }),
    ).toEqual({
      PATH: 'retained',
      HARNESS_APP_VERSION: '0.1.2',
      TASTECODE_FEEDBACK_CONFIG:
        '/Applications/Taste Code.app/Contents/Resources/feedback/feedback.env',
    })
    expect(inherited).toEqual({ PATH: 'retained' })
  })

  it('lets an inherited endpoint win and adds nothing for an unpackaged run', () => {
    expect(
      withFeedbackDetails(
        { TASTECODE_FEEDBACK_CONFIG: '/staging/feedback.env' },
        { appVersion: '0.1.2', feedbackConfig: '/packaged/feedback.env' },
      ).TASTECODE_FEEDBACK_CONFIG,
    ).toBe('/staging/feedback.env')
    expect(withFeedbackDetails({}, { appVersion: '0.1.2', feedbackConfig: undefined })).toEqual({
      HARNESS_APP_VERSION: '0.1.2',
    })
  })
})

describe('default skills folder', () => {
  it('points a packaged server at the resources copy and leaves an unpackaged run alone', () => {
    const inherited = { PATH: 'retained' }
    expect(withDefaultSkills(inherited, '/Resources/default-skills')).toEqual({
      PATH: 'retained',
      HARNESS_DEFAULT_SKILLS_DIR: '/Resources/default-skills',
    })
    expect(withDefaultSkills(inherited, undefined)).toBe(inherited)
  })
})

describe('build edition', () => {
  it('reads dev only from an explicit dev package and treats everything else as release', () => {
    expect(packagedEdition({ tastecodeEdition: 'dev' })).toBe('dev')
    expect(packagedEdition({ tastecodeEdition: 'release' })).toBe('release')
    expect(packagedEdition({})).toBe('release')
    expect(packagedEdition({ tastecodeEdition: 'nightly' })).toBe('release')
    expect(packagedEdition({ tastecodeEdition: true })).toBe('release')
  })

  it('overrides an inherited edition and leaves an unpackaged run alone', () => {
    const inherited = { PATH: 'retained', HARNESS_EDITION: 'dev' }
    expect(withEdition(inherited, 'release')).toEqual({
      PATH: 'retained',
      HARNESS_EDITION: 'release',
    })
    expect(withEdition(inherited, undefined)).toBe(inherited)
  })

  it('carries the edition to the preload and ignores anything it does not know', () => {
    const argv = (...extra: string[]) => ['electron', '--type=renderer', ...extra]
    expect(editionFromArguments(argv(editionArgument('release')))).toBe('release')
    expect(editionFromArguments(argv(editionArgument('dev')))).toBe('dev')
    expect(editionFromArguments(argv())).toBeUndefined()
    expect(editionFromArguments(argv('--tastecode-edition=nightly'))).toBeUndefined()
    expect(editionFromArguments(argv('--tastecode-edition='))).toBeUndefined()
  })
})
