import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBrandSystem, readBrandSystem, writeBrandSystem } from './brand.js'

const brand = {
  version: 1,
  foundation: {
    strategy: 'extend',
    existingAssets: ['public/logo.svg'],
    assetActions: [
      { asset: 'public/logo.svg', action: 'protect', reason: 'Supplied official mark.' },
    ],
    lockedDecisions: ['Keep the supplied logo and warm paper background.'],
    assumptions: ['No documented motion direction exists.'],
  },
  creativeDirection: {
    summary: 'Editorial coffee culture with tactile warmth.',
    traits: [
      { quality: 'warm', boundary: 'not rustic' },
      { quality: 'precise', boundary: 'not sterile' },
    ],
    productiveTension: 'Warm craft with precise utility.',
    signatureDevice: {
      description: 'A cropped circular roast mark.',
      status: 'existing',
      invariants: ['Circular silhouette', 'Off-center crop'],
    },
    restraint: 'Use the roast mark once per major surface.',
    avoid: ['Generic startup styling'],
  },
  colorPalette: [
    { name: 'Warm Paper', value: '#F2EDE4', usage: 'Primary light canvas' },
    { name: 'Espresso', value: '#211B17', usage: 'Text and dark surfaces' },
  ],
  typefaces: [
    {
      family: 'Instrument Serif',
      source: 'Google Fonts',
      roles: ['display', 'headings'],
      weights: [400],
    },
  ],
  interfaceDirection: 'Flat editorial surfaces with thin borders and minimal shadows.',
  imageDirection: {
    summary: 'Warm editorial photography focused on craft.',
    subjects: ['Coffee preparation'],
    treatment: 'Natural light and restrained contrast.',
    avoid: ['Generic stock cafés'],
  },
  motionDirection: {
    summary: 'Smooth, tactile, and restrained.',
    principles: ['Motion clarifies state'],
    avoid: ['Continuous floating effects'],
  },
  voice: {
    summary: 'Confident, sensory, and concise.',
    avoid: ['Unsupported superlatives'],
  },
} as const

describe('brand system handoff', () => {
  it('round-trips the validated brand system', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-brand-'))
    try {
      expect(writeBrandSystem(workspace, brand)).toEqual(brand)
      expect(readBrandSystem(workspace)).toEqual(brand)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects invalid nested decisions', () => {
    expect(() => writeBrandSystem('ignored', { ...brand, typefaces: [] })).toThrow(
      'typefaces must be a non-empty array',
    )
  })

  it('normalizes numeric font weights from provider JSON', () => {
    expect(
      parseBrandSystem({
        ...brand,
        typefaces: [{ ...brand.typefaces[0], weights: ['400', '700'] }],
      }).typefaces[0]?.weights,
    ).toEqual([400, 700])
  })

  it('keeps older brand artifacts readable with a conservative foundation', () => {
    const { foundation: _foundation, ...legacy } = brand
    expect(parseBrandSystem(legacy).foundation).toEqual({
      strategy: 'create',
      existingAssets: [],
      assetActions: [],
      lockedDecisions: [],
      assumptions: [],
    })
  })

  it('keeps legacy creative direction readable while marking its device as unproven', () => {
    const legacy = {
      ...brand,
      creativeDirection: {
        summary: brand.creativeDirection.summary,
        keywords: ['warm', 'precise'],
        avoid: brand.creativeDirection.avoid,
      },
    }
    expect(parseBrandSystem(legacy).creativeDirection.signatureDevice.status).toBe('candidate')
  })

  it('keeps brand systems approved before design tokens readable without inventing tokens', () => {
    expect('designTokens' in parseBrandSystem(brand)).toBe(false)
    expect('designTokens' in parseBrandSystem({ ...brand, designTokens: null })).toBe(false)
  })

  it('round-trips page-wide design tokens and normalizes their format leniently', () => {
    const designTokens = {
      typeScale: {
        display: 'clamp(3.5rem, 2rem + 6vw, 7.5rem)',
        h1: 'clamp(2.5rem, 5vw, 4rem)',
        h2: '2.25rem',
        h3: '1.5rem',
        body: '1.0625rem',
        small: '0.875rem',
        label: 12,
      },
      radius: ['4px', '12px', 24, '9999px'],
      spacing: { section: 'clamp(4rem, 10vw, 9rem)', gutter: '1.5rem', stack: 0 },
      buttons: { primary: 'Solid accent pill, 48px tall.', secondary: 'Text link with arrow.' },
      surfaces: 'Warm paper canvas; one dark espresso band before the footer.',
    }
    const parsed = parseBrandSystem({ ...brand, designTokens })
    expect(parsed.designTokens).toEqual({
      ...designTokens,
      typeScale: { ...designTokens.typeScale, label: '12px' },
      radius: { scale: ['4px', '12px', '24px'], pill: '9999px' },
      spacing: { ...designTokens.spacing, stack: '0' },
    })
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-brand-tokens-'))
    try {
      writeBrandSystem(workspace, parsed)
      expect(readBrandSystem(workspace)).toEqual(parsed)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
    expect(
      parseBrandSystem({
        ...brand,
        designTokens: { ...designTokens, radius: { values: ['2px', '8px'] } },
      }).designTokens?.radius,
    ).toEqual({ scale: ['2px', '8px'], pill: '999px' })
  })

  it('rejects design tokens that later phases could not apply as one shared scale', () => {
    const designTokens = {
      typeScale: {
        display: '6rem',
        h1: '4rem',
        h2: '3rem',
        h3: '2rem',
        body: '1rem',
        small: '0.875rem',
        label: '0.75rem',
      },
      radius: { scale: ['4px', '8px', '16px'], pill: '999px' },
      spacing: { section: '8rem', gutter: '2rem', stack: '1rem' },
      buttons: { primary: 'Solid accent.', secondary: 'Outline.' },
      surfaces: 'Light canvas throughout.',
    }
    expect(() =>
      parseBrandSystem({
        ...brand,
        designTokens: {
          ...designTokens,
          typeScale: { ...designTokens.typeScale, h2: '3rem; } body { display: none' },
        },
      }),
    ).toThrow('designTokens.typeScale.h2 must be a CSS length')
    expect(() =>
      parseBrandSystem({
        ...brand,
        designTokens: { ...designTokens, typeScale: { ...designTokens.typeScale, h3: undefined } },
      }),
    ).toThrow('designTokens.typeScale.h3')
    expect(() =>
      parseBrandSystem({
        ...brand,
        designTokens: { ...designTokens, radius: ['2px', '4px', '8px', '16px', '32px'] },
      }),
    ).toThrow('one to four radii')
    expect(() =>
      parseBrandSystem({ ...brand, designTokens: { ...designTokens, buttons: { primary: 'x' } } }),
    ).toThrow('designTokens.buttons.secondary')
  })

  it('allows a new brand to have no existing asset decisions', () => {
    expect(
      parseBrandSystem({
        ...brand,
        foundation: { ...brand.foundation, assetActions: [] },
      }).foundation.assetActions,
    ).toEqual([])
  })
})
