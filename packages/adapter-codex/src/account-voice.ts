import { spawnCli, StdioJsonRpc } from '@harness/proc'
import { runCli } from '@harness/proc/cli'
import { z } from 'zod'
import {
  requestOpenAiTranscription,
  validateVoiceClip,
  VoiceTranscriptionError,
  type VoiceHttpResponse,
  type VoiceTranscriptionInput,
} from './voice.js'

const authSchema = z.object({ authMethod: z.string().nullable(), authToken: z.string().nullable() })
const transcriptSchema = z.object({
  text: z.string().optional(),
  transcript: z.string().optional(),
})
type ResolveAuth = (refresh: boolean, signal?: AbortSignal) => Promise<string>
type Upload = (audio: Buffer, token: string, signal?: AbortSignal) => Promise<VoiceHttpResponse>

/** Account credentials exist only inside this adapter for the duration of an upload. */
export class CodexVoiceTranscriber {
  constructor(
    private readonly resolveAuth: ResolveAuth = resolveAccountToken,
    private readonly upload: Upload = (audio, token, signal) =>
      requestOpenAiTranscription(audio, token, signal, true),
  ) {}

  async status(): Promise<{ available: boolean; reason?: 'sign_in_required' }> {
    try {
      const result = await runCli('codex', ['login', 'status'])
      if (
        result.code === 0 &&
        /Logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`)
      ) {
        return { available: true }
      }
    } catch {
      // Missing CLI and signed-out accounts both require Codex setup.
    }
    return { available: false, reason: 'sign_in_required' }
  }

  async transcribe(input: VoiceTranscriptionInput, signal?: AbortSignal): Promise<string> {
    const audio = validateVoiceClip(input)
    try {
      for (const refresh of [false, true]) {
        signal?.throwIfAborted()
        const token = await this.resolveAuth(refresh, signal)
        signal?.throwIfAborted()
        if (!token.trim() || /[\r\n]/u.test(token)) throw new Error('Invalid account credential')
        const response = await this.upload(audio, token, signal)
        signal?.throwIfAborted()
        if (response.status === 401 || response.status === 403) {
          if (!refresh) continue
          throw new VoiceTranscriptionError(
            'unsupported_auth',
            'Sign in to Codex again to use dictation.',
          )
        }
        if (response.status < 200 || response.status >= 300) {
          throw new VoiceTranscriptionError(
            'upstream_failure',
            `Dictation failed (${response.status}). Try again.`,
          )
        }
        const payload = transcriptSchema.parse(JSON.parse(response.body))
        const text = payload.text?.trim() || payload.transcript?.trim()
        if (!text) throw new VoiceTranscriptionError('upstream_failure', 'No speech was detected.')
        return text
      }
      throw new Error('Account refresh failed')
    } catch (error) {
      if (signal?.aborted)
        throw new VoiceTranscriptionError('cancelled', 'Dictation was cancelled.')
      if (error instanceof VoiceTranscriptionError) throw error
      // Do not expose provider frames, credential values, or response bodies.
      throw new VoiceTranscriptionError(
        'upstream_failure',
        'Dictation could not connect. Check Codex sign-in and try again.',
      )
    }
  }
}

async function resolveAccountToken(refreshToken: boolean, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const rpc = new StdioJsonRpc(spawnCli('codex', ['app-server']), 'Codex dictation')
  const abort = () => {
    void rpc.dispose()
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await rpc.request(
      'initialize',
      {
        clientInfo: { name: 'tastecode_dictation', title: 'TasteCode dictation', version: '1.0.0' },
      },
      { timeoutMs: 10_000 },
    )
    rpc.notify('initialized')
    const result = authSchema.parse(
      await rpc.request(
        'getAuthStatus',
        {
          includeToken: true,
          refreshToken,
        },
        { timeoutMs: 10_000 },
      ),
    )
    if (!['chatgpt', 'chatgptAuthTokens'].includes(result.authMethod ?? '') || !result.authToken) {
      throw new VoiceTranscriptionError(
        'unsupported_auth',
        'Sign in to Codex with your ChatGPT account to use dictation.',
      )
    }
    return result.authToken
  } finally {
    signal?.removeEventListener('abort', abort)
    await rpc.dispose()
  }
}
