// @vitest-environment happy-dom
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../test-transport.js'
import { ComposerResourcePicker, type ComposerResource } from './ComposerResourcePicker.js'
import type { ComposerResourcePickerHandle } from './composer-resource.js'

function createResourceTransport() {
  return new TestTransport(async (method) => {
    if (method === 'skills.list') {
      return {
        capabilities: { inventory: true, configure: false, install: false },
        skills: [
          {
            id: '/Users/me/.agents/skills/animate/SKILL.md',
            name: 'animate',
            displayName: 'Animate',
            description: 'Build an animation from scratch',
            source: { type: 'folder', path: '/Users/me/.agents/skills/animate' },
            scope: 'user',
            enabled: true,
            dependencyErrors: [],
          },
        ],
        errors: [],
      }
    }
    if (method === 'mcp.list') {
      return {
        capabilities: {
          inventory: false,
          add: true,
          update: true,
          remove: true,
          reload: false,
          startOAuth: false,
          cancelOAuth: false,
        },
        servers: [
          {
            id: 'officialDocs',
            displayName: 'Official Docs',
            description: 'Search official product documentation',
            scope: 'global',
            enabled: true,
            auth: { status: 'not_required' },
            startup: { state: 'ready' },
            tools: [],
            resources: [],
            resourceTemplates: [],
          },
        ],
      }
    }
    throw new Error(`Unexpected request: ${method}`)
  })
}

describe('ComposerResourcePicker', () => {
  it('keeps hover highlight and selectActive in sync', async () => {
    const onSelect = vi.fn<(resource: ComposerResource) => void>()
    const pickerRef = createRef<ComposerResourcePickerHandle>()

    render(
      <ComposerResourcePicker
        ref={pickerRef}
        transport={createResourceTransport()}
        provider="codex"
        projectPath="/work/project"
        trigger={{ marker: '@', query: '', start: 0, end: 1 }}
        selectedKeys={new Set()}
        onSelect={onSelect}
      />,
    )

    const docs = await screen.findByRole('option', { name: /Official Docs/ })
    fireEvent.mouseEnter(docs)

    expect(docs.getAttribute('aria-selected')).toBe('true')
    expect(pickerRef.current?.selectActive()).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mcp:officialDocs', name: 'Official Docs' }),
    )
  })
})
