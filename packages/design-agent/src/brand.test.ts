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
})
