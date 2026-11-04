import { describe, expect, it } from 'vitest'
import { DubiousOwnership, ownershipRefusal } from './git-ownership.js'

/**
 * Against git's own words. A real repository cannot change its owner in a
 * portable test, so these are the messages git prints, as captured.
 */

const repoPath = 'E:\\tastecodetests\\testv0.5\\test18'

// Git for Windows, for a `.git` that Codex's sandbox account created.
const windows = [
  "fatal: detected dubious ownership in repository at 'E:/tastecodetests/testv0.5/test18'",
  "'E:/tastecodetests/testv0.5/test18/.git' is owned by:",
  '\tLEXN/CodexSandboxOffline (S-1-5-21-1111111111-2222222222-3333333333-1004)',
  'but the current user is:',
  '\tLEXN/User (S-1-5-21-1111111111-2222222222-3333333333-1001)',
  'To add an exception for this directory, call:',
  '',
  '\tgit config --global --add safe.directory E:/tastecodetests/testv0.5/test18',
  '',
].join('\n')

// Git elsewhere names no owner; a path with a space comes quoted.
const unnamed = [
  "fatal: detected dubious ownership in repository at '/home/me/my repo'",
  'To add an exception for this directory, call:',
  '',
  "\tgit config --global --add safe.directory '/home/me/my repo'",
  '',
].join('\n')

describe('ownershipRefusal', () => {
  it("names the owner and git's own fix from a Windows refusal", () => {
    const refusal = ownershipRefusal(repoPath, windows)
    expect(refusal).toBeInstanceOf(DubiousOwnership)
    expect(refusal?.owner).toBe('LEXN/CodexSandboxOffline')
    expect(refusal?.fix).toBe(
      'git config --global --add safe.directory E:/tastecodetests/testv0.5/test18',
    )
    expect(refusal?.message).toBe(
      'Git refuses to use E:\\tastecodetests\\testv0.5\\test18 because the repository ' +
        "belongs to another Windows user (LEXN/CodexSandboxOffline). Git's own fix is " +
        '`git config --global --add safe.directory E:/tastecodetests/testv0.5/test18`.',
    )
  })

  it('reads the refusal from the error of a failed run, line endings and all', () => {
    const error = Object.assign(new Error('Command failed: git rev-parse --git-dir'), {
      stderr: windows.replaceAll('\n', '\r\n'),
    })
    expect(ownershipRefusal(repoPath, error)?.owner).toBe('LEXN/CodexSandboxOffline')
  })

  it('does not claim another user when git names none', () => {
    const refusal = ownershipRefusal('/home/me/my repo', unnamed)
    expect(refusal?.owner).toBeUndefined()
    expect(refusal?.message).toBe(
      'Git refuses to use /home/me/my repo because it cannot confirm that the repository ' +
        "belongs to the current user. Git's own fix is " +
        "`git config --global --add safe.directory '/home/me/my repo'`.",
    )
    const inconvertible = windows.replace('LEXN/CodexSandboxOffline (', '(inconvertible) (')
    expect(ownershipRefusal(repoPath, inconvertible)?.owner).toBeUndefined()
  })

  it('leaves every other failure to the caller', () => {
    expect(
      ownershipRefusal(
        repoPath,
        'fatal: not a git repository (or any of the parent directories): .git',
      ),
    ).toBeUndefined()
    expect(ownershipRefusal(repoPath, new Error('spawn git ENOENT'))).toBeUndefined()
    expect(ownershipRefusal(repoPath, undefined)).toBeUndefined()
  })
})
