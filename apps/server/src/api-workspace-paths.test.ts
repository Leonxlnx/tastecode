import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPublicWorkspaceFile,
  existingWorkspacePath,
  isSecretWorkspaceName,
  writableWorkspacePath,
} from './api-workspace-paths.js'

describe('direct API workspace path policy', () => {
  it('keeps reads and writes inside the real workspace', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-api-paths-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'harness-api-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, path.join(workspace, 'linked'), 'junction')

    expect(() => existingWorkspacePath(workspace, '../outside', false)).toThrow(
      'path escapes the workspace',
    )
    expect(() => existingWorkspacePath(workspace, 'linked/secret.txt', false)).toThrow(
      'path escapes the workspace',
    )
    expect(() => writableWorkspacePath(workspace, 'linked/new.txt')).toThrow(
      'path escapes the workspace',
    )
  })

  it('allows nested destinations under a real workspace directory', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-api-paths-'))
    mkdirSync(path.join(workspace, 'src'))
    expect(writableWorkspacePath(workspace, 'src/components/Card.tsx')).toBe(
      path.join(workspace, 'src', 'components', 'Card.tsx'),
    )
  })

  it('recognizes common credential files', () => {
    expect(isSecretWorkspaceName('.env.local')).toBe(true)
    expect(isSecretWorkspaceName('client.pem')).toBe(true)
    expect(() => assertPublicWorkspaceFile(path.join('project', '.git', 'config'))).toThrow(
      'credential files are not available',
    )
  })
})
