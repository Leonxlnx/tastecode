# Desktop releases and in-app updates

New packages use the public `Leonxlnx/tastecode` GitHub release provider. End users do not
need a GitHub account or token. Only published releases are discoverable; drafts remain
invisible. A source merge is not an app update.

The app checks after 15 seconds and hourly while open. It downloads a newer compatible
version in the background, shows an in-app notice, and offers **Restart to update** under
**Settings → About**. Users can defer the restart. Beta installs accept beta and stable
releases; stable installs do not opt into prereleases. Downgrades remain disabled.

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
beta 1 draft releases were removed; beta 6 is the only release and tag.

Never replace published files or change the tag. Subsequent releases must stage both
platforms together before publication, because GitHub-connected macOS clients would
otherwise discover a release without matching metadata.

[Direct Windows download](https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.6/TasteCode-0.1.0-beta.6-win-x64.exe)
works without a GitHub login and can be used on the landing page.

1. Finish the intended merges, choose a version higher than every distributed build, and
   merge the version change. `0.1.0-beta.6` is already published. Do not reuse
   a version or replace files in a published release.
2. Pin the final clean `main` commit. Build Windows and macOS from that same commit and
   configuration. Set `APPROVED_SHA` and `EVENT_SHA` to its full SHA and `EVENT_REF` to
   `refs/heads/main`, then run `node tools/scripts/verify-release-input.js`.
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm licenses:verify`.
   Package with `--publish never`. The existing manual **Release artifact proof** workflow
   can produce unsigned test artifacts when explicitly authorized; it is not a signed
   production release or an automatic tag-triggered workflow.
4. Verify native bindings, packaged resources, install/start behavior, and signing on the
   target OS. macOS auto-update requires a signed app and a ZIP as well as the DMG.
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
   Publish the complete release as a **prerelease** for beta versions. Do not publish a
   Windows-only beta while the matching macOS metadata and ZIP are absent: both clients
   discover the same release. Public publication is the point at which apps see it.

GitHub metadata is named **`latest.yml`** for Windows and **`latest-mac.yml`** for macOS,
including beta releases. The pinned updater selects the beta tag and falls back to those
files inside that tag. The packager generates them; do not handwrite hashes or rename them
to the generic provider's `beta.yml`. Upload the installers/ZIP, blockmaps, metadata,
checksums and provenance together. Builder debug output and unpacked app directories are
not release assets.

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
