import { useEffect, useState } from 'react'
import type { DiffFile, SessionDiff } from '@harness/contracts'
import {
  Button,
  ContentUnavailableView,
  DisclosureGroup,
  HStack,
  List,
  NavigationStack,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
} from '@expo/ui/swift-ui'
import {
  background,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  navigationBarTitleDisplayMode,
  navigationTitle,
  padding,
  presentationDetents,
} from '@expo/ui/swift-ui/modifiers'
import { connection } from '../state/app'
import { message } from '../state/thread-session'

const MAX_LINES = 400

/** What the chat changed in its checkout, file by file, as the desktop's review shows it. */
export function ChangesSheet(props: {
  threadId: string
  projectPath: string
  onClose: () => void
}) {
  const [diff, setDiff] = useState<SessionDiff>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    connection
      .request('workspace.diff', { projectPath: props.projectPath, threadId: props.threadId })
      .then((result) => !cancelled && setDiff(result))
      .catch((cause: unknown) => !cancelled && setError(message(cause)))
    return () => {
      cancelled = true
    }
  }, [props.threadId, props.projectPath])

  return (
    <NavigationStack modifiers={[presentationDetents(['large'])]}>
      <Toolbar>
        <List modifiers={[navigationTitle('Changes'), navigationBarTitleDisplayMode('inline')]}>
          {error ? (
            <ContentUnavailableView
              title="No Changes Shown"
              systemImage="exclamationmark.triangle"
              description={error}
            />
          ) : null}
          {!diff && !error ? (
            <HStack spacing={10}>
              <ProgressView />
              <Text modifiers={[foregroundStyle('secondary')]}>Reading the changes…</Text>
            </HStack>
          ) : null}
          {diff && diff.files.length === 0 ? (
            <ContentUnavailableView
              title="No Changes"
              systemImage="checkmark.circle"
              description="The checkout this chat works in has no uncommitted changes."
            />
          ) : null}
          {diff?.files.map((file) => (
            <FileChanges key={file.path} file={file} />
          ))}
        </List>
        <Toolbar.Content>
          <ToolbarItem placement="confirmationAction">
            <Button role="close" onPress={props.onClose} />
          </ToolbarItem>
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
  )
}

function FileChanges(props: { file: DiffFile }) {
  const { file } = props
  let added = 0
  let removed = 0
  const lines: Array<{
    key: string
    kind: 'context' | 'addition' | 'deletion' | 'header'
    text: string
  }> = []
  for (const hunk of file.hunks) {
    lines.push({
      key: hunk.id,
      kind: 'header',
      text: hunk.header || `@@ ${hunk.oldStart},${hunk.newStart} @@`,
    })
    hunk.lines.forEach((line, index) => {
      if (line.kind === 'addition') added += 1
      if (line.kind === 'deletion') removed += 1
      lines.push({ key: `${hunk.id}:${index}`, kind: line.kind, text: line.text })
    })
  }
  const shown = lines.slice(0, MAX_LINES)
  const name = file.path.split(/[\\/]/).at(-1) ?? file.path
  return (
    <DisclosureGroup>
      <DisclosureGroup.Label>
        <HStack spacing={8}>
          <VStack alignment="leading" spacing={2}>
            <Text modifiers={[font({ textStyle: 'subheadline', weight: 'medium' }), lineLimit(1)]}>
              {name}
            </Text>
            {name !== file.path ? (
              <Text
                modifiers={[
                  font({ textStyle: 'caption' }),
                  foregroundStyle('secondary'),
                  lineLimit(1),
                ]}
              >
                {file.path}
              </Text>
            ) : null}
          </VStack>
          <Spacer />
          <Text
            modifiers={[
              font({ textStyle: 'caption', design: 'monospaced' }),
              foregroundStyle('green'),
            ]}
          >{`+${added}`}</Text>
          <Text
            modifiers={[
              font({ textStyle: 'caption', design: 'monospaced' }),
              foregroundStyle('red'),
            ]}
          >{`−${removed}`}</Text>
        </HStack>
      </DisclosureGroup.Label>
      {file.binary ? (
        <Text modifiers={[foregroundStyle('secondary')]}>Binary file</Text>
      ) : (
        <ScrollView axes="horizontal" showsIndicators={false}>
          <VStack alignment="leading" spacing={0}>
            {shown.map((line) => (
              <Text
                key={line.key}
                modifiers={[
                  font({ size: 12, design: 'monospaced' }),
                  foregroundStyle(line.kind === 'header' ? 'secondary' : 'primary'),
                  padding({ horizontal: 6, vertical: 1 }),
                  frame({ minWidth: 320, alignment: 'leading' }),
                  ...(line.kind === 'addition'
                    ? [background('#2EA04326')]
                    : line.kind === 'deletion'
                      ? [background('#F8514926')]
                      : []),
                ]}
              >
                {`${line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '} ${line.text}`}
              </Text>
            ))}
            {lines.length > shown.length ? (
              <Text
                modifiers={[
                  font({ textStyle: 'caption' }),
                  foregroundStyle('secondary'),
                  padding({ top: 6 }),
                ]}
              >
                {`${lines.length - shown.length} more lines on the computer`}
              </Text>
            ) : null}
          </VStack>
        </ScrollView>
      )}
    </DisclosureGroup>
  )
}
