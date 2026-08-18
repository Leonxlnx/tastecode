import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const pullRequestCss = readFileSync(
  new URL('../ui/pull-requests/pull-requests.css', import.meta.url),
  'utf8',
)

describe('reduced-motion feedback', () => {
  it('keeps the universal still-by-default fallback in tokens', () => {
    expect(tokensCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.01ms !important;[\s\S]*?animation-iteration-count: 1 !important;[\s\S]*?transition-duration: 0\.01ms !important;[\s\S]*?scroll-behavior: auto !important;/s,
    )
  })

  it('allowlists only finite opacity and color feedback in app CSS', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sheet__scrim,[\s\S]*?\.sheet__panel \{[\s\S]*?animation: fade-in var\(--dur-fast\) var\(--ease-out\) both !important;/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.profile-page,[\s\S]*?\.settings__panel \{[\s\S]*?animation: fade-in var\(--dur-fast\) var\(--ease-out\) both !important;/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.notice \{[\s\S]*?transform: none !important;[\s\S]*?transition: opacity var\(--dur-fast\) var\(--ease-out\) !important;/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.model-selector__fast \{[\s\S]*?color var\(--dur-press\) var\(--ease-out\),[\s\S]*?background-color var\(--dur-press\) var\(--ease-out\),[\s\S]*?border-color var\(--dur-press\) var\(--ease-out\),[\s\S]*?box-shadow var\(--dur-press\) var\(--ease-out\) !important;/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.model-selector__fast-icon svg \{[\s\S]*?transition: fill var\(--dur-press\) var\(--ease-out\) !important;/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.orb \{[\s\S]*?background-color var\(--dur-press\) var\(--ease-out\),[\s\S]*?box-shadow var\(--dur-press\) var\(--ease-out\),[\s\S]*?color var\(--dur-press\) var\(--ease-out\) !important;/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.spinner,[\s\S]*?\.orb--stop\.is-stopping \.orb__icon--stop \{[\s\S]*?animation: none !important;/s,
    )
  })

  it('keeps transform, rotate, filter, clip-path, and layout properties out of reduced-motion transitions', () => {
    const reducedBlocks = [
      ...appCss.matchAll(/@media \(prefers-reduced-motion: reduce\) \{(?<body>[\s\S]*?)\n\}/g),
      ...pullRequestCss.matchAll(
        /@media \(prefers-reduced-motion: reduce\) \{(?<body>[\s\S]*?)\n\}/g,
      ),
    ].map((match) => match.groups?.['body'] ?? '')

    const transitionDeclarations = reducedBlocks.flatMap((block) =>
      Array.from(block.matchAll(/transition:[^;]+;/g)).map((match) => match[0]),
    )

    for (const declaration of transitionDeclarations) {
      expect(declaration).not.toMatch(
        /\b(transform|rotate|translate|filter|clip-path|width|height|grid)\b/,
      )
    }
  })

  it('keeps the PR sender on non-spatial state feedback only', () => {
    expect(pullRequestCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pr-send-button \{[\s\S]*?background-color var\(--dur-press\) var\(--ease-out\),[\s\S]*?box-shadow var\(--dur-press\) var\(--ease-out\),[\s\S]*?color var\(--dur-press\) var\(--ease-out\) !important;/s,
    )
    expect(pullRequestCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pr-send-button:hover:not\(:disabled\),[\s\S]*?\.pr-send-button:active:not\(:disabled\) \{[\s\S]*?transform: none !important;/s,
    )
  })
})
