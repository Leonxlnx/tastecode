# Local verification: 2026-09-15

The ten code changes below are merged to main. Each final PR head passed all four required checks after taking in fresh main. The merged source matches all 67 starting paths plus the new diff-renderer test, including the reviewed overlay fix, byte for byte. Baseline screenshots use original main `759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9`.

Source main at this report: `89eeb70ce8a64f8ae74495b1e82f515ae4cdc35d`.

## Required checks

Every listed head passed `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` on macOS arm64 with Node 22.22.3 and pnpm 11.8.0. No hosted CI was started.

| PR                                                       | Scope                                                              | Checked head                               | Merge commit                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| [#1133](https://github.com/Leonxlnx/tastecode/pull/1133) | feat(contracts): define authenticated pull request images          | `c475e104038c4bd2a693d3c0602ecb43315a4bf4` | `6f8959370a9de16f650c54f6d139e9eb37b9a28b` |
| [#1134](https://github.com/Leonxlnx/tastecode/pull/1134) | feat(server): fetch bounded pull request images through GitHub CLI | `6ec3e5bfdc0411e6391c7d77218bc10e8e6eb6e1` | `d8b90c1d15fbc1f5d81bf7921a90bc444e24b2e0` |
| [#1135](https://github.com/Leonxlnx/tastecode/pull/1135) | feat(web): render private pull request images                      | `b78f0b98d9b1dd0803b41067be83f6e0ad9a0735` | `c959fa9338a0b4e2dabaa7b92c46fafe6963e3b3` |
| [#1136](https://github.com/Leonxlnx/tastecode/pull/1136) | design(web): show content-shaped loading placeholders              | `f4bdc463aa71f930e4399135915082f643f5b7a7` | `508af339db118f0492b1acc5c9ebaceb890dcb99` |
| [#1137](https://github.com/Leonxlnx/tastecode/pull/1137) | design(web): show pull request loading layouts                     | `14ff0ea47ef824fac49f114e81ac8f19f7fa4fb3` | `9a69baf51ca6ff18f1e6e3043434e8bf6f449851` |
| [#1144](https://github.com/Leonxlnx/tastecode/pull/1144) | fix(web): keep pull request content visible after refresh errors   | `ad6bff4141c56c6ae83f4a7fd4e8c48c70dde3da` | `ba892a87f49c279f717397a3875786608a1f4f41` |
| [#1145](https://github.com/Leonxlnx/tastecode/pull/1145) | design(web): refine pull request layout and labels                 | `728b8a5f49fbcc7bc8693713d606e4a38670c3e4` | `79df21a6c1a944a24d54a725b8647f4321541a89` |
| [#1140](https://github.com/Leonxlnx/tastecode/pull/1140) | fix(desktop): migrate removed Codex theme to system                | `7d5ebedbfa8934c9cf48f64209b7235385b675c5` | `ddc923b7f0f2d61bec0d2b4f7bf59ea340f41f60` |
| [#1146](https://github.com/Leonxlnx/tastecode/pull/1146) | fix(desktop): omit unused vendor binaries from packages            | `f0bfd910ec315502d06a3fe4364f4525628114de` | `45bf6740a69418fe5180e2764943d2b124c40f28` |
| [#1142](https://github.com/Leonxlnx/tastecode/pull/1142) | fix(dev): use the Bun script shell on macOS                        | `5b582e3c9ea7c8d451f21901101d8abd7cbd8df3` | `89eeb70ce8a64f8ae74495b1e82f515ae4cdc35d` |

The Bun-shell full suite initially hit the existing SessionSearchHost focus-test timeout. Its focused eight tests and a second full suite passed without a source change.

## Replaced PRs

- [#1138](https://github.com/Leonxlnx/tastecode/pull/1138) was replaced by [#1144](https://github.com/Leonxlnx/tastecode/pull/1144) with the exact resolved tree. GitHub could not rebase the original history. The replacement passed all four checks before merge.
- [#1139](https://github.com/Leonxlnx/tastecode/pull/1139) was replaced by [#1145](https://github.com/Leonxlnx/tastecode/pull/1145) with the exact resolved tree. GitHub could not rebase the original history. The replacement passed all four checks before merge.
- [#1141](https://github.com/Leonxlnx/tastecode/pull/1141) was replaced by [#1146](https://github.com/Leonxlnx/tastecode/pull/1146) with the exact resolved tree. GitHub could not rebase the original history. The replacement passed all four checks before merge.

## Live checks

Native screenshots below show the current combined source tree, including the diff-error fix in #1137. Baseline screenshots use the original main renderer in the in-app browser. They are flow and visual evidence; the separate branch checks above establish each code head.

- The native app loaded the real PR list and detail view. The read-only WebSocket list request returned 396 items.
- The authenticated image request for a PNG committed to this private repository returned `image/png`, 16,706 bytes in 565 ms. The same image then appeared in the native PR body.
- The native Files tab rendered both an HTML diff and a CSS diff. The workspace Files tab opened README source.
- Appearance showed System, Light and Dark. Migration tests cover the removed Codex preference.
- The diff-error regression test failed on the old source and passed after the loading overlay recognized the renderer's error element. Both normal-content and error cases pass.
- `bun run lint` passed with the committed Bun shell configuration.

## Performance

`node apps/desktop/scripts/verify-performance.js 3 <output>` passed against the combined source tree. All three renderer samples visited 500 messages. First paint was 34.7 / 25.2 / 25.0 ms; worst scroll frame was 15.7 / 9.4 / 9.3 ms; longest stream batch was 1.6 / 1.1 / 1.3 ms. Cold interactive time was 546 / 558 / 530 ms. The verifier reported no failures and closed its test processes. These are local samples, not cross-platform release claims.

## Mac package

On the original #1141 head `b15e10aa2981bfbf82031ad1b7c0e6423a8b22d8`, a fresh isolated `pnpm install --offline --frozen-lockfile --ignore-scripts` completed. License verification checked 397 packages; the full build and preload build passed. An unsigned local arm64 directory package was produced with `electron-builder --mac --arm64 --dir --publish never`.

The finished archive is 20,213,608 bytes with 1,922 entries. Inspection found no platform-specific Claude SDK CLI packages, Windows/Linux node-pty prebuilds, Zod source, or dependency source maps and declaration maps targeted by the new filters. The core Claude SDK, server, Mac arm64 PTY, and license bundle remain present. `node apps/desktop/scripts/run-native-binding-proof.js <packaged-app>` passed both PTY and keyring proofs. Windows packaging, signing, and notarization were not run.

The full merged code was packaged again at checked commit `5b582e3c9ea7c8d451f21901101d8abd7cbd8df3`. The final archive is 20,201,527 bytes with 1,922 entries. The same exclusion checks and packaged PTY/keyring proofs passed again.

## Images

### PR layout

Baseline renderer on original main:

![PR layout before](pr-layout-before.png)

Current native app:

![PR layout after](pr-layout-native.png)

### Loading and loaded content

Baseline PR view while the lazy page loads:

![Baseline PR loading](pr-loading-before.png)

Current exported loading components in a fixed browser fixture. This image deliberately holds loading states; it does not depict a pending live request:

![Loading components fixture](loading-components.png)

Native PR list after loading:

![Loaded PR list](pr-loaded-native.png)

Native CSS diff after loading:

![Rendered native diff](pr-diff-native.png)

Native workspace file after loading:

![Workspace README](workspace-native.png)

### Authenticated image

A private-repository image in the native PR body:

![Private PR image](pr-images-native.png)

### Theme choices

Baseline renderer on original main:

![Four theme choices before](theme-before.png)

Current native app:

![Three theme choices after](theme-native.png)
