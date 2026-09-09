import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import {
  IconCheck as Check,
  IconCopy as Copy,
  IconDownload as Download,
  IconExternalLink as ExternalLink,
  IconLoader2 as LoaderCircle,
  IconMaximize as Maximize2,
  IconRotate as RotateCcw,
  IconX as X,
  IconZoomIn as ZoomIn,
  IconZoomOut as ZoomOut,
  type TablerIcon,
} from '@tabler/icons-react'
import type { IconMap } from 'streamdown'
import { IconMorph } from './IconMorph.js'

type StreamdownIconProps = ComponentProps<IconMap['CheckIcon']>

function streamdownIcon(Icon: TablerIcon): IconMap['CheckIcon'] {
  return function StreamdownTablerIcon({ stroke, ...props }: StreamdownIconProps) {
    return <Icon {...props} color={stroke ?? 'currentColor'} />
  }
}

type StreamdownCopyState = 'copy' | 'check'

const streamdownCopyStates = new WeakMap<HTMLButtonElement, StreamdownCopyState>()

function streamdownCopyIcon(state: StreamdownCopyState): IconMap['CheckIcon'] {
  return function StreamdownCopyMorphIcon({ stroke, ...props }: StreamdownIconProps) {
    const host = useRef<HTMLSpanElement>(null)
    const [previousState, setPreviousState] = useState<StreamdownCopyState>()

    useLayoutEffect(() => {
      const button = host.current?.closest('button')
      if (!(button instanceof HTMLButtonElement)) return

      const previous = streamdownCopyStates.get(button)
      streamdownCopyStates.set(button, state)
      if (previous && previous !== state) setPreviousState(previous)
    }, [])

    return (
      <span className="streamdown-copy-morph" ref={host}>
        <IconMorph
          active={state === 'check' ? 1 : 0}
          from={previousState === undefined ? undefined : previousState === 'check' ? 1 : 0}
        >
          <Copy {...props} color={stroke ?? 'currentColor'} />
          <Check {...props} color={stroke ?? 'currentColor'} />
        </IconMorph>
      </span>
    )
  }
}

export const STREAMDOWN_ICONS = {
  CheckIcon: streamdownCopyIcon('check'),
  CopyIcon: streamdownCopyIcon('copy'),
  DownloadIcon: streamdownIcon(Download),
  ExternalLinkIcon: streamdownIcon(ExternalLink),
  Loader2Icon: streamdownIcon(LoaderCircle),
  Maximize2Icon: streamdownIcon(Maximize2),
  RotateCcwIcon: streamdownIcon(RotateCcw),
  XIcon: streamdownIcon(X),
  ZoomInIcon: streamdownIcon(ZoomIn),
  ZoomOutIcon: streamdownIcon(ZoomOut),
} satisfies IconMap
