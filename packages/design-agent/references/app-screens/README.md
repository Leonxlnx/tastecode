# tasteskill app-screen library

Design mode builds dashboards and other app screens (admin, analytics, settings, inboxes,
wallets, builders) from the app-screen part of tasteskill v2.1, the anti-slop frontend skill.
The files here are unmodified copies from
[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) at tag `v2.1.5`
(commit `12af471f627f866411b4bd785b19646d3672784c`). `provenance.json` records each file's
upstream path and SHA-256; a test fails when a file no longer matches it.

| File             | Upstream path                                  | Used for                                                                                   |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `app.json`       | `skills/taste-skill/library/app.json`          | The deal: seven styles, five shells, screen patterns, signature elements and product kinds |
| `app-screens.md` | `skills/taste-skill/references/app-screens.md` | The rules each phase quotes: the run, shell, canvas, KPIs, charts, tables, states, phone   |
| `app.css`        | `skills/taste-skill/assets/app.css`            | Neutral shell, panel, table and control styles Build copies into the project               |
| `charts.js`      | `skills/taste-skill/assets/charts.js`          | Dependency-free SVG charts Build copies into the project                                   |
| `LICENSE`        | `LICENSE`                                      | The MIT license that accompanies every copy                                                |

The library holds no images. Its styles were distilled from a study of 23 product screens that
stay private, so dashboards need no reference images and no image-capable provider.

TasteCode does not run tasteskill's scripts. `src/app-screens.ts` ports the deal of
`scripts/lib/app-draw.mjs` (style, shell and one pattern per screen, without the per-user
history file) and renders the app sheet for the phase prompts. Before a dashboard run's Brand
phase the server writes `app.css`, `charts.js`, `app-screens.md` and `LICENSE` to
`.taste/app-kit/` in the workspace, `app.css` and `charts.js` with a one-line license header,
so every provider can read and copy them with its ordinary file tools. The Review phase and the
preview DOM audit take the place of tasteskill's `lint.mjs` and `inspect.mjs`.

To update, copy the five files from a newer tasteskill release, update `provenance.json` and
run `pnpm --filter @harness/design-agent test`.
