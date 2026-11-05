#!/usr/bin/env node
// TasteCode's local patch (packages/default-skills/patches): the bundled skill has no photo library,
// so this command deals, fetches and credits nothing. It says where pictures come from instead.
console.error(
  [
    'photos: TasteCode ships this skill without a photo library, and nothing is fetched from stock.',
    "Use the pictures the brief and the user supply. In Design mode, TasteCode's Asset phase provides them.",
    "A section with no picture yet keeps its frame as a named slot for the client's file",
    '(references/sections-library.md, client-slots), and the report lists it.',
  ].join('\n'),
)
process.exitCode = 1
