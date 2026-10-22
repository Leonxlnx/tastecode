import { useRef, useState } from 'react'
import { Alert } from 'react-native'
import type { UserInputQuestion, UserInputRequest } from '@harness/contracts'
import {
  Button,
  Form,
  HStack,
  Image,
  NavigationStack,
  SecureField,
  Section,
  Spacer,
  Text,
  TextField,
  Toolbar,
  ToolbarItem,
  VStack,
} from '@expo/ui/swift-ui'
import {
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
} from '@expo/ui/swift-ui/modifiers'
import { message } from '../state/thread-session'

/** Each question's chosen options and typed answer. */
type Answers = Record<string, string[]>

/** The agent's structured questions, answered all at once. */
export function QuestionsSheet(props: {
  request: UserInputRequest
  onSubmit: (answers: Answers) => Promise<void>
  onClose: () => void
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const typed = useRef<Record<string, string>>({})
  const [typedVersion, setTypedVersion] = useState(0)
  const [sending, setSending] = useState(false)

  const answers = () =>
    Object.fromEntries(
      props.request.questions.flatMap((question) => {
        const other = typed.current[question.id]?.trim()
        const values = [...(picked[question.id] ?? []), ...(other ? [other] : [])]
        return values.length > 0 ? [[question.id, values]] : []
      }),
    )
  const complete =
    typedVersion >= 0 &&
    props.request.questions.every((question) => (answers()[question.id] ?? []).length > 0)

  const toggle = (question: UserInputQuestion, label: string) => {
    setPicked((current) => {
      const chosen = current[question.id] ?? []
      const next = question.multiSelect
        ? chosen.includes(label)
          ? chosen.filter((entry) => entry !== label)
          : [...chosen, label]
        : [label]
      return { ...current, [question.id]: next }
    })
  }

  const submit = async () => {
    setSending(true)
    try {
      await props.onSubmit(answers())
    } catch (error) {
      setSending(false)
      Alert.alert('Could not send the answers', message(error))
    }
  }

  return (
    <NavigationStack modifiers={[presentationDetents(['medium', 'large'])]}>
      <Toolbar>
        <Form modifiers={[navigationTitle('Questions'), navigationBarTitleDisplayMode('inline')]}>
          {props.request.questions.map((question) => (
            <Section key={question.id} title={question.header}>
              <Text modifiers={[font({ textStyle: 'body' })]}>{question.question}</Text>
              {(question.options ?? []).map((option) => {
                const chosen = (picked[question.id] ?? []).includes(option.label)
                return (
                  <Button
                    key={option.label}
                    onPress={() => toggle(question, option.label)}
                    modifiers={[buttonStyle('plain')]}
                  >
                    <HStack spacing={12}>
                      <VStack alignment="leading" spacing={2}>
                        <Text modifiers={[font({ textStyle: 'body' })]}>{option.label}</Text>
                        <Text
                          modifiers={[
                            font({ textStyle: 'footnote' }),
                            foregroundStyle('secondary'),
                          ]}
                        >
                          {option.description}
                        </Text>
                      </VStack>
                      <Spacer />
                      {chosen ? (
                        <Image systemName="checkmark" modifiers={[foregroundStyle('primary')]} />
                      ) : null}
                    </HStack>
                  </Button>
                )
              })}
              {question.allowOther || !question.options?.length ? (
                question.secret ? (
                  <SecureField
                    placeholder="Your answer"
                    onTextChange={(value) => {
                      typed.current[question.id] = value
                      setTypedVersion((version) => version + 1)
                    }}
                  />
                ) : (
                  <TextField
                    placeholder={question.options?.length ? 'Something else' : 'Your answer'}
                    axis="vertical"
                    onTextChange={(value) => {
                      typed.current[question.id] = value
                      setTypedVersion((version) => version + 1)
                    }}
                  />
                )
              ) : null}
            </Section>
          ))}
        </Form>
        <Toolbar.Content>
          <ToolbarItem placement="cancellationAction">
            <Button role="close" onPress={props.onClose} />
          </ToolbarItem>
          <ToolbarItem placement="confirmationAction">
            <Button
              label="Send"
              onPress={() => void submit()}
              modifiers={[buttonStyle('glassProminent'), disabled(!complete || sending)]}
            />
          </ToolbarItem>
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
  )
}
