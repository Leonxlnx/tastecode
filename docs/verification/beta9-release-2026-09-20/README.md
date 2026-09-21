# Beta 9 publication verification

Published on 2026-09-20 from `b65a844f7ed6e1d6816d482a48508076fd7383fa`.
[Release and downloads](https://github.com/Leonxlnx/tastecode/releases/tag/v0.1.0-beta.9).

## Windows installed upgrade

[Passing isolated Windows run](https://github.com/Leonxlnx/tastecode/actions/runs/35506366836)
used the actual GitHub beta 7 and beta 9 installers, checking their size and SHA-256.
It installed beta 7, seeded a chat and settings, used the real Settings update button,
downloaded and verified beta 9, clicked Restart to update, and checked the real NSIS
installation and automatic relaunch. Beta 9 displayed both prior messages and retained
the chat pin, approval mode, sidebar settings, theme, font and onboarding state.
The disposable installation was uninstalled successfully.

Before publication, only GitHub release metadata and download transport were redirected
to the verified candidate on loopback. The real installer ran silently to automate its
wizard. No updater state, download verification, installation or database migration was
mocked. Earlier harness attempts failed on runner setup, draft access, fixture URL
construction and an early renderer reload; the final run passed all checks. The user's
running desktop was not stopped or modified. The empty runner had no provider account;
this test does not establish authenticated model requests or website quality.

## macOS and source regression coverage

The [macOS maintainer report](https://github.com/Leonxlnx/tastecode/pull/1262#issuecomment-5748786669)
records signing, notarization, stapling, Gatekeeper, native bindings, three fresh-profile
launches and an installed beta 7 to beta 9 upgrade preserving its chat and settings.
Both platform assets and the published tag match the same approved source commit.

The publication review reran 451 automated tests: 147 Design Agent, 49 preview, 212 desktop,
and 43 update/Design UI tests. All passed. Earlier full source and packaging gates are
recorded on PRs 1262 and 1263. Live generation with every provider was not repeated.

The documentation follow-up passed `pnpm lint`, `pnpm typecheck` and `pnpm build`.
The additional `pnpm test` run hit lazy-UI wait limits, and a parallel server run hit
5-second Git/filesystem limits plus cleanup locks. These are recorded failures, not a
single clean full-suite invocation. Bounded reruns passed all affected cases without
source changes: all 31 Markdown tests, the two affected App cases, and all 277 cases in
the five affected server files. The latter used one worker and 30-second test/hook
limits on Windows. The other 185 web files and 54 server files passed their broad runs.

## Public update compatibility

After publication, anonymous GitHub discovery selected beta 9 for both platforms.
Both public downloads returned HTTP 200 and matched their expected size and SHA-256.
The production Windows updater independently downloaded the public installer and reached
`ready` with a simulated beta 7 version; installation was disabled in that separate local
download check. The real installed upgrade is covered by the isolated Windows run above.

Beta 7 discovers the new release through its existing Settings updater. The new sidebar
button appears after installing beta 9. Beta 6 and earlier installations which missed
the beta 7 bridge need a manual installer. Windows remains unsigned and may show a
SmartScreen/unknown-publisher prompt. macOS supports Apple Silicon.

Checksums:

- Windows: `b522617b6b5ef8e50968bc03b608dc74b6d198bf1df439cd68131c9eb89afd9e`
- macOS: `7fd3ea84839dfc2b6a9b2d8349d53cab71f5c38133b5ff5cc0e13da92d27fcc9`
