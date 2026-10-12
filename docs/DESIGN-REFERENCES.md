# Design Agent v0.5 reference workflow

New Design runs extract the requested sections and existing brand constraints before selecting
references.

**One page keeps one design language (owner decision, 2026-10-12).** Randomness stays, but a
generated website must not switch design language between sections: one type system (at most two
families), one palette, one radius and spacing scale, and one button, card and label language.
References from one source site share a design language, so sampling now starts from one anchor
site. This replaces the earlier policy from
[PR #1176](https://github.com/Leonxlnx/tastecode/pull/1176), which sampled every family
independently and uniformly regardless of source site and put about eleven sites on one page.

The server draws the first requested family that has a pool, normally the hero, uniformly by
composition group across the entire eligible library. That anchor's source site (its host without
`www.`) defines the page's design language. Every later section comes from the first non-empty tier,
group-first and uniform inside the tier:

1. the requested family on the anchor site;
2. the requested family on close profiled sites: sites scoring at least 10 of 14 against the
   anchor (see below), the best three by score with ties included;
3. only for a sparse family, one with fewer than ten composition groups in the whole library: a
   compatible family (see below) on the anchor site, then on close profiled sites;
4. the uniform pool the family has always used: the family alone when it has at least ten groups,
   otherwise the family together with its compatible families.

The requested family always wins over compatible geometry. A FAQ, CTA, process or contact slot of
a family with enough compositions is never filled with another section type; only sparse families
such as stats and pricing borrow, and only when neither the anchor site nor a close site has that
family. An earlier order tried the anchor site's compatible family before a close site's exact
family, which on the 1,129-pair library put another section type into about a third of FAQ slots
and half of process slots, and gave a fifth of pages two contact sections and no CTA band.
Alternate revisions do not get extra votes. It selects up to three feature compositions and two
about compositions without replacement, and one of each other family; the deck size is unchanged.
Explicit reference IDs or source URLs take priority over every tier. The page planner uses only
sections needed by the brief. Free-form section names never filter out needed compositions. Missing
families use available compositions with the requested content adapted inside them; section topics
do not have to match layout family names.

Similarity comes from `style-profiles.json` beside `catalog.json`, one profile per source host. The
deterministic score adds: heading type 3 when equal or 2 within the serif group (serif,
high-contrast serif) or the sans group (grotesk, geometric, humanist, condensed), other types only
when equal; body type 2 or 1 by the same rule; theme 2 when equal or 1 when either is mixed; radius
2 when equal or 1 when adjacent on sharp, small, medium, large, pill; density 1; imagery 1; and one
point per shared mood word, at most 3, so 14 at most. A close site scores at least 10, for example
the same heading and body type, theme and radius plus one more trait. Half the maximum is about the
median pair among the 53 profiled sites: it would call every second site close and put the
library's single stats reference on a third of all pages. With 10, about the closest 8% of site
pairs qualify; anchors without a close site fill missing families from the uniform pool. Entries a
profile lists as `outliers` do not share their site's language: they never anchor a page and never
fill tiers 1-3, but remain in the uniform fallback. An anchor site without a profile skips the
close-site tiers. A missing or malformed profile file means no profiles; same-site sampling still
applies and selection never fails because of it. A library configured below can ship its own
`style-profiles.json`.

Each saved deck entry records `site` and `role` (`anchor`, `same-site`, `similar-site` or
`fallback`). Only the anchor carries `style`, a one-line summary of its site's design language and
likely typefaces. Decks saved before this change, without these fields, still parse and resume.

Dashboards keep exactly one complete app screen. Instead of a uniform draw, the server scores each
eligible screen by the domain words it shares with the request, subject, required content and
explicit answers. Grammar, surface names (app, dashboard, screen) and interface parts every
dashboard has (table, chart, filter, sidebar) are ignored. A word matching the screen's domain,
tags or product name counts 2 and a word found only in its cue or motifs counts 1. The pick is
uniform by group among the top-scoring screens, uniform over all screens when nothing matches, and
an explicit ID or source still wins.

The bundled selection pools each contain at least ten distinct composition groups and image files.
Sparse topics use compatible geometry: metrics use proof/about compositions, pricing and process
can use feature compositions, and contact can use CTA compositions. The actual image family is
retained; adapting content never authorizes inventing a new layout. Small user-configured libraries
are not padded with duplicate revisions. The loader recognizes sourceUrl, source and url metadata,
plus complete desktop captures, so differently labeled collections remain reachable.

The selected catalog records and file hashes are persisted with the Design run. Brand, page,
asset, build and visual review turns receive the actual selected desktop and paired mobile
images. Brand sees only the anchor and at most two other compositions from the anchor's site, both
attached and listed, so it reads one language instead of averaging the deck. Page sees the whole
deck, and later phases see the compositions the page selected. Every phase's reference footer
says the anchor defines the type, palette, radii, spacing, controls and surfaces, and the other
references contribute composition only. Decks saved without an anchor keep the full Brand input
and the earlier footer. Resuming a run retains the selection and rejects changed reference files. Existing
pre-v0.5 runs retain their original bundled reference behavior. User-attached references take
precedence and do not require a configured catalog.

The implementation preserves reference composition while adapting the project's brand, copy,
palette and imagery. It builds real responsive HTML/CSS, acquires suitable image assets where
needed, and uses the existing source checks, desktop/mobile preview capture, visual review and
bounded repair loop. Reference images are guidance, not page backgrounds or production assets.
Native HTML/CSS does not require a downloaded component. Shared brand fonts are validated against
the page's sections. Required attribution JSON uses asset kind and role `data`, with the same
path and provenance checks as other assets and a one-megabyte valid-JSON limit. Internal phase
prompts do not appear as additional user messages in the chat.

New websites include a visible hero entrance, distinct scroll reveals in at least two later
sections when present, and interaction feedback unless the user explicitly requests no animation.
The same requirements reach Brand, Page, Build, Review and Repair. Build must wire and exercise
the triggers and reduced-motion states; unused keyframes and button color changes are insufficient.
Motion preserves the selected compositions. Still screenshots alone cannot prove motion works.

New runs also persist a random font permutation: ten verified families in each of four
categories. Match the reference's typography category and use its first drawn family, unless
the user or an existing identity supplies the font. Font files must be acquired and actually
loaded; CSS fallback declarations do not satisfy that requirement. Reference geometry,
labels, case, borders and line breaks take priority over generic style preferences.

Build receives the tested native `references/motion/reveal.js` implementation for simple
entrances. It initializes only offscreen elements, observes before entry and plays once.
Already visible or restored-scroll content stays visible. Reduced-motion changes and cleanup
cancel only owned animations and restore the final state. Browser QA includes rapid down/up
scrolling and restored scroll, not only still screenshots. See the
[September 16 verification](./verification/design-variety-2026-09-16/README.md).

## Bundled library and local overrides

Fresh checkouts and desktop packages use `packages/design-agent/references/library` automatically:
172 composition groups, 24 heroes, and 316 raster files including 144 mobile pairs. The files are
ordinary Git assets, so another developer can pull and run without a separate library installation.
The images are lossy WebP (cwebp quality 90, sharp YUV) at the original pixel dimensions; the PNG
captures took 413 MB, the WebP selection takes 35 MB, and the difference is not visible at layout
scale. Originals stay in the external collection. The bundled catalog retains source URLs, review
status, pairing evidence and the SHA-256 hashes of the bundled files.
Desktop packages unpack this library beside `app.asar`, allowing the same real-file identity and
size checks used for custom libraries. The release verifier checks every catalog and raster byte.

To override the bundled library, set `TASTECODE_REFERENCE_LIBRARY` to an absolute library directory
before starting TasteCode, or set `libraryPath` in `~/.tastecode/design-references.json`. No
machine-specific image directory is compiled into the application. The directory must contain
`catalog.json`:

```json
{
  "version": 1,
  "references": [
    {
      "id": "studio-hero",
      "family": "hero",
      "group": "studio-hero",
      "imagePath": "studio/generated/hero-desktop.png",
      "mobileImagePath": "studio/generated/hero-mobile.png",
      "source": "https://example.com/studio",
      "tags": ["light", "editorial", "studio"],
      "cue": "Large editorial headline beside a portrait.",
      "reviewStatus": "reviewed",
      "reviewNotes": "Both generated compositions were visually inspected.",
      "pairEvidence": "Same content, actions and image role; columns stack on mobile."
    }
  ]
}
```

Paths must stay inside the library, including after resolving symlinks. Paired mobile images
require pairing evidence. A desktop-only entry must omit `mobileImagePath`; its prompt explicitly
requires derived and visually tested mobile behavior. Rejected entries and threshold variants are
excluded. Missing, malformed or corrupt files produce actionable errors. Providers
without image inspection cannot execute a run requiring these references.

The loader also indexes labeled complete images in each site's `generated/` directory, using its
manifest or README for the source URL. Desktop/mobile, full and versioned filenames represent one
composition; numbered fragments and known rejected, incomplete or revision-needed sections are
excluded. Existing catalog IDs, including rejected ones, take precedence over automatic discovery.
Generated candidates explicitly carry pending visual-review and responsive-pairing notes. Brand and
Page must inspect the selected pixels before planning; filenames are not proof of a usable pair.
Keep original captures and superseded revisions. Add reviewed catalog records with the same IDs
to replace automatic candidates once inspected, and label alternate revisions with the same group.

## Validation status

The local initial catalog contains ten individually inspected section pairs from Meridian,
Ritovex and Scalient. Complete-image discovery expands this installation to 172 composition groups,
including 24 heroes. The roughly one thousand raw generated images include fragments and revisions;
they are not one thousand independent layouts and have not all been visually reviewed. Runtime unit
and orchestration checks cover equal anchor-group eligibility, the anchor-site and close-site
tiers, the requested family before compatible geometry, the minimum similarity score, outlier
exclusion, missing or malformed style profiles, dashboard domain relevance, sampling without
replacement, explicit selection, image attachment transport, catalog validation and persisted
selection including deck sites and roles. A seeded 2,000-page simulation over the bundled library
checks that only sparse families borrow geometry and only when their own family is out of reach,
and that no reference reaches a quarter of all pages.
Four clean TasteCode site runs have finished. Each was started once
with Astra medium and one user prompt in a fresh project: Fieldwork, Orbit, Atelier Fern and
Clearpath. The test app uses isolated data, renderer port 5185 and server port 4315. Earlier
development attempts exposed shared-font, native-component, attribution-data and prompt-echo
validation gaps; the clean runs use those fixes together. Orbit and Clearpath completed the flow;
Atelier Fern built but encountered a preview-port collision; Fieldwork stopped at asset validation.
Subsequent port and full-page capture fixes have regression coverage. See the
[validation report](verification/design-agent-v05-2026-09-16/README.md) for evidence and remaining gaps.
