# TasteCode launch handoff

Updated: 2026-08-18 03:24 CEST / 2026-08-18 09:24 China Standard Time  
Launch status: paused; the previous target passed and a new time needs an explicit go/no-go  
GitHub is the authority for current commits, branches, pull requests, and release state.

## 2026-08-18 cloud implementation handoff — current authority

This section supersedes every older SHA, PR status, validation claim, and next-step sequence below.
Older sections remain only as history and context.

### Exact GitHub state

Product repository: `Leonxlnx/tastecode`  
Current product `main`: `bfc884773a760de216c1c79e4bf34f1a3f73e22f`

Nothing from this implementation pass was merged to `main`. Nothing was published, made public,
or deployed. No hosted GitHub Actions were started.

Open draft PRs that contain the launch work:

- #936 — `Prepare the repository and handoff for open source`
  - branch: `docs/oss-launch-readiness`
  - head: `97f518b48960feb176eadacacba49d0ef92167fa`
  - base: `main`
  - mergeable at this handoff boundary
  - merged forward to current `main` without rebasing
- #937 — `Prove Windows and macOS release artifacts in CI`
  - branch: `agent/release-artifact-proof`
  - head: `e3380290513bceeeaecd6f7d66edb8642cd9b698`
  - base: `main`
  - mergeable at this handoff boundary
  - merged forward to current `main` without rebasing
  - contains merge parents from #936 and #971 so the final release gate can exercise their license
    and native-binding tooling
- #959 — `fix(ui): restore visible focus and accessible input semantics`
  - branch: `agent/overnight-a11y-hardening`
  - head: `c0ca415f210614bb52b2d411aba4b522d98fb540`
  - currently conflicts with `main`; merge `main` into the branch and resolve locally
- #960 — `fix(proc): drain stdio before settling child output`
  - branch: `agent/overnight-stdio-drain`
  - head: `0990c497df4c6401272566cac9af5cafd78a4e48`
- #961 — `fix(ui): finish unavailable historical image previews`
  - branch: `agent/overnight-image-preview-state`
  - head: `182e0723047c4a99fe36a4468f77f219792c2348`
- #968 — `fix(adapters): stop handling Claude subscription credentials`
  - branch: `fix/claude-cli-owned-auth`
  - head: `4b48926c3d8d3d19ce2647f9712ce5dc65c91303`
- #969 — `fix(adapters): use the public OpenAI transcription API`
  - branch: `fix/voice-openai-public-api`
  - head: `90f5ded0582515ca8bbf0dd79563de83aa80af78`
- #970 — `fix(server): resolve voice keys from the OS credential store`
  - branch: `fix/voice-keychain-connection`
  - head: `f221eeeb1d717078a8634f412f04878e2240bfc4`
  - currently stacked on #969, not directly on `main`
- #971 — `Prove packaged PTY and keyring bindings`
  - branch: `test/packaged-native-binding-proof`
  - head: `4e802808ea1f0f2659edb112c1be6ffb54933258`
- #972 — `Resume Grok chats across app restarts`
  - branch: `fix/grok-restart-resume`
  - head: `d5da529da036e3e1157965b03137947e2b39dfeb`

Every SHA above was fetched from GitHub immediately before this handoff update. Fetch again before
working because another contributor may advance `main` or a PR.

### What was implemented in this pass

#### Claude authentication hardening — #968

- Removed reads and writes of `~/.claude/.credentials.json`.
- Removed the private usage endpoint, OAuth refresh endpoint, Claude Code client ID, direct token
  rotation, and spoofed Claude Code user agent.
- `claudeAccount` now trusts only the installed CLI's `claude auth status` result.
- Login and logout remain delegated to the official installed CLI.
- Subscription-limit reporting now returns an honest unavailable state.
- Regression tests reject the removed production markers and prove that account probing performs no
  network request.

This matches the technical local-CLI ownership pattern used by T3 Code, but it does not resolve
Anthropic's legal restriction on third-party products routing Free/Pro/Max subscription OAuth.
Issue #950 must remain open unless Anthropic provides written approval or the subscription-backed
Claude provider is removed from the public build.

#### Voice migration — #969 and #970

- Replaced `https://chatgpt.com/backend-api/transcribe` with the public
  `https://api.openai.com/v1/audio/transcriptions` endpoint.
- Uses `gpt-4o-mini-transcribe` and an explicit OpenAI API key.
- Removed ChatGPT JWT decoding, account extraction, `includeToken: true`, and session-token export.
- The server resolves the key from the first enabled official OpenAI connection in the OS credential
  store. The renderer never receives the key.
- Custom or lookalike OpenAI endpoints are rejected for voice.
- #970 is intentionally stacked on #969. Merge #969 first, retarget #970 to `main`, merge current
  `main` into it if necessary, rerun tests, and only then merge #970.

#### Grok restart resume — #972

- Separates the stable TasteCode thread ID from Grok's opaque native session ID.
- Persists and migrates the provider session ID in SQLite.
- Rotated native IDs are persisted only while the emitting session is still attached.
- Print-mode chats resume with the exact native `-r` identity after a full server/app restart.
- MCP-enabled Grok chats reconstruct the ACP launch and use `session/load`.
- Restarted turns use collision-safe random IDs.
- A chat that ended before Grok supplied a native ID preserves readable history and returns an
  actionable new-chat error instead of inventing continuity.
- Tests cover ID capture, rotation, migration, Store/Orchestrator recreation, missing IDs, and ACP
  resume reconstruction.

#### OSS and production-license audit — #936

- Inventories all 27 direct packaged runtime dependencies, including the Anthropic commercial SDK,
  OpenCode SDK, Electron updater, JetBrains Mono, Pierre, xterm addons, and micromark packages.
- Derives the runtime graph from desktop/web workspace roots instead of trusting only the inventory.
- Audits every resolved production transitive for declared license metadata plus shipped
  LICENSE/COPYING/NOTICE evidence.
- Fails closed on direct inventory drift, unknown metadata, missing package evidence, a stale managed
  Markdown table, or an incomplete top-level project license.
- Exposes `pnpm licenses:verify` and `pnpm licenses:report`.
- The generated dependency table is deliberately Prettier-ignored so formatting cannot make the
  deterministic verifier fail.

The complete official Apache-2.0 root text and the actual third-party license bodies still need a
maintainer review and final artifact proof. Metadata alone does not clear #952.

#### Packaged native-binding proof — #971

- Runs through the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`.
- Resolves `node-pty` and `@napi-rs/keyring` from the packaged `@harness/server` entry, which tests
  pnpm's strict dependency layout rather than accidental desktop-level hoisting.
- Requires both module entries and loaded `.node` binaries to come from `app.asar` or
  `app.asar.unpacked`.
- Spawns, resizes, observes output from, and cleanly exits a real PTY.
- Saves, reads, deletes, and verifies an isolated credential with `finally` cleanup.
- Supports a Windows executable and a macOS `.app` bundle.
- Final review removed lint-invalid assertions and an `unknown` callback parameter.

Issue #956 remains open until this proof runs successfully against real packaged builds on both
operating systems.

#### Release uploader and workflow — #937

- Matrix build jobs have only `contents: read`; checkout credentials are not persisted.
- Exactly one serialized final job receives `contents: write`.
- All Actions use reviewed full commit SHAs and the workflow uses Node 24.
- Dispatch accepts only the exact selected 40-character `main` SHA and rechecks that it is still
  current before any release mutation.
- The uploader rejects published releases before PATCH, DELETE, or upload.
- Duplicate drafts and the concurrent-create race fail before asset mutation.
- Only one private draft can be reconciled to the exact approved target, metadata, names, and sizes.
- The accepted manifest is exactly ten Windows/macOS artifacts, updater files, and checksum files.
- Stale files, wrong versions, wrong architectures, empty assets, inconsistent updater metadata,
  and invalid checksums fail before upload.
- Windows has an explicit `TasteCode.exe` executable name and robust installed-path discovery.
- Current `main`'s desktop `zod` dependency and Design Preview test safety changes were preserved
  during conflict resolution.
- Both package jobs now run `pnpm licenses:verify` and the packaged native-binding proof.

The duplicate private release IDs `371292479` and `371294326` were not deleted. Deletion is a
separate destructive operation. Delete both only after confirming their tag and draft state, then
create one clean private draft through the final single-writer path.

### Validation completed in this pass

- Release helper fixtures: 14/14 passed.
- License audit fixtures: 4/4 passed.
- Claude adapter source and focused regression checks passed syntax review.
- Voice adapter/server source and focused regression checks passed syntax review.
- Grok's eight changed TypeScript source/test files passed Node syntax checks.
- Native proof source, runner, tests, archive-path checks, and injected PTY/keyring behavior passed.
- The release branch preserves `zod`, the intended Design Preview retry hardening, and all exact
  release-tool tests after merging current `main`.
- Independent final review found no remaining code-level blocker in the Grok, native-proof, or
  license-tooling drafts.

Validation not completed in this pass:

- The cloud package cache was incomplete, so a fresh full workspace lint, typecheck, test, and build
  could not be completed against the final combined PR state.
- No real Windows package, ConPTY, credential store, installer, SmartScreen, shortcut, provider, or
  uninstall test ran in the Linux cloud.
- No real macOS package, Keychain, signing, notarization, stapling, Gatekeeper, Finder launch, or
  product smoke ran in the Linux cloud.
- No hosted Actions ran because the account has no available minutes and Leon does not want to pay
  for more.
- No full-history/all-refs secret scan was possible in this cloud checkout.

Do not reuse the older full-green cloud totals later in this file as proof for these newer commits.
They refer to an earlier branch state.

### Required local merge order

Keep one logical PR at a time. Never rebase or force-push these shared branches.

1. Fetch all refs and confirm current `main` and every PR head.
2. Review #959. Merge current `main` into its branch, resolve the current conflict, run keyboard and
   theme checks plus all gates, then merge it normally if clean.
3. Review and merge #960, then #961, with focused tests and full gates after each conflict resolution.
4. Review and merge #968. Do not close #950 or claim legal clearance.
5. Review and merge #969.
6. Retarget #970 from `fix/voice-openai-public-api` to `main`, merge the new current `main` into its
   branch if necessary, rerun its focused and full gates, then merge #970.
7. Review and merge #972. Perform one real Grok print-mode restart and one Grok ACP/MCP restart
   before considering #953 proved.
8. Finish the full root LICENSE, dependency-license review, security address, and artifact legal
   contents on #936. Run all gates, then merge #936.
9. Review #971 and run the packaged native proof on Windows. Blueemi must run it on macOS. Merge it
   only when the source review and available physical proof are acceptable; keep #956 open until both
   operating systems pass.
10. Merge the resulting latest `main` into #937 without rebasing. Preserve both current product work
    and release-only configuration. Rerun every local gate from that exact branch head.
11. Do not merge #937 or publish anything until every remaining launch blocker below has an explicit
    outcome.

### Remaining launch blockers and owner decisions

- #950: written Anthropic approval or remove subscription-backed Claude from the public build.
- #952: complete official Apache-2.0 root license, reviewed production/transitive inventory, and all
  required license/notice bodies inside both artifacts.
- #954: delete both obsolete private drafts and exercise the single-writer flow against one clean
  private draft.
- #956: real packaged PTY and credential-store proof on Windows and macOS.
- #965: harden standalone secret-shaped value redaction before public diagnostics ship.
- Full-history/all-refs secret scan and rotation/removal of any finding.
- Final interactive Windows product and installer smoke by Leon.
- Same-SHA signed, notarized, stapled macOS build and product smoke by Blueemi.
- Final checksums generated only after all signing is complete.
- One explicit Leon go/no-go after the private draft and public landing-page dependencies are ready.

Conditional blocker:

- #955 blocks launch if direct API/Connections is visible. Otherwise keep the feature hidden and
  schedule durable API state, connection identity, model switching, truncation, and context-budget
  work after beta.

Important hardening still open but separate from the work above:

- #962: terminalize every started adapter item before a terminal turn event.
- #964: display refresh failures while retaining stale pull-request data.
- #957, #958, and #963: measured later performance/error-boundary work; do not rush these into the
  launch merge without profiling and review.

### Exact local validation commands

Run from a clean checkout after resolving each branch against the newest `main`:

```text
corepack pnpm@11.8.0 install --frozen-lockfile
corepack pnpm@11.8.0 lint
corepack pnpm@11.8.0 typecheck
corepack pnpm@11.8.0 test
corepack pnpm@11.8.0 build
node --test tools/scripts/release-licenses.test.js
node --test tools/scripts/release-tools.test.js
corepack pnpm@11.8.0 licenses:verify
```

`licenses:verify` must fail until the complete root license exists. Do not bypass or weaken that
failure. After the license is fixed, it must pass from the exact final install on both platforms.

Final Windows package and native proof from the updated #937 branch:

```text
corepack pnpm@11.8.0 --filter @harness/desktop exec node scripts/build-preload.js
corepack pnpm@11.8.0 --filter @harness/desktop exec electron-builder --win nsis --x64 --publish never
corepack pnpm@11.8.0 --filter @harness/desktop verify:native-bindings -- "../../release/win-unpacked/TasteCode.exe"
node tools/scripts/release-checksums.js release SHA256SUMS-windows-x64.txt windows
```

Blueemi's macOS package and native proof from the exact same final commit:

```text
corepack pnpm@11.8.0 --filter @harness/desktop exec node scripts/build-preload.js
corepack pnpm@11.8.0 --filter @harness/desktop exec electron-builder --mac dmg zip --arm64 --publish never
corepack pnpm@11.8.0 --filter @harness/desktop verify:native-bindings -- "../../release/mac-arm64/Taste Code.app"
node tools/scripts/release-checksums.js release SHA256SUMS-macos-arm64.txt macos
```

Signing changes hashes. Blueemi must sign, notarize, staple, and verify before generating the final
macOS checksum.

### Local Codex Desktop resume prompt — current

```text
Read AGENTS.md, rules/working-together.md, rules/git.md, rules/code.md,
rules/security.md, docs/ARCHITECTURE.md, docs/dashboard.html,
docs/feature-inventory.html, HANDOFF.md, and BLUEMI.md completely before acting.

I am continuing the TasteCode public-beta preparation locally on Windows. GitHub is authoritative.
The handoff boundary is main bfc884773a760de216c1c79e4bf34f1a3f73e22f, but fetch first because
main or a PR may have moved. Do not rebase, force-push, push directly to main, run hosted Actions,
publish a release, change repository visibility, or merge the landing page.

Inspect draft PRs #959, #960, #961, #968, #969, #970, #972, #936, #971, and #937. Verify each
current head against HANDOFF.md. Keep each PR focused and preserve unrelated contributor work.

Use this order:
1. Resolve #959 by merging current main into its branch, then review/test/merge #959, #960, #961.
2. Review/test/merge #968, but keep #950 open because CLI-owned auth does not provide Anthropic
   legal approval.
3. Review/test/merge #969. Then retarget #970 to main, merge current main into it if needed,
   review/test/merge #970.
4. Review/test #972 and physically prove both Grok print restart and Grok ACP/MCP restart before
   closing #953.
5. On #936, add/review the complete official Apache-2.0 root license, run the production license
   audit, inspect the final transitive inventory and artifact legal files, then merge only if #952
   is truly cleared.
6. Review #971. Build the Windows package and run its packaged PTY/keyring proof. Keep #956 open
   until Blueemi runs the same proof on macOS.
7. Merge the resulting latest main into #937 without rebasing. Preserve current product changes,
   zod, native proof, legal resources, exact-manifest release tools, and the single-writer workflow.
8. From the exact final #937 head run pnpm install --frozen-lockfile, lint, typecheck, test, build,
   release-license tests, release-tool tests, licenses:verify, Windows NSIS packaging, the packaged
   native proof, and the full interactive Windows smoke from HANDOFF.md.

Do not bypass failing gates. No hosted Actions are available. Do not delete the duplicate private
drafts 371292479 and 371294326 until their tag and draft state are manually confirmed. Do not create
or upload a final draft until all launch PRs are merged and Windows/macOS are built from one exact
final main SHA.

Before public launch, require an explicit outcome for #950, #952, #954, #956, #965, the full-history
secret scan, Windows physical QA, Blueemi's signed/notarized/stapled same-SHA macOS QA, final hashes,
and Leon's go/no-go. Treat #955 as blocking if direct API/Connections is exposed. Keep everything
private and every release a draft until then.

At the end, update the existing HANDOFF.md current-authority section with exact final SHAs, commands,
test totals, failures, artifact names and SHA-256 values, remaining owner decisions, and the next
smallest safe action. Do not create another handoff file.
```

## Overnight audit addendum — read this first

This section supersedes older status statements below when they conflict. It records the deep
review performed after the earlier release handoff. The audit was pinned to product `main`
`fae4da906c26bb9a0d45c003c01a2801fcd4e753`.

### Current verdict

**No-go for public visibility or beta publication yet.** Nothing was merged, published, made
public, or launched during this pass. No hosted GitHub Actions were run.

The product is materially stronger than the previous handoff suggested, but the review found
public-release blockers in provider authentication, durable session resume, licensing, and the
release uploader. These are product and compliance gates, not visual-polish preferences.

### Branch and pull-request state at the audit boundary

- Product `main`: `fae4da906c26bb9a0d45c003c01a2801fcd4e753`.
- Draft PR #936, `docs/oss-launch-readiness`: code head
  `526ab64910575d7c7ca48c7faae607cd5a116d50` before this addendum.
- Draft PR #937, `agent/release-artifact-proof`: code head
  `d286fdfe7ad2ee1af693071e83d9030c3fab8e6d` before this addendum.
- Both launch branches were 43 commits behind `main` at the audit boundary. Their merge base was
  `094b68781e8b2a426d1640624f5759f9a76f5909`.
- Do not build a launch artifact from either stale branch. Merge current `main` into the working
  branch without rebasing, then repeat every gate against the resulting exact commit.

Three focused, unmerged draft pull requests were opened from the audited `main`:

- #959 — `fix(ui): restore keyboard focus and dialog containment`
  - branch: `agent/overnight-a11y-hardening`
  - head: `c0ca415f210614bb52b2d411aba4b522d98fb540`
  - restores visible focus, fixes placeholder contrast, names composer/thread-search controls, and
    gives the command palette focus trapping and restoration
- #960 — `fix(runtime): drain child output before settling`
  - branch: `agent/overnight-stdio-drain`
  - head: `0990c497df4c6401272566cac9af5cafd78a4e48`
  - waits for child `close`, not `exit`, in output-capturing runtime paths and adds regression
    fixtures for bytes delivered after process exit
- #961 — `fix(ui): finish unavailable historical image previews`
  - branch: `agent/overnight-image-preview-state`
  - head: `182e0723047c4a99fe36a4468f77f219792c2348`
  - prevents missing or rejected historical image previews from showing an endless loading state

All three intentionally remain drafts and have unchecked local validation boxes. Review and run
them locally before merging. Keep each PR isolated; do not fold unrelated polish into them.

### Launch-blocking issues created by the audit

- #950 — remove unsupported Claude subscription OAuth and credential rotation.
  - The shipped limits/auth path reads and writes Claude Code subscription credentials, uses an
    undocumented usage endpoint, and refreshes with Claude Code's client identity.
  - Before a public third-party product ships, remove/disable this path and use supported API-key
    or cloud authentication, omit Claude from this beta, or obtain written Anthropic approval.
- #951 — move Codex voice off the private ChatGPT transcription endpoint.
  - The current path exports a ChatGPT session token and calls an undocumented ChatGPT backend.
  - Hide voice for the beta or migrate it to the public transcription API with an explicit API
    key stored through the normal credential system.
- #952 — complete the Apache license and packaged dependency notices.
  - The root `LICENSE` is a short SPDX/link notice rather than the complete standard text.
  - `THIRD_PARTY_NOTICES.md` and `licenses/` do not yet cover the complete packaged production
    dependency tree. Generate and review the final transitive inventory on both artifacts.
- #953 — persist and restore Grok's provider-native session ID across restarts.
  - The database stores a synthetic TasteCode ID while the real CLI ID remains in memory, and the
    runtime has no resume implementation. A Grok chat cannot continue after restart.
- #954 — make draft-release creation single-writer and enforce an exact manifest.
  - GitHub permits duplicate draft releases, so concurrent matrix upload jobs can each create one.
  - The existing duplicate private drafts `371292479` and `371294326` prove the race.
  - The uploader also needs published-release immutability before any PATCH and strict rejection
    of stale/wrong-version artifacts.
- #955 — persist direct-API state and connection identity for restart resume.
  - Treat this as a blocker if Connections/direct API is visible in the public build; otherwise
    keep the feature hidden and schedule the issue after beta.
- #956 — prove packaged `node-pty` and keyring bindings on both physical platforms.
  - Do not blindly flip `npmRebuild`. Require the exact packaged modules in Electron Node mode,
    spawn/resize/exit a PTY, and save/read/delete a test credential on Windows and macOS.

Additional beta-hardening issues:

- #962 — close every started adapter item before a terminal turn event.
- #964 — surface pull-request refresh failures while preserving stale data.
- #965 — redact standalone secret-shaped values from local diagnostics.
- #966 — isolate release write permission and pin GitHub Actions.

Measured later work, not a reason for an unsafe overnight rewrite:

- #957 — paginate/materialize cold thread history instead of parsing the full raw event log.
- #958 — move Shiki tokenization off the renderer and cache by content hash.
- #963 — add a renderer error boundary with diagnostics and reload recovery.

Keep these reviewed findings in the next planning pass even though they were not split into more
issues tonight:

- direct API ignores a per-turn model change and presents provider output-length truncation as a
  normal completion;
- direct API resends unbounded history/tool output and needs a context-budget policy;
- Grok's exported tested-version value is not wired into provider detection;
- collapsed activity rows still mount heavy hidden detail DOM;
- custom-harness verification is weaker than a real protocol handshake, and relative discovery
  working directories can differ from actual turn launch directories;
- the Windows proof assumes `Programs\\TasteCode\\TasteCode.exe`, while the configured product name
  can produce a spaced executable/install path; set an explicit executable name or discover the
  installed binary robustly before trusting that smoke;
- before beta 2, restrict auto-update to official signed builds and retest the on-quit update path;
- later macOS hardening should minimize inherited library-validation/microphone entitlements, and
  the parked Kimi probe should stop inferring auth from credential-file existence.

### What the deep review found to be sound

- Electron renderer and preview boundaries are materially hardened: context isolation and
  sandboxing are enabled, Node is disabled in renderer content, navigation/window/permission
  boundaries are restricted, and loopback attachment URLs are scoped.
- The thread rAF delta batching, structural flushes, live markdown tail, row virtualization, stable
  completed rows, history wire compaction, OpenCode single-flight handling, and cancellation paths
  are coherent. Do not rewrite this core without benchmarks.

### Validation truth for this pass

The audited text source was reconstructed from GitHub and checked against the pinned blob hashes.
The following focused evidence was obtained:

- A standalone child-process fixture proved that `exit` observed only `early-`, while `close`
  observed `early-late`; this supports PR #960's change and regression tests.
- The new placeholder tokens calculate to 4.529:1 in dark mode and 4.833:1 in light mode.

The current cloud environment could not complete a frozen install: its package cache lacked
`@oxlint/plugins`, and registry access was unavailable. Therefore **current-main lint, typecheck,
test, build, and package gates were not completed in this pass**. Do not confuse this with the
earlier green validation listed below, which was performed against the older launch-branch state.

### Required next sequence

1. Review draft PRs #959, #960, and #961 locally. Run their focused tests, then the full frozen
   install, lint, typecheck, test, and build gates. Merge only after review.
2. Merge the resulting current `main` into PR #936 and PR #937 without rebasing. Merge PR #936
   before PR #937 when they are approved, and rerun every gate after the merge commits.
3. Resolve #950 and #951 before public distribution. The safe time-boxed default is to hide the
   unsupported Claude subscription and Codex voice paths until supported authentication exists.
4. Resolve #953 before advertising Grok as a durable provider. Hide Grok if restart resume cannot
   be completed and proved in time.
5. Resolve or hide direct API per #955 if Connections is exposed.
6. Resolve #952 and #965, scan the full Git history and all refs for secrets, and inspect the
   unpacked Windows and macOS artifacts for every required license/notice file.
7. Fix #954 and #966. Delete both duplicate drafts. Use one trusted upload writer for one exact
   approved merged-main SHA and reconcile the exact final asset manifest.
8. Run the packaged Windows proof, including NSIS interactive/silent install, custom directory,
   PTY, keyring, provider response, terminal, attachment, approvals, checkpoint, Design Mode,
   relaunch persistence, and uninstall.
9. Blueemi must build the same SHA on macOS, sign/notarize/staple, verify the DMG/ZIP and signatures,
   and perform the equivalent Finder/UI product smoke. Generate checksums only after signing.
10. Keep the repositories private and the release a draft until Leon gives a new explicit go.

### Codex Desktop resume prompt

Paste the following into a fresh local Codex Desktop chat from a clean TasteCode checkout:

```text
Read AGENTS.md, rules/working-together.md, rules/git.md, rules/code.md,
rules/security.md, docs/ARCHITECTURE.md, HANDOFF.md, and BLUEMI.md completely.

GitHub is authoritative. Do not rebase, force-push, push main, publish a release, make a
repository public, or run hosted Actions. The audited main boundary is
fae4da906c26bb9a0d45c003c01a2801fcd4e753. Fetch current GitHub state first in case main moved.

1. Review draft PRs #959, #960, and #961 independently. Inspect every diff. On a clean checkout
   run the focused tests, then pnpm install --frozen-lockfile, pnpm lint, pnpm typecheck,
   pnpm test, and pnpm build. Exercise #959 with keyboard-only navigation in both themes and
   verify #961's loading, missing, rejected, and successful preview states.
2. If those PRs pass review, merge them normally. Then merge current main into
   docs/oss-launch-readiness and agent/release-artifact-proof without rebasing. Resolve conflicts
   by preserving both current main and the release-only legal/package changes. Repeat all gates.
3. Treat #950, #951, #952, #953, #954, #956, #965, and #966 as public-launch blockers. Treat #955
   as a blocker if direct API/Connections is exposed. Prefer hiding unsupported provider/voice
   features for beta over shipping private authentication endpoints. Do not silently claim durable
   Grok sessions while restart resume is broken.
4. Implement/review #962 and #964 if time permits, with focused lifecycle/refresh tests. Do not
   rush the measured later work in #957, #958, or #963.
5. Run a full-history/all-refs secret scan. Generate the complete packaged production license
   inventory and inspect the unpacked Windows/macOS resources.
6. Fix #954 before using the uploader. Delete private draft release IDs 371292479 and 371294326.
   Use one single writer and one exact approved merged-main SHA.
7. On Windows, build/package locally and prove node-pty and keyring inside the packaged Electron
   runtime, then complete the NSIS and real-product smoke in HANDOFF.md. Blueemi must build the
   exact same SHA on macOS, sign/notarize/staple it, verify containers/signatures, and complete the
   macOS smoke. Generate hashes after signing.
8. Update HANDOFF.md with exact SHAs, commands, test totals, artifact names/hashes, failures, and
   remaining owner decisions. Stop with everything private and the release still a draft. Ask Leon
   for the final go/no-go only after every blocker is either fixed and proved or explicitly removed
   from the public build.
```

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
