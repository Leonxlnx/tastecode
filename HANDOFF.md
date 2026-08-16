# TasteCode release handoff

Updated: 2026-08-16  
Repository: `D:\personalharness`  
Source snapshot before this document: `main` at `379f7639`

Read `AGENTS.md`, `rules/`, `docs/dashboard.html`, `docs/feature-inventory.html`, and
`docs/DESIGN-AGENT.md` before changing code. GitHub is the authority for live ownership.

## Current state

- All pull requests are merged or closed. There are no open PRs.
- The only open issue is #25, labeled `target:later`; it is not a beta blocker.
- The shipped beta providers are Codex, Claude Code, and Grok.
- The root worktree may contain user-owned untracked files. Never delete or stage them.
- The shared development app may belong to another task. Do not restart it without checking.

## Release work merged in the final pass

- #932: packaged-app update checks and download/install UI using the generic
  `https://tastecode.dev/releases` feed.
- #933: bounded local diagnostics plus user-controlled folder reveal and scrubbed report copy.
  Nothing is uploaded automatically. Secrets, emails, project paths, and Windows/macOS/Linux home
  paths are redacted.
- #934: one-time empty-state onboarding with the existing project picker, compact status for the
  three beta providers, provider setup, local-first copy, keyboard focus, and Escape dismissal.
- The exact final product branch passed `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build`. The last run recorded Web 790, Server 372, Desktop 66, and every package/adapter
  green. Onboarding production component/CSS had zero browser console warnings or errors.

## Packaging proof

`pnpm --filter @harness/desktop dist` produced a Windows NSIS installer from the verified update
stack:

- `TasteCode-0.1.0-beta.1-win-x64.exe`
- 184,416,599 bytes
- blockmap and `beta.yml` generated
- Authenticode status: `NotSigned`

This proves packaging, not distribution. There is no GitHub release and the public update feed is
not populated yet.

## Must finish before a public beta

1. **Finish Design Mode acceptance.** M4 remains the active product workstream. It must build the
   TasteCode landing page to human ship quality and pass the provider plus Windows/macOS smoke
   matrix in `docs/DESIGN-AGENT.md`.
2. **Publish release artifacts.** Upload the Windows installer, blockmap, and `beta.yml` to
   `https://tastecode.dev/releases`; publish the matching macOS ZIP/DMG metadata. The feed currently
   returns 404 and `gh release list` is empty.
3. **Prove the updater end to end.** Install an older packaged beta, publish a newer beta, update,
   relaunch, and verify user data. Define and exercise rollback; the client currently covers
   check/download/install, not a proven rollback path.
4. **Run clean-machine packaging QA.** Fresh Windows install to first real provider response, then
   the equivalent packaged macOS run. Test install, update, uninstall, projects, provider sign-in,
   attachments, approvals, and Design Mode.
5. **Decide signing.** The Windows artifact is unsigned and will produce SmartScreen friction.
   macOS signing/notarization has not been proven. An unsigned invite-only beta is possible only if
   users are explicitly told how to verify and open it; it is not a polished public launch.
6. **Finish the launch site.** `tastecode.dev` still needs working downloads, release notes,
   requirements, provider setup notes, support contact, privacy/terms pages, and the update-feed
   files. Do not point the app at placeholder downloads.
7. **Choose the distribution/legal posture.** The repository currently grants no source license.
   Before making it public, decide the copyright holder and license, complete notices, and add
   `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`. See
   `docs/LICENSING.md`. Claude subscription/OAuth distribution also needs a provider-terms decision;
   the safe public path is an approved integration or API-key/Console setup.
8. **Choose crash intake.** Local private diagnostics are shipped. Remote crash/error submission is
   not. Either keep the beta explicitly manual-export only or add an opt-in endpoint with consent,
   retention, deletion, privacy copy, and redaction review.
9. **Create the release workflow.** GitHub currently has only the manual CI workflow. Add a manual
   release workflow after signing and artifact-hosting inputs exist; do not automate an unsigned,
   untested upload first.

## Recommended next order

1. Complete Design Mode acceptance.
2. Build and smoke-test packaged Windows and macOS artifacts.
3. Decide signing and legal/distribution posture.
4. Publish a private beta release and update feed.
5. Run one real version-to-version update.
6. Finish downloads, legal/support pages, and release notes.
7. Only then announce the public beta.

Do not add more onboarding, updater, or telemetry architecture before these checks fail in a real
packaged run. The current implementations are deliberately small and sufficient for that proof.
