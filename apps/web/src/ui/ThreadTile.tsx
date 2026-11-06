import { memo, useEffect, useRef, useState } from 'react'
import type { ThreadInboxStatus } from '@harness/contracts'
import { measurePictureInk, type PictureInk } from '../thread-image.js'

/**
 * The state a thread's tile reports with the ring around it. Each one has its
 * own shape, so the states stay apart without colour: an arc that travels the
 * ring while the agent works, a closed ring when the thread needs the user or
 * failed, a dotted ring in the queue, and no ring once the work is done.
 */
export type ThreadTileMark = 'working' | 'failed' | 'attention' | 'queued' | 'done' | 'none'

export function threadTileMark(status: ThreadInboxStatus): ThreadTileMark {
  switch (status) {
    case 'starting':
    case 'working':
      return 'working'
    case 'failed':
      return 'failed'
    case 'input':
    case 'approval':
      return 'attention'
    case 'queued':
      return 'queued'
    case 'ready':
      return 'done'
    default:
      return 'none'
  }
}

/** The first letter or digit of a project name, for a tile without a picture. */
export function tileInitial(name: string): string {
  const letter = name.match(/[\p{L}\p{N}]/u)?.[0] ?? ''
  return letter.toLocaleUpperCase()
}

/**
 * A thread's picture, or its project's initial, with the thread's state
 * drawn as a ring around it. The picture is never tinted
 * or covered: the state lives outside it.
 */
export const ThreadTile = memo(function ThreadTile(props: {
  image: string | undefined
  name: string
  mark: ThreadTileMark
}) {
  // A stored picture the renderer cannot decode falls back to the initial.
  const [broken, setBroken] = useState<string>()
  const image = props.image && props.image !== broken ? props.image : undefined
  // Only a change animates; a row that mounts with its state shows it at once.
  const shown = useRef({ mark: props.mark, image })
  const markChanged = shown.current.mark !== props.mark
  const imageChanged = shown.current.image !== image
  useEffect(() => {
    shown.current = { mark: props.mark, image }
  })
  // A light logo on a clear ground gets a dark plate in the light theme, and a
  // dark one a pale plate in the dark theme; each picture is measured once.
  const [ink, setInk] = useState<{ source: string; ink: PictureInk | undefined }>()
  useEffect(() => {
    if (!image) return
    let current = true
    void measurePictureInk(image).then((measured) => {
      if (current) setInk({ source: image, ink: measured })
    })
    return () => {
      current = false
    }
  }, [image])
  const plate = image && ink?.source === image ? ink.ink : undefined

  return (
    <span className={`thread-tile is-${props.mark}${plate ? ` has-${plate}-ink` : ''}`} aria-hidden>
      {image ? (
        <img
          key={image}
          className={`thread-tile__image${imageChanged ? ' is-entering' : ''}`}
          src={image}
          alt=""
          draggable={false}
          onError={() => setBroken(image)}
        />
      ) : (
        <span className={`thread-tile__initial${imageChanged ? ' is-entering' : ''}`}>
          {tileInitial(props.name)}
        </span>
      )}
      {props.mark === 'none' || props.mark === 'done' ? null : (
        <svg
          key={props.mark}
          className={`thread-tile__ring${markChanged ? ' is-entering' : ''}`}
          viewBox="0 0 36 36"
          aria-hidden
        >
          <rect x="1.25" y="1.25" width="33.5" height="33.5" rx="10.5" pathLength="100" />
        </svg>
      )}
    </span>
  )
})
