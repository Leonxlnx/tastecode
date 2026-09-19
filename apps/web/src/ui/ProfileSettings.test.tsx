// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { ProfileSettings } from './ProfileSettings.js'

afterEach(cleanup)

function renderedAvatarCells(): string {
  return document.querySelector('.profile-identity__avatar svg')!.innerHTML
}

/** What the picture for `name` looks like when rendered on its own. */
function expectedAvatarCells(name: string): string {
  const view = render(<GeneratedAvatar name={name} />)
  const markup = view.container.querySelector('svg')!.innerHTML
  view.unmount()
  return markup
}

describe('profile settings', () => {
  it('keeps the onboarding name when switching to Grok', () => {
    const view = render(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Blue Emi' }}
      />,
    )
    view.rerender(
      <ProfileSettings
        account={undefined}
        providerName="Grok"
        identity={{ displayName: 'Blue Emi' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Blue Emi' })).toBeTruthy()
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Blue Emi'))
    expect(screen.queryByText('Grok')).toBeNull()
  })

  it('shows the local identity without loading usage history', () => {
    render(
      <ProfileSettings
        account={{ signedIn: true, email: 'blue.emi@example.com', plan: 'Pro' }}
        providerName="Codex"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Local profile' })).toBeTruthy()
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Local profile'))
    expect(screen.getByText(/Generated from your name/u)).toBeTruthy()
    expect(screen.queryByText('@blue.emi')).toBeNull()
    expect(screen.getByText('Pro')).toBeTruthy()
  })

  it('regenerates the picture from the name until a photo replaces it', () => {
    const view = render(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon' }}
      />,
    )
    const leon = renderedAvatarCells()
    expect(leon).toBe(expectedAvatarCells('Leon'))

    view.rerender(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Bluedev' }}
      />,
    )
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Bluedev'))
    expect(renderedAvatarCells()).not.toBe(leon)

    view.rerender(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Bluedev', avatarDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }}
      />,
    )
    expect(document.querySelector('.profile-identity__avatar svg')).toBeNull()
    expect(document.querySelector('.profile-identity__avatar img')).toBeTruthy()
    expect(screen.getByText(/Remove the photo to go back/u)).toBeTruthy()
  })

  it('edits the local display name and validates profile photos', async () => {
    const onIdentityChange = vi.fn()
    const { rerender } = render(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: '' }}
        onIdentityChange={onIdentityChange}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Leon' },
    })
    expect(onIdentityChange).toHaveBeenLastCalledWith({ displayName: 'Leon' })

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.closest('.profile-identity__portrait')).toBeTruthy()
    expect(input.closest('label')?.textContent).toBe('Upload photo')
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull()
    fireEvent.change(input, {
      target: {
        files: [
          new File(
            [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
            'avatar.png',
            { type: 'image/png' },
          ),
        ],
      },
    })
    await waitFor(() =>
      expect(onIdentityChange).toHaveBeenLastCalledWith({
        avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    )
    fireEvent.change(input, {
      target: { files: [new File(['nope'], 'avatar.png', { type: 'image/png' })] },
    })
    expect((await screen.findByRole('alert')).textContent).toContain('not a valid image')

    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgo='
    rerender(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon', avatarDataUrl }}
        onIdentityChange={onIdentityChange}
      />,
    )
    expect(document.querySelector('.profile-identity__avatar img')?.getAttribute('src')).toBe(
      avatarDataUrl,
    )
    expect(input.closest('label')?.textContent).toBe('Change photo')
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: undefined })
  })

  it('ignores an image read that finishes after the profile closes', async () => {
    let finishRead: (value: ArrayBuffer) => void = () => {}
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    const slicedFile = new Blob()
    vi.spyOn(slicedFile, 'arrayBuffer').mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve)),
    )
    vi.spyOn(file, 'slice').mockReturnValue(slicedFile)
    const onIdentityChange = vi.fn()
    const view = render(
      <ProfileSettings
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon' }}
        onIdentityChange={onIdentityChange}
      />,
    )
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    view.unmount()
    finishRead(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onIdentityChange).not.toHaveBeenCalled()
  })
})
