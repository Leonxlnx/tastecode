import assert from 'node:assert/strict'
import test from 'node:test'
import { updateFeedVerdicts } from './check-update-feed.js'

const repository = 'Leonxlnx/tastecode'

function release(
  version,
  publishedAt,
  { assets = ['mac-arm64.dmg', 'win-x64.exe'], ...rest } = {},
) {
  const tag = `v${version}`
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    published_at: publishedAt,
    assets: assets.map((suffix) => {
      const name = `TasteCode-${version}-${suffix}`
      return {
        name,
        state: 'uploaded',
        size: 500_000_000,
        digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
      }
    }),
    ...rest,
  }
}

const verdicts = (releases, options = {}) =>
  updateFeedVerdicts(releases, { repository, ...options }).map(({ tag, failed, problems }) => ({
    tag,
    failed,
    problems,
  }))

test('a complete release published last serves every installed generation', () => {
  assert.deepEqual(
    verdicts([
      release('0.1.1', '2026-09-20T19:10:08Z'),
      { ...release('0.1.0', '2026-09-22T18:19:25Z'), tag_name: 'linux-preview-e9ac0a03' },
      release('0.1.0-beta.9', '2026-09-20T11:00:10Z'),
    ]),
    [
      { tag: 'v0.1.1', failed: false, problems: [] },
      { tag: 'v0.1.1', failed: false, problems: [] },
    ],
  )
})

test('an older proof published after the newest release breaks beta 7 to 0.1.1', () => {
  const [old, later] = verdicts([
    release('0.1.0-beta.8', '2026-09-22T00:00:00Z', { assets: ['linux-amd64.deb'] }),
    release('0.1.1', '2026-09-20T00:00:00Z'),
  ])
  assert.equal(old.failed, true)
  assert.match(old.problems.join('\n'), /missing TasteCode-0\.1\.0-beta\.8-mac-arm64\.dmg/)
  assert.match(old.problems.join('\n'), /not the highest version; v0\.1\.1 is/)
  assert.deepEqual(later, { tag: 'v0.1.1', failed: false, problems: [] })
})

test('an older complete release published last is a warning, not a failure', () => {
  const [old] = verdicts([
    release('0.1.0', '2026-09-22T00:00:00Z'),
    release('0.1.1', '2026-09-20T00:00:00Z'),
  ])
  assert.equal(old.failed, false)
  assert.match(old.problems[0], /Publish the highest version last/)
})

test('every generation fails when the newest release lacks an installer or its digest', () => {
  const missing = verdicts([
    release('0.1.2', '2026-10-01T00:00:00Z', { assets: ['mac-arm64.dmg'] }),
  ])
  assert.ok(missing.every((verdict) => verdict.failed))
  assert.match(missing[0].problems[0], /missing TasteCode-0\.1\.2-win-x64\.exe/)

  const unhashed = release('0.1.2', '2026-10-01T00:00:00Z')
  unhashed.assets[0].digest = null
  unhashed.assets[1].state = 'starter'
  const [verdict] = verdicts([unhashed])
  assert.deepEqual(verdict.problems, [
    'TasteCode-0.1.2-mac-arm64.dmg has no SHA-256 digest',
    'TasteCode-0.1.2-win-x64.exe is still uploading',
  ])
})

test('a draft is judged as if published now, with its assets moved under the tag', () => {
  const draft = release('0.1.2', null, { draft: true })
  for (const asset of draft.assets)
    asset.browser_download_url = asset.browser_download_url.replace(
      '/download/v0.1.2/',
      '/download/untagged-8dc4e7c22df5e15f798f/',
    )
  const live = [release('0.1.1', '2026-09-20T00:00:00Z')]
  assert.deepEqual(verdicts(live, { draft, now: new Date('2026-10-03T00:00:00Z') }), [
    { tag: 'v0.1.2', failed: false, problems: [] },
    { tag: 'v0.1.2', failed: false, problems: [] },
  ])

  draft.assets[1].browser_download_url = 'https://example.com/TasteCode-0.1.2-win-x64.exe'
  const [verdict] = verdicts(live, { draft })
  assert.deepEqual(verdict.problems, [
    'TasteCode-0.1.2-win-x64.exe downloads from an unexpected URL',
  ])
})

test('drafts, unpublished rows and non-version tags are ignored', () => {
  assert.deepEqual(
    verdicts([
      release('0.2.0', '2026-10-02T00:00:00Z', { draft: true }),
      release('0.1.9', null),
      { ...release('0.1.5', '2026-10-02T00:00:00Z'), tag_name: 'docs' },
      release('0.1.1', '2026-09-20T00:00:00Z'),
    ]).map((verdict) => verdict.tag),
    ['v0.1.1', 'v0.1.1'],
  )
  assert.throws(() => verdicts([release('0.1.9', null)]), /No published TasteCode release/)
})
