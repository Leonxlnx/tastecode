# Blueemi launch handoff

Updated: 2026-08-17 19:30 CEST / 2026-08-18 01:30 China Standard Time  
Launch status: paused pending a new explicit go/no-go  
Latest product main audited: `fae4da906c26bb9a0d45c003c01a2801fcd4e753`

## Overnight audit update

Read the new **Overnight audit addendum** at the top of `HANDOFF.md` before using the older launch
instructions below. It supersedes any conflicting status in this file.

Important changes since the previous handoff:

- Draft PRs #959, #960, and #961 contain isolated focus/accessibility, child-output-drain, and
  unavailable-image-preview fixes. They are unmerged and still need local focused/full gates.
- The launch branches were 43 commits behind audited `main` at the review boundary. Do not package
  them until current `main` has been merged into the working branch without rebasing.
- Public launch blockers are tracked in #950, #951, #952, #953, #954, and #956. #955 also blocks
  if direct API/Connections is exposed.
- Claude subscription credential handling and Codex voice currently use unsupported/private auth
  paths. Hide those paths for beta unless they are replaced with supported provider APIs or have
  explicit written provider approval.
- Grok threads cannot resume after an app restart. Fix #953 or remove Grok from the public roster.
- The release upload design still has a duplicate-draft race and stale-artifact risk. Do not use it
  for final publication until #954 is fixed and both old private drafts are deleted.
- Current-main full gates were not completed in the cloud because the registry was unavailable and
  the cache was incomplete. Earlier green totals below apply only to the older branch state.

Blueemi's macOS responsibility remains the same: build the exact approved SHA used by Windows,
sign/notarize/staple it, verify the final containers and signatures, complete the real UI smoke,
and create checksums after signing. Keep every artifact in one private draft until Leon approves
publication.

## Hard stop

Do not make either repository public, publish a GitHub Release, merge a launch pull
request, or announce the beta until Leon gives an explicit launch approval.

## Active pull requests

- Product OSS preparation: draft PR #936
  - branch: `docs/oss-launch-readiness`
- Product release preparation: draft PR #937
  - branch: `agent/release-artifact-proof`
- Landing page: draft PR #1 in `Leonxlnx/tastecode-landingpage`
  - branch: `feat/public-beta-launch`

Both product branches have been merged forward with the latest product `main`. No rebase
or force-push was used. The landing-page PR is still separate from landing-page `main`.

## Work completed in release PR #937

- Configured the desktop updater for GitHub prereleases in `Leonxlnx/tastecode`.
- Added Windows x64 NSIS and macOS Apple Silicon DMG/ZIP release proof.
- Added Windows silent install/uninstall and macOS container verification.
- Added SHA-256 generation and strict draft-release asset filtering.
- Increased the Windows preview cleanup tolerance for the observed `EBUSY` race.
- Changed hosted release proof to manual dispatch only. Normal pushes no longer consume
  GitHub Actions minutes.
- Fixed draft lookup to include unpublished draft releases. The uploader now refuses to
  continue when duplicate releases use the same tag instead of creating another duplicate.
- Fixed formatting in this handoff and the new macOS icon metadata.

## Local cloud validation completed

Validation used Node 24 with the repository-pinned pnpm 11.8.0 and a frozen lockfile.

- `pnpm install --frozen-lockfile`: passed
- `pnpm lint`: passed
- `pnpm typecheck`: passed across all workspace projects
- `pnpm test`: passed across all workspace projects
  - web suite: 818 tests
  - server suite: 375 tests
  - desktop suite: 68 tests
  - every package and adapter suite also passed
- `pnpm build`: passed, including the production renderer build
- desktop preload build: passed
- Electron Linux unpacked packaging smoke: passed
  - `resources/app.asar` present
  - `resources/app-update.yml` present
  - bundled web resources present
- release uploader fixture: passed create/upload, strict filtering, and duplicate-draft
  refusal scenarios
- checksum helper fixture: passed and excluded internal builder files
- landing-page `npm run build`: passed
  - TypeScript passed
  - all nine static pages/routes generated
- landing-page download URLs match the intended Windows EXE and macOS DMG asset names.

The cloud host is Linux. It cannot truthfully prove the real Windows NSIS GUI flow,
SmartScreen wording, Authenticode status, or macOS signing/notarization. The Linux
packaging smoke used the repository's smaller 512x512 icon as a local-only fallback
because the connector could not download the larger app icon. No icon fallback was pushed.
Starting the unpacked Electron binary was blocked before app code by the cloud sandbox,
which denies Chromium's required local process-singleton socket.

## Private draft-release blocker

There are currently two incomplete private draft releases using the intended tag
`v0.1.0-beta.1`:

- release ID `371292479`
- release ID `371294326`

Neither draft is publishable. They were created before draft-aware lookup was fixed and
contain partial/older macOS proof assets. Delete both drafts in GitHub before the final
local upload so the fixed uploader creates one clean canonical draft. Do not reuse or
publish either current draft.

The fixed uploader intentionally stops with a clear error while duplicate tag matches
exist.

## Leon: required Windows work

Use a clean Windows checkout of the exact final product commit. Do not build from an
unmerged polish branch or from one of the old draft targets.

Run:

```text
corepack pnpm@11.8.0 install --frozen-lockfile
corepack pnpm@11.8.0 lint
corepack pnpm@11.8.0 typecheck
corepack pnpm@11.8.0 test
corepack pnpm@11.8.0 build
corepack pnpm@11.8.0 --filter @harness/desktop exec node scripts/build-preload.js
corepack pnpm@11.8.0 --filter @harness/desktop exec electron-builder --win nsis --x64 --publish never
node tools/scripts/release-checksums.js release SHA256SUMS-windows-x64.txt
```

Then complete this short physical Windows pass:

1. Confirm the EXE and `beta.yml` exist and the checksum file matches.
2. Confirm `Get-AuthenticodeSignature` reports `NotSigned` if Windows remains unsigned.
3. Run the normal interactive installer, including one non-default install directory.
4. Launch from the Start menu and complete first-run setup.
5. Sign in to one shipped provider and receive one real response.
6. Open a project and smoke-test terminal, attachment, approval, diff/checkpoint, and
   Design Mode.
7. Quit and relaunch; verify user data is preserved.
8. Uninstall and verify the documented user-data retention behavior.
9. Record the exact SmartScreen wording for the release notes.

After both duplicate drafts are deleted, upload only from the approved final commit:

```text
set GITHUB_REPOSITORY=Leonxlnx/tastecode
set GITHUB_SHA=<exact-final-commit>
set RELEASE_TAG=v0.1.0-beta.1
set GITHUB_TOKEN=<temporary-token-with-release-write-access>
node tools/scripts/upload-draft-release.js release
```

Never commit or paste the token into a PR, issue, handoff, or log.

## Blueemi: required macOS work

Blueemi owns the Apple Developer signing/notarization path.

1. Use the same exact approved final product commit as Windows.
2. Run the four local gates and build Apple Silicon DMG and ZIP artifacts.
3. Sign the app and installer, notarize, and staple the final deliverables.
4. Verify with `codesign`, `spctl`, `stapler`, `hdiutil verify`, and `unzip -t`.
5. Test DMG drag-to-Applications, first Finder launch, one real provider response, project
   open, terminal, attachment, approval, checkpoint, Design Mode, relaunch, and removal.
6. Generate `SHA256SUMS-macos-arm64.txt` after signing because signing changes hashes.
7. Upload the signed macOS assets to the same single private draft as Windows.

If signing cannot be completed in time, Leon must explicitly approve an unsigned macOS
beta and its user-facing warning before publication.

## OSS/legal work before public

PR #936 is not ready to merge blindly. Before making the product repository public:

- confirm Apache-2.0 and the `TasteCode contributors` copyright wording
- add the standard full Apache-2.0 license text through GitHub's official license template;
  the current short SPDX notice alone is not the normal distributable license file
- add/confirm the required NOTICE file
- generate and review the production dependency license inventory
- ensure the packaged desktop app carries the root license and every required third-party
  license/notice
- confirm `hello@tasteskill.dev` is monitored for security reports
- confirm provider terms and trademark wording

## Final private draft contents

The single clean draft must target the exact final product commit and contain only:

- `TasteCode-0.1.0-beta.1-win-x64.exe`
- `TasteCode-0.1.0-beta.1-win-x64.exe.blockmap`
- `beta.yml`
- `SHA256SUMS-windows-x64.txt`
- `TasteCode-0.1.0-beta.1-mac-arm64.dmg`
- `TasteCode-0.1.0-beta.1-mac-arm64.dmg.blockmap`
- `TasteCode-0.1.0-beta.1-mac-arm64.zip`
- `TasteCode-0.1.0-beta.1-mac-arm64.zip.blockmap`
- `beta-mac.yml`
- `SHA256SUMS-macos-arm64.txt`

No `builder-debug.yml`, effective config, logs, credentials, or unrelated files.

## Launch order after Leon's explicit approval

1. Review and merge OSS PR #936 and release PR #937.
2. Record the resulting exact product `main` commit.
3. Delete both broken duplicate draft releases.
4. Build and test Windows and macOS from that exact commit.
5. Create one private draft, upload both platforms, and verify every checksum and updater
   metadata URL while it remains private.
6. Make the product repository public.
7. Publish the prerelease.
8. Merge landing-page PR #1 and verify desktop/mobile, download URLs, support, privacy,
   terms, release notes, robots, and sitemap.
9. Perform one public clean download per platform.
10. Announce only after the public downloads work.

Issue #25 remains assigned to Blueemi with `target:later`; it is not a beta-launch blocker.
