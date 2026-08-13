// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileSettings } from './ProfileSettings.js'

afterEach(cleanup)

describe('profile settings', () => {
  it('shows the local identity without loading usage history', () => {
    render(
      <ProfileSettings
        account={{ signedIn: true, email: 'blue.emi@example.com', plan: 'Pro' }}
        providerName="Codex"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Blue Emi' })).toBeTruthy()
    expect(document.querySelector('.profile-identity__avatar')?.textContent).toBe('BE')
    expect(screen.getByText('@blue.emi')).toBeTruthy()
    expect(screen.getByText('Pro')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: undefined })
  })

  it('ignores an image read that finishes after the profile closes', async () => {
    let finishRead: (value: ArrayBuffer) => void = () => {}
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    vi.spyOn(file, 'slice').mockReturnValue({
      arrayBuffer: () => new Promise((resolve) => (finishRead = resolve)),
    } as Blob)
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
