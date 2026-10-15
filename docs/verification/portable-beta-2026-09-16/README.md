# Portable Design library and recovery — 2026-09-16

Validation combines the portable library and permission fixes with the persisted-row recovery
work from PR #1178 and main `d32be00e`. The final integration is checked in a separate source copy:
updating the checkout serving the user's Vite renderer would reload their current app. No user
database, running process, website prompt, or Computer Use session is involved in these checks.

Shipped on main `067ad29c`: [library #1186](https://github.com/Leonxlnx/tastecode/pull/1186),
[permissions #1197](https://github.com/Leonxlnx/tastecode/pull/1197), and
[recovery #1198](https://github.com/Leonxlnx/tastecode/pull/1198). The latter incorporates and credits
the original #1178 contribution. Replacement publication PRs preserve the verified content without
rewriting the earlier stacked branches, whose merge ancestry GitHub could not rebase.

## Behavior

- The runtime library contains 118 composition groups, 15 heroes, 102 mobile pairs and 220
  original raster files (290,531,221 bytes). Ordinary Git checkout includes every eligible file.
  Revisions, rejected sections and incomplete fragments are excluded from the sampling pool.
- Environment and user-config overrides retain precedence; without either, the package-relative
  library works automatically. Source URLs, candidate/reviewed status, pairing notes and SHA-256
  hashes are preserved. No machine-specific paths or URL query credentials occur in the catalog.
- Electron packages unpack the new library beside `app.asar`. This preserves the same inode,
  file-size and symlink checks used for external references. The existing release verifier now
  checks all 354 reference assets/metadata files across the legacy and new collections.
- Microphone requests require an explicit single audio type, the owning renderer and its main
  frame. Missing, malformed, camera, mixed and unknown requests are denied. The synchronous
  permission check also denies unspecified media types. The macOS OS permission prompt remains.
- Recovery skips unreadable stored rows without deleting the raw transcript. Rollback clears
  affected caches; closed threads cannot be reactivated by late events. Follow-up regressions
  exposed malformed JSON reaching SQLite before the parser and unknown-provider recovery calling
  `touchThread`. Both paths are guarded. The new saved-provider-chat `localHistory` reader uses
  the same tolerant parser; rebuilds retain the inactive-import filters added on main.

## Evidence

- The original combined change passed `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
  Tests included 131 Design, 1,494 web, 735 server and 172 desktop tests. Two unconstrained full
  runs encountered different one-second UI lazy-import timeouts in unchanged tests. The isolated
  Markdown suite passed; the full suite then passed with `VITEST_MAX_WORKERS=4` without weakening
  assertions or changing production UI code.
- Latest-main integration: `pnpm typecheck`, `VITEST_MAX_WORKERS=4 pnpm test` and `pnpm build`
  passed in the separate source copy. This includes 131 Design, 1,509 web, 772 server and 172
  desktop tests, including the newly imported-provider-history coverage. The final `pnpm lint`
  also passed. Before merging, all 2,145 non-dashboard tracked files matched the validated source
  copy byte for byte; only the separately updated documentation was excluded from that comparison.
- Existing release-tools tests passed: 41 passed, one existing platform-specific skip. The real
  ASAR regression detects missing catalogs, changed image bytes and unexpected files, including
  unpacked library files.
- An isolated hidden Electron 43.4.0 ASAR smoke loaded all 118 references without user
  configuration, parsed every one of the 220 images and matched every catalog hash, then selected
  a 13-reference deck. The initial smoke caught virtual ASAR inode differences; unpacking resolved
  the failure without relaxing file validation.
- The same isolated Electron smoke used a fake media device: audio allowed, camera denied,
  mixed audio/video denied, same-origin iframe microphone denied. No physical microphone or
  camera was accessed. This proves the Windows Electron boundary, not macOS OS consent behavior.

## Remaining release checks

Manual website quality and animation acceptance remain with the user. macOS package/permission
checks, installer/update qualification, full-history privacy review and reference-asset public
redistribution review remain release work. Generated layout references are not production assets
or a grant of rights to depicted third-party names, logos, photographs or artwork. No hosted CI,
release upload, public-repository change or app restart was performed.
