# Bundled Design reference library

This is the portable runtime selection from the generated reference collection: 172
composition groups, including 24 heroes, with 316 raster files and 144 paired mobile views.
The images are WebP re-encodes (quality 90) of the original PNG captures, which stay in the
external collection. A normal clone and desktop package include these files; no separate
download, external drive, Git LFS, or local configuration is required.

`catalog.json` preserves source URLs, review status, pairing evidence and the SHA-256 hashes
of the bundled files.
Candidate entries still require inspection during the Design run. Rejected sections,
incomplete fragments and superseded revisions are excluded from the runtime pool.

`style-profiles.json` (version 1) describes the design language of each source site, keyed by
the source host without `www.`: theme, palette, heading and body type, radius, buttons, density,
imagery, layout motifs, mood, a one-line summary and any `outliers` (entry ids that do not match
the rest of that site). The sampler uses it to keep one design language per page: each section
comes from the anchor hero's site first, then from close profiled sites (style score at least 10
of 14), always in its own layout family unless that family is too sparse. The file is optional;
a library without it, or with a malformed one, falls back to same-site and uniform sampling.

These generated images are layout references, not production website assets. Source URLs
identify the referenced sites; they do not confer rights to third-party names, logos,
photographs or artwork depicted in a reference. Do not represent them as client work or
copy them into a generated site's production assets. Public redistribution review remains
a separate release requirement from the source-code and dependency licenses.

The library can be overridden with `TASTECODE_REFERENCE_LIBRARY` or `libraryPath` in
`~/.tastecode/design-references.json`. See `docs/DESIGN-REFERENCES.md` in the repository.
