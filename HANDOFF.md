# TasteCode launch handoff

Updated: 2026-08-17  
Target launch: 2026-08-17 15:00 CEST / 21:00 China Standard Time  
GitHub is the authority for current commits, branches, pull requests, and release state.

## Stop conditions

Leon has not approved the public launch yet.

Do not:

- make either repository public
- publish any GitHub Release
- merge a launch pull request
- merge the landing page
- announce the beta
- rerun hosted GitHub Actions

Prepare, review, and test privately until Leon gives an explicit go-ahead.

## Read before continuing locally

Read these files before changing code:

- `AGENTS.md`
- `rules/working-together.md`
- `rules/git.md`
- `rules/code.md`
- `rules/security.md`
- `docs/ARCHITECTURE.md`
- `docs/dashboard.html`
- `docs/feature-inventory.html`
- `docs/DESIGN-AGENT.md`
- `BLUEMI.md`

Repository rules still apply: never push directly to `main`, never rebase a working branch,
never force-push, and merge an advanced target branch into the working branch.

## Live GitHub state before this handoff update

Product repository: `Leonxlnx/tastecode`

- `main`: `094b68781e8b2a426d1640624f5759f9a76f5909`
- OSS preparation: draft PR #936
  - branch: `docs/oss-launch-readiness`
  - previous head: `ff3b86e6f8fd449a71b7234f034c619cf0b74a13`
  - mergeable, but intentionally still draft
- Release preparation: draft PR #937
  - branch: `agent/release-artifact-proof`
  - previous head: `7ea24b417a290ba4f70798c94e82252b71b3c3a0`
  - mergeable, but intentionally still draft
- Issue #25 remains assigned to Blueemi with `target:later`.
  - It has no milestone and is not a beta-launch blocker.

Landing repository: `Leonxlnx/tastecode-landingpage`

- Public beta site: draft PR #1
  - branch: `feat/public-beta-launch`
  - head: `adf5a5fc9ab174eda41c472683ce2976abc63a2d`
  - base: `93ee5f58834123aecfb7f838fba011a44842c42c`
  - mergeable and intentionally still draft

The product branches were synchronized with current `main` through merge commits. No rebase or
force-push was used. The release branch also contains the OSS branch so packaging can prove the
distribution files. Merge PR #936 before PR #937 so the duplicated OSS diff disappears from #937.

## What ChatGPT Work changed after the previous handoff

### Main and design polish synchronization

The previous handoff described product main `d3bcf3e7...`. Eight design/polish PRs were merged
into `main` afterward. Current main is `094b6878...`.

Both launch branches had diverged from the new main. ChatGPT Work created real two-parent merge
commits to synchronize both branches while preserving their published history.

The desktop package merge explicitly preserved the new main changes:

- product name `Taste Code`
- the new `scripts/start.js` startup path
- `assets/tastecode-app-icon.png`
- the macOS icon metadata

It also preserved the release branch's GitHub prerelease updater configuration.

### GitHub Actions and release workflow

The account has no available hosted Actions minutes and Leon does not want to pay for more.

The release proof workflow is now `workflow_dispatch` only. Normal branch pushes no longer start
or consume hosted Actions. Do not rerun the old failed runs.

The latest automatic run was `32001553608` on commit `5f52d9ba...`. It failed before useful
execution because the account could not start hosted jobs. Later commits did not trigger a run
because the workflow is now manual-only.

The release workflow and local helpers now cover:

- Windows x64 NSIS packaging
- expected unsigned Authenticode state
- Windows silent install and uninstall proof
- macOS Apple Silicon DMG and ZIP packaging
- macOS container verification
- SHA-256 generation
- strict release-asset filtering
- private draft upload only
- refusal to modify a published release

### Duplicate draft-release bug

The first upload helper used `/releases/tags/{tag}`. GitHub does not reliably return draft
releases from that endpoint. Concurrent platform jobs therefore created two private drafts using
the intended `v0.1.0-beta.1` tag.

Current incomplete private drafts:

- release ID `371292479`
- release ID `371294326`

Neither draft is launchable. They target older commits and contain partial or stale macOS proof
assets. One also contained an internal builder file.

The upload helper now lists all releases, includes drafts, and refuses to continue when multiple
releases use the same tag. Its duplicate-detection path was tested with a mocked GitHub API.

Delete both old drafts in the GitHub UI before the final local upload. ChatGPT Work could not
delete them because the connected GitHub tool exposes no release-deletion operation. Do not
publish or reuse either draft.

### Release asset filtering and checksums

`tools/scripts/upload-draft-release.js` now:

- finds private drafts correctly
- refuses a non-draft release
- stops on duplicate tag matches
- updates the draft target to the exact build commit
- accepts only installers, archives, blockmaps, updater metadata, and checksum files
- removes known internal electron-builder files
- ignores unrelated files

`tools/scripts/release-checksums.js` creates cross-platform SHA-256 files and ignores internal
builder output.

Local fixture tests proved:

- clean draft creation
- intended EXE and updater-metadata upload
- internal builder-file exclusion
- duplicate-draft refusal
- checksum generation
- checksum exclusion of internal files

### OSS and distribution files

PR #936 now includes:

- refreshed beta README
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `NOTICE`
- licensing documentation
- updated handoff material

The desktop package config in PR #937 now bundles:

- `LICENSE`
- `NOTICE`
- `THIRD_PARTY_NOTICES.md`
- the `licenses/` directory

Linux packaging verified that all four resources reach the packaged application's
`resources/` directory.

Important remaining legal blocker: the current root `LICENSE` is only a short SPDX notice and a
link. Before the repository becomes public, replace it with GitHub's complete standard
Apache-2.0 license template. Also generate and review a production dependency license inventory,
confirm provider terms and trademark wording, and confirm that `hello@tasteskill.dev` is
monitored for security reports.

### Documentation and PR descriptions

ChatGPT Work updated:

- `BLUEMI.md` with the launch commands, owners, asset allowlist, and stop conditions
- PR #936's body with current OSS validation and blockers
- PR #937's body with current local validation and release blockers
- landing-page PR #1's body with current validation and launch order

## Cloud validation completed

ChatGPT Work reconstructed the private release branch in the Linux cloud through the connected
GitHub app because the shell had no private-repository Git credentials.

Environment:

- Node.js 24
- repository-pinned pnpm 11.8.0
- frozen `pnpm-lock.yaml`

Results:

- `pnpm install --frozen-lockfile`: passed
- `pnpm lint`: passed
  - initially found formatting errors in `BLUEMI.md` and
    `apps/desktop/assets/tastecode-icon.icon/icon.json`
  - both were formatted and committed
- `pnpm typecheck`: passed for every workspace project
- `pnpm test`: passed for every workspace project
  - web: 818 tests
  - server: 375 tests
  - desktop: 68 tests
  - every package and adapter suite also passed
- `pnpm build`: passed
- desktop preload build: passed
- Electron Linux unpacked packaging: passed
- packaged `app.asar`: present
- packaged `app-update.yml`: present
- packaged web application: present
- packaged legal and third-party resources: present
- release uploader fixtures: passed
- checksum helper fixtures: passed

The full 132-file Design Agent reference-image library was included for the final test run. The
initial missing-image failure was caused only by the first cloud checkout excluding binary
reference assets; after fetching them, the suite passed without a code change.

The connector could not download the repository's 1.5 MB app icon. Linux packaging therefore used
the existing smaller 512x512 icon as a local-only fallback. That fallback was never pushed and
does not validate the final icon appearance.

Starting the unpacked Electron binary was blocked before application code by the cloud sandbox.
Chromium could not create its required local process-singleton socket. Packaging succeeded, but
this environment could not provide a real GUI runtime test.

The Linux cloud cannot truthfully test:

- the Windows NSIS GUI flow
- Windows SmartScreen wording
- Authenticode on the final EXE
- Start menu and shortcut behavior
- macOS signing, notarization, stapling, or Gatekeeper
- a real provider login and response in the packaged desktop UI

## Landing-page validation

The local landing-page production build passed after the final GitHub Release URL changes.

Results:

- `npm run build`: passed
- TypeScript: passed
- all nine static pages and routes generated
- the Windows link matches
  `TasteCode-0.1.0-beta.1-win-x64.exe`
- the macOS link matches
  `TasteCode-0.1.0-beta.1-mac-arm64.dmg`

The protected Vercel preview could not be inspected without its signed-in session. A final human
desktop and mobile visual pass is still required. Do not merge the landing page before the
product repository is public and the prerelease is published because the direct download links
do not work publicly before then.

## Leon's next local Codex session

Fetch before doing anything. Do not assume a stale local branch matches GitHub.

Recommended starting point:

```text
git fetch --all --prune
git switch agent/release-artifact-proof
git pull --ff-only
git status --short --branch
```

If the local working tree has unrelated changes, preserve them and inspect ownership before
staging or switching. Do not reset, clean, or delete another agent's work.

Run the Windows gates from the release branch:

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

Then perform the real Windows smoke test:

1. Confirm the EXE, EXE blockmap, `beta.yml`, and Windows checksum file exist.
2. Compare the EXE checksum with `SHA256SUMS-windows-x64.txt`.
3. Confirm `Get-AuthenticodeSignature` reports `NotSigned` if Windows remains unsigned.
4. Run the normal interactive installer, including one non-default installation directory.
5. Launch from the Start menu and desktop shortcut if one is created.
6. Complete first-run setup.
7. Sign in to one shipped provider and receive one real response.
8. Open a project and test terminal, attachment, approval, diff/checkpoint, and Design Mode.
9. Quit and relaunch; confirm user data is preserved.
10. Uninstall and confirm the documented user-data retention behavior.
11. Record the exact SmartScreen warning for release notes.

Do not upload this branch build as final if the launch PRs will still be merged. After merging,
rebuild from the exact resulting `main` commit and record that SHA.

## Blueemi's macOS work

Blueemi owns the Apple Developer signing and notarization path.

Blueemi should:

1. Fetch the exact final product commit used for Windows.
2. Run install, lint, typecheck, test, and build locally.
3. Build Apple Silicon DMG and ZIP artifacts.
4. Sign the application and installer.
5. Notarize and staple the deliverables.
6. Verify with `codesign`, `spctl`, `stapler`, `hdiutil verify`, and `unzip -t`.
7. Test DMG drag-to-Applications, first Finder launch, provider login/response, project open,
   terminal, attachment, approval, checkpoint, Design Mode, relaunch, and removal.
8. Generate `SHA256SUMS-macos-arm64.txt` after signing.
9. Upload the signed assets to the same single private draft as Windows.

Signing changes hashes. Never reuse the checksum file from an unsigned macOS proof.

If signing cannot be completed in time, Leon must explicitly approve an unsigned macOS beta and
the user-facing warning before publication.

## Required final draft assets

The single clean private draft must target the exact final product commit and contain only:

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

It must not contain `builder-debug.yml`, effective configuration, logs, credentials, or
unrelated files.

## Safe completion order

Do not combine these steps or skip the private verification stage.

1. Review PR #936's license, security address, dependency inventory, provider terms, and
   trademarks.
2. Replace the short root license notice with GitHub's full Apache-2.0 template.
3. Run the current release branch locally on Windows and complete the physical smoke test.
4. Blueemi completes the signed/notarized macOS build and physical smoke test.
5. With Leon's explicit approval, merge PR #936 first and PR #937 second.
6. Record the resulting exact product `main` commit.
7. Delete both obsolete duplicate private drafts.
8. Rebuild Windows and macOS from that exact final commit.
9. Create one private draft and upload both platforms plus updater metadata and checksums.
10. Verify the draft target, asset allowlist, sizes, hashes, and update metadata while private.
11. Make the product repository public.
12. Publish the prerelease.
13. Merge landing-page PR #1.
14. Verify desktop/mobile, legal/support pages, robots, sitemap, and both public downloads.
15. Perform one clean public download per platform.
16. Announce only after all public checks pass.

One older-to-newer beta updater proof cannot be completed until a second beta version exists. Do
not block the first beta on that impossible precondition, but do not claim end-to-end updater
proof until a later beta verifies it.

## Scope discipline

Do not pull issue #25 into this release. Do not add telemetry, new providers, new release
architecture, or unrelated design changes during launch preparation.

Fix only confirmed launch blockers. Keep all secrets out of code, commits, PRs, issues, logs, and
handoff files.
