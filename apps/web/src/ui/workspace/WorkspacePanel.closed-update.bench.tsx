// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { afterAll, bench, describe } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined
const transport = new TestTransport()
const props = {
  open: false,
  expanded: false,
  width: 520,
  transport,
  threadId: 'thread-1',
  projectPath: '/project',
  projectName: 'Project',
  branch: 'main',
  theme: 'light' as const,
  sideChatParentStatus: 'idle' as const,
  sideChatStartOptions: { approval: 'ask' as const },
  nativeSurfacesVisible: true,
  onOpen: noop,
  onClose: noop,
  onExpandedChange: noop,
  onWidthChange: noop,
}
const view = () => <WorkspacePanel {...props} />
const panel = render(view())

afterAll(() => panel.unmount())

describe('closed workspace panel parent updates', () => {
  bench('rerenders an unchanged closed workspace panel', () => panel.rerender(view()), OPTIONS)
})
