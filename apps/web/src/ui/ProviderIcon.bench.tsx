import type { ProviderMark } from '../model-catalog.js'
import { sessionSourcePresentation } from '../provider-presentation.js'
import { bench, describe } from 'vitest'
import { ProviderIcon } from './ProviderIcon.js'

const MARKS = [
  'openai',
  'anthropic',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'openrouter',
  'gemini',
  'qwen',
  'kimi',
  'pi',
  'zai',
  'acp',
  'custom',
] as const satisfies readonly ProviderMark[]

describe('provider icon lookup', () => {
  bench(
    'creates 10,000 mixed provider marks',
    () => {
      let checksum = 0
      for (let index = 0; index < 10_000; index += 1) {
        const icon = ProviderIcon({ mark: MARKS[index % MARKS.length]! })
        checksum += Number(icon.props['width'])
      }
      if (checksum !== 180_000) throw new Error('invalid provider icon output')
    },
    { time: 1_200, warmupTime: 300 },
  )

  bench(
    'resolves and creates 10,000 mixed session source marks',
    () => {
      let checksum = 0
      for (let index = 0; index < 10_000; index += 1) {
        const agent = index % 4 === 0 ? 'gemini' : index % 4 === 1 ? 'kimi' : 'custom-agent'
        const source = sessionSourcePresentation(index % 2 === 0 ? 'acp' : 'codex', agent)
        const icon = ProviderIcon({ mark: source.mark })
        checksum += source.label.length + Number(icon.props['width'])
      }
      if (checksum === 0) throw new Error('invalid session source output')
    },
    { time: 1_200, warmupTime: 300 },
  )
})
