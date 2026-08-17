# TasteCode release handoff

Updated: 2026-08-16  
Product main at audit: `d3bcf3e7da25c9d9392964b0826a00849833390b`  
Target launch: 2026-08-17 15:00 CEST / 21:00 China Standard Time

Read `AGENTS.md`, `rules/`, `docs/dashboard.html`, `docs/feature-inventory.html`, and
`docs/DESIGN-AGENT.md` before changing code. GitHub is the authority for live ownership.

## Current state

- The exact product snapshot passed `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build`. Recorded suites: Web 790, Server 372, Desktop 66, all packages and adapters green.
- The shipped beta providers are Codex, Claude Code, and Grok.
- Issue #25 is already labeled `target:later`, has no milestone, and is not a launch blocker.
- PR #936 prepares the repository for open source. It is intentionally a draft.
- Landing-page PR #1 prepares the public beta site. Vercel built the preview successfully.
- The shared development app and untracked files may belong to active work. Never delete, stage,
  restart, or overwrite them without checking ownership.

## Cloud launch work completed

### Product repository

Draft PR: https://github.com/Leonxlnx/tastecode/pull/936

- refreshed the README for `0.1.0-beta.1`
- added the Apache License 2.0
- added `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`
- documented dependency, notice, provider-terms, and checksum obligations
- left Design Mode and desktop packaging untouched

Do not merge PR #936 until Leon and Blueemi both approve Apache-2.0 and the
`TasteCode contributors` copyright wording, confirm the security inbox, and complete the
production dependency license inventory.

### Launch site

Draft PR: https://github.com/Leonxlnx/tastecode-landingpage/pull/1

- replaced the temporary coming-soon page with the public beta site
- advertised only Codex, Claude Code, and Grok
- added Windows x64 and macOS Apple Silicon download cards
- added release notes, privacy, terms, support, canonical metadata, robots, and sitemap
- disclosed unsigned beta builds
- passed local `npm run build` and the Vercel deployment check

Do not merge the site PR until final artifacts exist at the exact linked paths, checksums are
in the release notes, privacy and terms are reviewed, and the deployment preview receives a
manual desktop/mobile visual pass.

## Packaging proof

`pnpm --filter @harness/desktop dist` produced:

- `TasteCode-0.1.0-beta.1-win-x64.exe`
- 184,416,599 bytes
- its blockmap and `beta.yml`
- Authenticode status `NotSigned`

This proves packaging only. GitHub currently has zero releases. The public update feed and
download paths still return 404, so cloud download and updater testing cannot begin yet.

## Owners for the remaining release work

| Work | Owner | Required result |
| --- | --- | --- |
| Design Mode acceptance | Leon | Complete the acceptance matrix without changing unrelated launch work |
| Windows package and clean-machine QA | Leon | Final installer, blockmap, metadata, SHA-256, install and provider smoke test |
| macOS package, signing, notarization, QA | Blueemi | Final Apple Silicon DMG and ZIP, metadata, SHA-256, Gatekeeper and provider smoke test |
| License approval | Leon + Blueemi | Explicit approval on PR #936 |
| Artifact hosting and update feed | Either, coordinated | Exact files under `https://tastecode.dev/releases` |
| Final website review | Leon + Blueemi | Desktop/mobile review, legal copy approval, working downloads |

## Release blockers

1. Finish the Design Mode acceptance matrix in `docs/DESIGN-AGENT.md`.
2. Produce the final Windows and macOS artifacts from the exact release commit.
3. Generate SHA-256 checksums and complete clean-machine install/provider smoke tests.
4. Decide Windows signing. Unsigned is acceptable for the first beta only with a clear warning.
5. Blueemi signs and notarizes macOS if time permits; otherwise explicitly document the unsigned build.
6. Merge PR #936 only after both contributors approve the license and release obligations.
7. Bundle the root license and required third-party notices in both desktop packages.
8. Upload installers, blockmaps, ZIP, DMG, and updater metadata to the public release path.
9. Prove one real older-to-newer update and relaunch without losing user data.
10. Add final checksums to the release notes, review privacy/terms, visually review the preview,
    then merge the landing-page PR.
11. Change the product repository from private to public only after the secret scan and provider-terms review.
12. Run a final URL and download check immediately before the announcement.

## Monday sequence

Leon arrives at 05:00 China time, which is 23:00 Sunday in Germany. Preserve the long buffer for
clean-machine QA and updater proof.

1. `05:00-08:00 CST`: sync both platform builds to one exact commit; finish Design Mode acceptance.
2. `08:00-12:00 CST`: clean-machine Windows and macOS install/provider QA; fix only launch blockers.
3. `12:00-15:00 CST`: publish artifacts and update metadata; calculate checksums.
4. `15:00-18:00 CST`: prove the updater, verify downloads, review legal/support pages.
5. `18:00-20:00 CST`: merge approved PRs, make the repository public, run the final smoke pass.
6. `20:00 CST`: freeze changes. Launch at `21:00 CST / 15:00 CEST` only if every blocker above is closed.

Keep crash intake manual-export only for this beta. Do not add remote telemetry or new release
architecture unless a real packaged test proves it is required.
