// @vitest-environment happy-dom
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { afterAll, bench, describe } from 'vitest'
import { TestTransport } from '../test-transport.js'
import { SessionSearchHost, type SessionSearchHandle } from './SessionSearchHost.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined
const transport = new TestTransport()
const projects = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  name: `Project ${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => ({
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: `Thread ${projectIndex}-${sessionIndex}`,
    provider: 'codex' as const,
    createdAt: sessionIndex,
  })),
}))
const statusUpdatedProjects = projects.map((project, index) =>
  index === 50 ? { ...project, sessions: [...project.sessions] } : project,
)
const changedRef = createRef<SessionSearchHandle>()
const stableRef = createRef<SessionSearchHandle>()
let frame = 0

const changed = render(
  <SessionSearchHost ref={changedRef} transport={transport} projects={projects} onSelect={noop} />,
)
const stable = render(
  <SessionSearchHost ref={stableRef} transport={transport} projects={projects} onSelect={noop} />,
)

afterAll(() => {
  changed.unmount()
  stable.unmount()
})

describe('closed session search host project updates', () => {
  bench(
    'rerenders when the 10,000-chat project tree changes',
    () => {
      frame = frame === 0 ? 1 : 0
      changed.rerender(
        <SessionSearchHost
          ref={changedRef}
          transport={transport}
          projects={frame === 0 ? projects : statusUpdatedProjects}
          onSelect={noop}
        />,
      )
    },
    OPTIONS,
  )

  bench(
    'skips the closed host when its project tree stays stable',
    () =>
      stable.rerender(
        <SessionSearchHost
          ref={stableRef}
          transport={transport}
          projects={projects}
          onSelect={noop}
        />,
      ),
    OPTIONS,
  )
})
