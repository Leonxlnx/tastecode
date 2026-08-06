import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBrandSystem, readBrandSystem, writeBrandSystem } from './brand.js'

const brand = {
  version: 1,
  creativeDirection: {
    summary: 'Editorial coffee culture with tactile warmth.',
    keywords: ['warm', 'precise'],
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
})
