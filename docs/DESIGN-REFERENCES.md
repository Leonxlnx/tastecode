# Design Agent v0.5 reference workflow

New Design runs extract the requested sections and existing brand constraints before selecting
references. The server samples composition groups uniformly across the entire eligible library,
independently for each layout family. Style tags and source sites never narrow the random pool;
alternate revisions do not get extra votes. It selects up to three feature compositions and two
about compositions without replacement, and one of each other family. Explicit reference IDs or
source URLs take priority. The page planner uses only sections needed by the brief. Free-form section
names never filter out needed compositions. Missing families use available compositions with the
requested content adapted inside them; section topics do not have to match layout family names.

The selected catalog records and file hashes are persisted with the Design run. Brand, page,
asset, build and visual review turns receive the actual selected desktop and paired mobile
images. Resuming a run retains the selection and rejects changed reference files. Existing
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

## Local library

Set `TASTECODE_REFERENCE_LIBRARY` to an absolute library directory before starting TasteCode,
or set `libraryPath` in `~/.tastecode/design-references.json`. No machine-specific image directory
is compiled into the application. The directory must contain `catalog.json`:

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
Ritovex and Scalient. Complete-image discovery expands this installation to 120 composition groups,
including 16 heroes. The roughly one thousand raw generated images include fragments and revisions;
they are not one thousand independent layouts and have not all been visually reviewed. Runtime unit
and orchestration checks cover equal group eligibility, sampling without replacement,
explicit selection, image attachment transport, catalog validation and persisted selection.
Four clean TasteCode site runs have finished. Each was started once
with Astra medium and one user prompt in a fresh project: Fieldwork, Orbit, Atelier Fern and
Clearpath. The test app uses isolated data, renderer port 5185 and server port 4315. Earlier
development attempts exposed shared-font, native-component, attribution-data and prompt-echo
validation gaps; the clean runs use those fixes together. Orbit and Clearpath completed the flow;
Atelier Fern built but encountered a preview-port collision; Fieldwork stopped at asset validation.
Subsequent port and full-page capture fixes have regression coverage. See the
[validation report](verification/design-agent-v05-2026-09-16/README.md) for evidence and remaining gaps.
