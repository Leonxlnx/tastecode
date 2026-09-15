# Design Agent v0.5 reference workflow

New Design runs extract the requested sections and existing brand constraints before selecting
references. The server randomly chooses one reviewed composition group per available section
family from a suitable collection; alternate revisions do not get extra votes. Explicit reference
IDs take priority. The page planner uses only sections needed by the brief.

The selected catalog records and file hashes are persisted with the Design run. Brand, page,
asset, build and visual review turns receive the actual selected desktop and paired mobile
images. Resuming a run retains the selection and rejects changed reference files. Existing
pre-v0.5 runs retain their original bundled reference behavior. User-attached references take
precedence and do not require a configured catalog.

The implementation preserves reference composition while adapting the project's brand, copy,
palette and imagery. It builds real responsive HTML/CSS, acquires suitable image assets where
needed, and uses the existing source checks, desktop/mobile preview capture, visual review and
bounded repair loop. Reference images are guidance, not page backgrounds or production assets.

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
requires derived and visually tested mobile behavior. Unreviewed/rejected entries and threshold
variants are excluded. Missing, malformed or corrupt files produce actionable errors. Providers
without image inspection cannot execute a run requiring these references.

Add reviewed entries to the catalog to make them available to new runs. Keep original captures,
generated images and superseded revisions; label revisions with the same `group`. Do not count
filenames or matching desktop/mobile suffixes as proof of a usable responsive pair.

## Validation status

The local initial catalog contains ten individually inspected section pairs from Meridian,
Ritovex and Scalient. It intentionally does not claim that the roughly one thousand raw generated
images have all been reviewed. Runtime unit and orchestration checks cover random selection,
explicit selection, image attachment transport, catalog validation and persisted selection.
Four actual TasteCode site runs and their visual evidence are still pending.
