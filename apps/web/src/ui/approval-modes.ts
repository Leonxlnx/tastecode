import type { ApprovalMode } from '@harness/contracts'
import {
  IconLockOpen as LockOpen,
  IconScanEye as ScanEye,
  IconShieldCheck as ShieldCheck,
  IconShieldQuestion as ShieldQuestion,
  type TablerIcon,
} from '@tabler/icons-react'

export const APPROVAL_MODES: {
  id: ApprovalMode
  title: string
  short: string
  detail: string
  icon: TablerIcon
}[] = [
  {
    id: 'ask',
    title: 'Ask first',
    short: 'Ask first',
    detail: 'Approve each edit and command',
    icon: ShieldQuestion,
  },
  {
    id: 'auto',
    title: 'Auto-approve',
    short: 'Auto',
    detail: 'Edits and commands in this folder',
    icon: ShieldCheck,
  },
  {
    id: 'auto-review',
    title: 'Auto-review',
    short: 'Auto-review',
    detail: 'Codex reviews elevated actions',
    icon: ScanEye,
  },
  {
    id: 'full',
    title: 'Full access',
    short: 'Full access',
    detail: 'No sandbox, prompts, or undo',
    icon: LockOpen,
  },
]
