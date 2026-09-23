# Desktop releases and in-app updates

Packages use public releases in `Leonxlnx/tastecode`. End users do not need a GitHub
account or token. Only published releases are discoverable; drafts remain invisible.
A source merge or tag alone is not an app update.

The app checks after 15 seconds and hourly while open. It downloads a newer compatible
version in the background, shows an in-app notice, and offers **Restart to update** under
**Settings → About**. Users can defer the restart; a prepared update also installs on normal
quit. A ready download is retained until installation. From beta 7, the app reads the GitHub
release list. Beta 7 through 0.1.1 choose the newest publication, including prereleases,
regardless of the GitHub "Latest" badge. The next desktop build selects the highest semantic
version instead. Downgrades remain disabled. A missing matching installer or SHA-256
digest is an error; the app does not silently fall back to an older release.

## 0.1.2 source preparation

The next Windows x64 installer and macOS arm64 DMG/ZIP must be built from the same approved
`main` commit at desktop version 0.1.2. Windows remains intentionally unsigned; the macOS
release requires the maintainer's Developer ID signing and notarization. Keep 0.1.1 as the
latest public release until both new installers, digests, and platform proofs are verified.
Do not create or move a release tag before the final source commit is agreed.

## 0.1.1 published

Update-feed incident, 2026-09-22: the Linux-only Beta 8 packaging proof was published on
September 21 after 0.1.1. Existing clients selected it by publication date and failed on
its missing Windows/macOS installer before checking for a downgrade. The proof was returned
to draft with all five assets and the tag retained; its Linux downloads are private again.
Anonymous checks using the unmodified 0.1.1 provider now resolve 0.1.1 on both platforms.
Users can retry **Check for updates** without reinstalling. Keep that proof in draft:
publishing it again would break existing clients even after the source fix merges.
The next build sorts valid release tags by semantic version; missing or unsafe assets in
the highest version still fail validation. No existing installer was replaced.

[Version 0.1.1](https://github.com/Leonxlnx/tastecode/releases/tag/v0.1.1) was published on
2026-09-20 at 19:10 UTC from `d2b3754cdb72090db3a80868f617d2e48dc8effc`, with both installers
and the GitHub Latest badge. It fixes npm-dependent Codex installation, unbounded Design
repair corrections, and local disconnections when live updates arrive during large history
replies. Windows remains unsigned by the release owner's choice; macOS is Developer ID
signed, notarized and stapled.

The [Windows installed-upgrade run](https://github.com/Leonxlnx/tastecode/actions/runs/35528051951)
built this exact source and passed the real Beta 9 Settings update button, installer checksum,
NSIS replacement, automatic relaunch, and chat/settings preservation. The
[macOS maintainer's report](https://github.com/Leonxlnx/tastecode/pull/1271#issuecomment-5751844653)
records fresh-profile startup, Codex installation without npm or Node on PATH, signing,
notarization, Gatekeeper, native bindings, a 2,000-message chat reopened three times, and a
21,994,782-byte history response followed by another RPC on the same connection. The installed
Beta 9 updater verified the DMG and Squirrel replaced the app while preserving chats/settings.
macOS relaunch was controlled to retain isolated test paths; automatic macOS relaunch and
authenticated model calls were not established by these tests. Before publication, only
release metadata/download transport was redirected to the verified candidates on loopback;
the Windows installer wizard was automated silently.

The macOS maintainer combined both platform manifests and passed `verify-release-assets.js`
on all 12 proof files before adding the DMG with the strict draft uploader. Both assets share
configuration hash `349106a665e31726c85880ef43d80e9b73b7f7e46ed8cb990cd9598ab0d72f1b`.
After publication, anonymous production updater discovery selected 0.1.1 for Windows x64
and macOS arm64. Both public URLs returned HTTP 200 with the expected size, and GitHub's
SHA-256 digests matched the tested artifacts. The release tag points to the approved source.

| Installer                       |     Bytes | SHA-256                                                            |
| ------------------------------- | --------: | ------------------------------------------------------------------ |
| `TasteCode-0.1.1-win-x64.exe`   | 510259160 | `2fb21221b779562b20eb6aecce064d260b0644e4776931285c344ce59cea7fa0` |
| `TasteCode-0.1.1-mac-arm64.dmg` | 533904193 | `440c18c2ca2143ac4a6746a3757f3f784ab5256db620ff16996b42eb47678231` |

Beta 7 and Beta 9 users can select **Settings → About → Check for updates**, then
**Restart to update** after the download finishes. Beta 9 also shows the sidebar update
control. Beta 6 and earlier users who missed the bridge need the current installer.

## Beta 7 bridge, then two public files

Beta 9 was published on 2026-09-20 from
`b65a844f7ed6e1d6816d482a48508076fd7383fa`, with exactly two installers and the
GitHub Latest badge. Windows is intentionally unsigned; macOS is Developer ID signed,
notarized and stapled. The isolated Windows beta 7 update-button test passed real
installation, automatic relaunch and preservation of chats/settings. The macOS
maintainer verified the installed beta 7 upgrade and fresh-profile starts.
See [release evidence and limits](verification/beta9-release-2026-09-20/README.md).
Existing beta 7 users can update under Settings → About; beta 9 adds download progress
and the ready/restart button beside the sidebar profile. Beta 6 and older users who
missed the bridge need a manual installer. The older beta 8 draft remains unpublished.

Beta 8 preparation (2026-09-18): the release owner authorized an unsigned Windows
build and publication, with macOS built separately by its maintainer. Build both
platforms from the same tagged main commit. This version includes the internal
review-chat import fix and per-chat composer settings fixes. Keep the release in
draft until both matching installers and their GitHub digests are present; beta 7
clients report an error when the newest release lacks their platform's installer.

Beta 7 is the transition release. It includes the new asset updater **and** the old YAML,
ZIP, and blockmap files so beta 6 can install it through its existing updater. Keep beta 7
available long enough for users to update before publishing beta 8.

From **0.1.0-beta.8**, `upload-draft-release.js` uploads exactly two public assets:

- `TasteCode-<version>-win-x64.exe`
- `TasteCode-<version>-mac-arm64.dmg`

The local package proof still includes generated metadata, ZIP, blockmaps, checksums, and
provenance. These remain local/CI proof files. The upload script verifies the complete
local proof and checks GitHub's SHA-256 digest for each of the two uploaded files.

The new client checks the downloaded installer against GitHub's digest and size. On macOS,
it mounts the DMG read-only, checks the bundle ID, version, and code signature, and makes a
temporary ZIP locally. Electron's native Squirrel.Mac installer still verifies signing
identity and performs the replacement. Windows still uses electron-updater's NSIS installer
and configured publisher verification. Neither path needs public YAML or blockmaps.

**Beta 6 users must install beta 7 during the transition.** Once beta 8 is the newest
release, beta 6 will look for YAML in beta 8 and fail. Keeping beta 7's assets alone does
not make beta 6 fall back to it. Those remaining users need a manual installer. Beta 7
users can update directly to beta 8 or any later compatible release. Do not remove or
replace files from the already published beta 6 or beta 7 releases.

Local validation on 2026-09-18: all 197 desktop tests and 50 release-tool/license tests
passed, along with desktop type checking, lint, formatting, and build. The new reader also
resolved the live beta 6 DMG and its GitHub digest. The published signed beta 6 DMG passed
local ZIP preparation and archive verification; a wrong-version request was rejected and
the volume was detached.

Isolated Developer ID-signed Electron fixtures completed native beta 6 → beta 7 via the
legacy YAML/ZIP updater, then beta 7 → beta 8 via the new DMG path, including app replacement,
relaunch, and preserved test profile data. The beta 8 fixture exposed only EXE/DMG assets.
This proves the update engines, not production database migrations or Windows installation.
Beta 7 macOS is published as a normal release from commit
`82f714614bfa9454a9c8ee9bc681d15712a3df89`. Apple accepted the app and DMG, both tickets
are stapled, Gatekeeper accepts both, and packaged native bindings and three fresh-data
launches pass. A signed production beta 6 copy downloaded beta 7 from the public GitHub
release, installed through Squirrel on quit, and reopened as beta 7 with its test chat and
renderer setting intact. The reopened beta 7 updater also read the public release correctly.
The test used isolated app and data directories; its relaunch was controlled to keep those
test-only data paths. The earlier signed fixtures separately proved automatic relaunch.

Windows beta 7 is now published from that same tagged source commit. The release owner
explicitly approved another unsigned Windows release because no trusted signing identity
was available. Both the application and installer report `NotSigned`; Windows may display
an unknown-publisher or SmartScreen warning.

Windows validation: lint, type checking, the full test suite, build, license verification,
packaged resources and PTY/keyring checks passed. An initial Markdown timing test failed
during concurrent checks, then passed unchanged both in isolation and in the full rerun.
All five uploaded asset digests match local files. An anonymous public installer download
matches SHA-256 `ff8f0dd8f08b3165da8a714f42e3311f9560c462be374e6792efc3247c075129`.
Both the legacy beta 6 GitHub provider and the new asset provider discover beta 7 without
credentials. The legacy provider successfully falls back to `latest.yml`.

A parallel fresh-profile startup attempt collided with the existing desktop's server on
port 4311. The active installation was left running. A beta 7 Windows clean installation
and real beta 6-to-7 installed upgrade remain unverified; metadata discovery and native
binding checks do not establish those results.

## Prepare, build, then publish

Published Windows and macOS beta, 2026-09-18:
[beta 6](https://github.com/Leonxlnx/tastecode/releases/tag/v0.1.0-beta.6) is pinned to
`2bc6d252bffd749bd5aaba3d556d314ba7a800e3`. Its unsigned Windows installer, packaged
resources, PTY/keyring modules, metadata and five remote asset hashes passed verification.
The public Windows installer was downloaded again, its SHA-256 verified, and installed
after uninstalling beta 5 with the user's explicit approval. The prior app profile and a
consistent database snapshot were preserved. Installed resources, PTY/keyring modules,
fresh-profile onboarding, and a live GitHub update check passed; the installed app reported
beta 6 as current. This clean installation does not prove an automatic version-to-version
upgrade or migration of an existing profile.

macOS DMG, ZIP, blockmaps, metadata, checksums, and provenance are now publicly available
from the same source commit. The macOS owner's release report records Developer ID signing,
Apple notarization, Gatekeeper acceptance, native bindings, and three fresh-data launches.
Both primary downloads and the macOS ZIP returned HTTP 200. The two obsolete unsigned
beta 1 draft releases were removed before beta 7 publication.

Never replace published files or change the tag. Except for the approved beta 7 macOS-first
release below, subsequent releases must stage both
platforms together before publication, because GitHub-connected macOS clients would
otherwise discover a release without matching metadata.

[Direct Windows download](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.7/TasteCode-0.1.0-beta.7-win-x64.exe)
works without a GitHub login and can be used on the landing page.

1. Finish the intended merges, choose a version higher than every distributed build, and
   merge the version change. `0.1.0-beta.6` is already published. Do not reuse
   a version or replace files in a published release.
2. Pin the final clean `main` commit. Build Windows and macOS from that same commit and
   configuration. Set `APPROVED_SHA` and `EVENT_SHA` to its full SHA and `EVENT_REF` to
   `refs/heads/main`, then run `node tools/scripts/verify-release-input.js`.
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm licenses:verify`.
   Package with `--publish never`. Always use the draft upload script below to select public
   assets; electron-builder's direct publication would upload the local proof files too.
   The existing manual **Release artifact proof** workflow
   can produce unsigned test artifacts when explicitly authorized; it is not a signed
   production release or an automatic tag-triggered workflow.
4. Verify native bindings, packaged resources, install/start behavior, and signing on the
   target OS. macOS requires a signed and notarized app. Beta 7 also needs the public ZIP
   for beta 6 clients; later clients create that ZIP locally from the DMG.
   Run the Windows installer proof only on its isolated runner; never install/uninstall a
   test package over an active developer installation.
5. Generate each platform's checksums/provenance with
   `node tools/scripts/release-checksums.js <output-directory> <windows|macos>`, then use
   `stage-release-assets.js` to copy its exact assets into a new directory. Combine both
   staged directories and run `node tools/scripts/verify-release-assets.js <combined-directory>`.
6. There must be one draft for the version. A preparation draft is an empty reservation,
   not a source approval. Before upload, explicitly align its target to the approved SHA,
   its title to `Taste Code <version> — packaging proof`, and its body to
   `draftDescription(approvedSha)` from `tools/scripts/upload-draft-release.js`. Do this
   before any asset upload. The writer deliberately refuses a stale or mismatched draft.
7. Set `GITHUB_REPOSITORY=Leonxlnx/tastecode`, provide the maintainer's `GITHUB_TOKEN` only
   in the release process environment, and set `RELEASE_UPLOAD_APPROVAL` to the same SHA.
   Run `node tools/scripts/upload-draft-release.js <combined-directory>`. It verifies
   every remote digest, refuses replacements, and leaves the release in draft.
8. Inspect all assets and replace the proof-only notes with reviewed public release notes.
   Publish beta 7 as a **normal release**, with `prerelease=false` and `make_latest=true`. Both platforms should
   normally be present before publication. For beta 7, the release owner explicitly approved
   macOS first and Windows later on the same tag. Beta 7 still needs each available platform's
   compatibility files. Public publication is the point at which apps see it.

For the beta 7 bridge, GitHub metadata is named **`latest.yml`** for Windows and
**`latest-mac.yml`** for macOS. Beta 6's updater selects the beta tag and falls back to those
files inside that tag. The packager generates them; do not handwrite hashes or rename them
to the generic provider's `beta.yml`. Upload the installers/ZIP, blockmaps, metadata,
checksums and provenance together for beta 7. From beta 8, only the EXE and DMG are uploaded.
Builder debug output and unpacked app directories are not release assets.

After the first publication, verify a real old-to-new installed upgrade with existing
chats/settings on each OS. Unit tests and a draft cannot establish that result. For a
bad published build, ship a higher patched version; never silently downgrade or replace
the published bytes.

## Existing beta 5 and earlier installations

Those packages still contain the old `https://tastecode.dev/releases` generic feed.
They need a one-time installation of the new installer, preserving the normal application
data, or website-side compatibility redirects. For redirects, map `beta.yml` to the chosen
published tag's `latest.yml`, `beta-mac.yml` to `latest-mac.yml`, and **every referenced
artifact and blockmap filename** to that tag's GitHub download. Redirecting only YAML is
insufficient because the old client resolves artifact URLs against the original feed.
Do not redirect to a draft or rely on GitHub's `/latest/download` for prereleases.

The website redirects are a separate deployment; changing this repository does not update
an already installed package's feed. No GitHub credential belongs in the website redirect
or distributed app.

Reference: [electron-builder auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/).

## Add Windows to the macOS-first beta 7 release

Beta 7 is published as a normal GitHub release with both platforms. The Windows maintainer
added the five Windows files below to the existing release, with `latest.yml` uploaded last.
The owner approved unsigned Windows publication for this beta; trusted signing and an
installed Windows upgrade proof remain outstanding. Do not repeat these uploads, replace
published bytes, remove beta 6, or alter any existing macOS asset.

1. Fetch `v0.1.0-beta.7` and use its exact commit in a clean checkout. Set `APPROVED_SHA`
   and `EVENT_SHA` to `git rev-parse v0.1.0-beta.7^{commit}` and `EVENT_REF=refs/heads/main`.
   Run `node tools/scripts/verify-release-input.js` and all four local checks.
2. On Windows x64, configure the trusted signing identity in the process environment. Run
   `pnpm --filter @harness/desktop dist --win --x64 --publish never`. Verify the installer
   with `Get-AuthenticodeSignature` (status `Valid`), then test installation, app startup,
   native bindings, and an installed beta 6 to beta 7 update on an isolated Windows machine.
3. Run `node tools/scripts/release-checksums.js release windows`, then
   `node tools/scripts/stage-release-assets.js release release/beta7-windows-upload windows`.
   This checks the EXE, blockmap, generated `latest.yml`, checksums, and source provenance.
4. Add the files below with `gh release upload v0.1.0-beta.7 <file> --repo Leonxlnx/tastecode`.
   Upload the EXE and blockmap first, checksums and provenance next, and **`latest.yml` last**
   so beta 6 clients cannot discover a half-uploaded Windows package. Never use `--clobber`.
   - `TasteCode-0.1.0-beta.7-win-x64.exe`
   - `TasteCode-0.1.0-beta.7-win-x64.exe.blockmap`
   - `SHA256SUMS-windows-x64.txt`
   - `PROVENANCE-windows-x64.json`
   - `latest.yml`
5. Verify every remote SHA-256 digest against the staged bytes, test an anonymous update
   check and installed upgrade, then update the release notes and README Windows link.
   Keep the release published with `prerelease=false`; do not replace the tag or Mac files.

This additive upload is the explicit beta 7 exception to draft-only release assembly.
The draft uploader remains strict and must not be used against a published release.
