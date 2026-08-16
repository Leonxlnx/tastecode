# Blueemi release handoff

Updated: 2026-08-16  
Planned launch: 2026-08-17 15:00 CEST / 21:00 China Standard Time  
Product main at handoff: `d3bcf3e7da25c9d9392964b0826a00849833390b`

## Hard stop

Leon is travelling and explicitly said not to launch yet.

Do not:

- publish the draft release
- make either repository public
- merge either launch pull request
- merge the open-source pull request
- announce the beta

Prepare, test, and report only. Wait for Leon's explicit go-ahead for every public action.

## Active repositories and pull requests

### Product

- Repository: `Leonxlnx/tastecode`
- Main is protected and has not been changed by this launch preparation.
- Open-source preparation: draft PR #936
  - https://github.com/Leonxlnx/tastecode/pull/936
- Release proof: draft PR #937
  - https://github.com/Leonxlnx/tastecode/pull/937
  - branch: `agent/release-artifact-proof`
  - head: `60e9f35743916d9bfe7bc2f73f48a5f0589d01c1`

### Landing page

- Repository: `Leonxlnx/tastecode-landingpage`
- Public beta site: draft PR #1
  - https://github.com/Leonxlnx/tastecode-landingpage/pull/1
  - branch: `feat/public-beta-launch`
  - head: `adf5a5fc9ab174eda41c472683ce2976abc63a2d`
- Nothing has been merged to landing-page main.

## Work completed in PR #937

- Added a branch-scoped Windows and macOS release proof workflow.
- The workflow runs install, format, typecheck, all tests, build, preload, native packaging,
  platform smoke tests, SHA-256 generation, and draft-release upload.
- Windows packaging creates an unsigned x64 NSIS installer.
- The Windows smoke test verifies the expected unsigned state, performs a silent install,
  confirms the installed executable, and performs a silent uninstall.
- macOS packaging creates unsigned Apple Silicon DMG and ZIP files.
- The macOS smoke test verifies both containers with `hdiutil verify` and `unzip -t`.
- The app update provider now uses the public GitHub Releases provider for
  `Leonxlnx/tastecode`. The updater already enables prerelease versions.
- Added a cross-platform Node checksum helper.
- Added a draft-release upload helper that refuses non-draft releases, accepts only public
  distribution files, removes known internal builder files, and updates the release target
  to the exact build commit.
- Fixed the Windows-only `EBUSY` test cleanup race by allowing the preview process tree more
  time to release its temporary directory.

Official electron-builder publishing configuration reference:
https://www.electron.build/docs/publish

## Hosted validation already completed

macOS job from run `31940973817` completed successfully through:

- dependency install
- format
- typecheck
- all 372 server tests and the remaining workspace tests
- production build
- preload build
- native Apple Silicon DMG and ZIP packaging
- SHA-256 generation
- upload to the private draft release

The first Windows job reached the test step successfully. It passed install, format, and
typecheck. Test results were 371 passed and one failed. The only failure was cleanup after
`stops the complete preview process tree`; Windows briefly retained a temporary-directory
handle. The retry-tolerance fix is in PR #937, but GitHub has not allowed the final run to
execute yet.

## Current GitHub Actions blocker

Final run:
https://github.com/Leonxlnx/tastecode/actions/runs/31941608385

Both jobs were rejected before the first step. GitHub's exact annotation says that recent
account payments failed or the Actions spending limit must be increased.

Required next action:

1. Open GitHub Settings, then Billing & plans.
2. Fix the failed payment or increase the Actions spending limit.
3. Rerun all failed jobs for run `31941608385`.
4. Do not accept a partial result. Both matrix jobs must be green on commit
   `60e9f35743916d9bfe7bc2f73f48a5f0589d01c1` or a later reviewed commit.

Do not work around this by publishing the older artifacts. The final workflow contains the
updater-provider fix, strict asset filtering, internal-file cleanup, and installer smoke tests.

## Private draft release

Draft URL:
https://github.com/Leonxlnx/tastecode/releases/tag/untagged-caf9234c197cdc600015

Current state:

- draft: yes
- prerelease: yes
- tag intent: `v0.1.0-beta.1`
- target is still the older proof commit `a0e5777cecaccc125745ec26acc19909f84919c0`
- Windows assets are not present
- `builder-debug.yml` is still present
- do not publish this state

Current macOS proof assets and GitHub-computed SHA-256 digests:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `TasteCode-0.1.0-beta.1-mac-arm64.dmg` | 219,558,691 | `24c1ddf6aabc4cf99f45647d5e27909c91af424b940fb7905f29adb107a26909` |
| `TasteCode-0.1.0-beta.1-mac-arm64.dmg.blockmap` | 229,444 | `ba9ba3c42b8ad61cd631bae93509577df6d34991566a15b3ec1809e3aec75e6c` |
| `TasteCode-0.1.0-beta.1-mac-arm64.zip` | 220,915,183 | `6c967d195e66684f0ab943066acdcc82eb5ad79ef9107396092d7ad4a9d98efa` |
| `TasteCode-0.1.0-beta.1-mac-arm64.zip.blockmap` | 230,728 | `063bae15518ec698dd6f2e44d10d38f4a84507bf064402891d4d2d3291eeb019` |
| `beta-mac.yml` | 543 | `980a3aff05bd0412448c1a4171c273eca98b9708c93e359652af64aaf2cae4e1` |

The next successful final run must:

- move the draft target to the final workflow commit
- remove `builder-debug.yml`
- replace the macOS proof with artifacts built from the final commit
- add the Windows installer, blockmap, `beta.yml`, and Windows checksum file
- leave only intended distribution assets and both checksum files

Expected public asset names:

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

## Blueemi macOS work

The current cloud proof is unsigned. Blueemi has the Apple Developer account and owns the
final signing and notarization decision.

After the final unsigned matrix run is green:

1. Build from the exact approved release commit, not from another local branch.
2. Sign the app and installer using repository secrets or a controlled local keychain. Never
   commit certificates, passwords, profiles, or tokens.
3. Notarize and staple the final deliverables.
4. Verify the final app and disk image on a clean Apple Silicon Mac.
5. Replace the unsigned macOS assets in the private draft only after all checks pass.
6. Recalculate and replace the macOS checksum file after signing because signing changes the
   binary hashes.

Suggested local verification:

```text
codesign --verify --deep --strict --verbose=2 "TasteCode.app"
spctl --assess --type execute --verbose=4 "TasteCode.app"
xcrun stapler validate "TasteCode.app"
hdiutil verify "TasteCode-0.1.0-beta.1-mac-arm64.dmg"
```

Also test:

- DMG open and drag-to-Applications flow
- first launch through Finder
- provider sign-in and one real response
- project open, terminal, attachment, approval, checkpoint, and Design Mode
- quit and relaunch with user data preserved
- uninstall or removal instructions

If signing cannot be completed before launch, leave macOS unsigned only after Leon explicitly
accepts that release posture and the user-facing warning is verified.

## Windows work after Actions is unblocked

The cloud workflow will perform silent install and uninstall. Leon should still perform a
clean-machine GUI pass on Windows because a hosted runner cannot prove the real first-run UX.

Required manual checks:

- download the installer from the private draft release
- compare its SHA-256 with `SHA256SUMS-windows-x64.txt`
- confirm `Get-AuthenticodeSignature` reports `NotSigned` for the planned unsigned beta
- run the normal interactive installer with a non-default directory once
- launch from Start Menu and desktop shortcut if present
- complete first-run setup
- sign in to one shipped provider and receive a real response
- open a project and exercise terminal, attachment, approval, diff, checkpoint, and Design Mode
- quit and relaunch with user data preserved
- run uninstall and confirm user data follows the documented retention behavior
- record any SmartScreen wording for the release notes

## Landing page status

PR #1 now links directly to the final GitHub Release asset names instead of nonexistent files
under the Vercel site. This matches the app's GitHub updater provider.

Latest local validation:

- `npm run build` passed
- TypeScript passed
- all nine static routes generated

The Vercel preview is access-protected from external visual inspection. Leon or Blueemi must
perform the final signed-in desktop and mobile visual pass.

Do not merge the landing page before the product repository is public and the prerelease is
published. The direct download links intentionally return no public file while the release is
still a private draft.

## Open-source PR #936

Do not merge PR #936 until both contributors explicitly approve:

- Apache-2.0
- `TasteCode contributors` copyright wording
- the monitored security contact `hello@tasteskill.dev`
- the production dependency license inventory
- bundled root license and required third-party notices
- provider terms and trademark posture

The long Apache license text was not copied into the repository by ChatGPT Work. PR #936 uses a
short SPDX notice and links to the canonical terms. Confirm that this is the intended repository
license presentation before making the repository public.

## Issues and scope

The only open issue at this handoff is #25, assigned to Blueemi and labeled `target:later`:
https://github.com/Leonxlnx/tastecode/issues/25

It has no milestone and is not a beta launch blocker. Do not add it to this release.

## Safe completion order after Leon returns

1. Fix GitHub Actions billing and rerun the final release workflow.
2. Require both Windows and macOS jobs to pass every step.
3. Inspect the private draft asset list, target commit, sizes, and SHA-256 values.
4. Complete Windows clean-machine GUI QA.
5. Complete macOS signing, notarization, and clean-machine QA if time permits.
6. Review and approve PR #936 legal and open-source decisions.
7. Review PR #937 and keep the release draft.
8. Review the protected Vercel preview on desktop and mobile.
9. Prove one real beta-to-newer-beta update before claiming updater support is end-to-end proven.
10. Only with Leon's explicit approval: merge the reviewed PRs, make the product repository public,
    publish the prerelease, merge the landing page, and run final public URL/download checks.

Until step 10 is explicitly approved, nothing should become public.
