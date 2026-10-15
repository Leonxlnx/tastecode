// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { generatedAvatar, type AvatarStyle } from '../generated-avatar.js'
import { GeneratedAvatarLab, avatarRecipe } from './GeneratedAvatarLab.js'

afterEach(cleanup)

/** Every preview paints the same picture, so its markup identifies the name. */
function previews(): string[] {
  return Array.from(document.querySelectorAll('.avatar-lab__preview svg'), (svg) => svg.innerHTML)
}

function recipe(name: string, style?: AvatarStyle): string {
  return avatarRecipe(generatedAvatar(name, style))
}

describe('generated avatar lab', () => {
  it('previews the typed name at every shipped size and swaps to a sample on click', () => {
    render(<GeneratedAvatarLab initialName="Leon" />)

    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input).toHaveProperty('value', 'Leon')
    expect(screen.getByText('Profile · 88px')).toBeTruthy()
    expect(screen.getByText('Rail · 18px')).toBeTruthy()
    const leon = previews()
    expect(leon).toHaveLength(3)
    expect(new Set(leon).size).toBe(1)
    expect(screen.getByText(recipe('Leon'))).toBeTruthy()

    fireEvent.change(input, { target: { value: 'Bluedev' } })
    expect(previews()[0]).not.toBe(leon[0])
    expect(screen.getByText(recipe('Bluedev'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/u, pressed: false }))
    expect(input).toHaveProperty('value', 'Ada Lovelace')
    expect(screen.getByRole('button', { name: /Ada Lovelace/u, pressed: true })).toBeTruthy()
    expect(screen.getByText(recipe('Ada Lovelace'))).toBeTruthy()
  })

  it('redraws every preview and sample in the chosen candidate style', () => {
    render(<GeneratedAvatarLab initialName="Leon" />)

    expect(screen.getByRole('button', { name: /Mandala · shipping/u, pressed: true })).toBeTruthy()
    const mandala = previews()[0]
    fireEvent.click(screen.getByRole('button', { name: 'Orb', pressed: false }))
    expect(screen.getByRole('button', { name: 'Orb', pressed: true })).toBeTruthy()
    expect(screen.getByText(recipe('Leon', 'orb'))).toBeTruthy()
    expect(previews()[0]).not.toBe(mandala)
    expect(document.querySelectorAll('.avatar-lab__sample linearGradient')).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: 'Marble', pressed: false }))
    expect(screen.getByText(recipe('Leon', 'marble'))).toBeTruthy()
    expect(document.querySelectorAll('.avatar-lab__preview circle')).toHaveLength(3 * 4)
  })

  it('falls back to the local profile name and offers a random one', () => {
    render(<GeneratedAvatarLab initialName="   " />)

    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' })
    expect(input.value).toBe('Local profile')
    fireEvent.click(screen.getByRole('button', { name: 'Random name' }))
    expect(input.value).not.toBe('Local profile')
    expect(input.value.trim().length).toBeGreaterThan(0)
  })
})
