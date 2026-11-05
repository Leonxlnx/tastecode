# tasteskill website rules

Design mode builds websites under the rules of tasteskill v2.5, the anti-slop frontend skill. The
files here are unmodified copies from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)
at tag `v2.5.0` (commit `822e0b9d872e10deb931afad2c6c2bd943cf4c7b`). `provenance.json` records each
file's upstream path and SHA-256; a test fails when a file no longer matches it.

| File           | Upstream path                                | Quoted for                                                             |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `SKILL.md`     | `skills/taste-skill/SKILL.md`                | The nine house rules, the kinds of business, the checklist and "Never" |
| `copy.md`      | `skills/taste-skill/references/copy.md`      | Plain copy, what may be assumed, contacts, banned words                |
| `layout-v4.md` | `skills/taste-skill/references/layout-v4.md` | One section per screen, equal edges and the grid                       |
| `motion.md`    | `skills/taste-skill/references/motion.md`    | The hover layer, loops and the tech budget, at their numbers           |
| `photos.md`    | `skills/taste-skill/references/photos.md`    | Placing pictures and what never stands in for one                      |
| `LICENSE`      | `LICENSE`                                    | The MIT license that accompanies every copy                            |

`src/tasteskill-web.ts` quotes whole `##` sections of these files into the Page, Build and Review
prompts of a website run (`WEBSITE_RULE_SECTIONS` lists which). It puts TasteCode's adaptations in
front of them:

- TasteCode does not install or run the skill's kit.
- The reference deck decides composition, and the brand system decides type, colour, radius and spacing.
- There is no picture library: pictures come from the brief, the user's files and the Asset phase.
- Motion follows `src/website-motion.ts`.

The skill's own photo library and sample pictures are not copied anywhere.

To update, copy the six files from a newer tasteskill release, update `provenance.json` and run
`pnpm --filter @harness/design-agent test`. A test fails when a quoted heading no longer exists.
