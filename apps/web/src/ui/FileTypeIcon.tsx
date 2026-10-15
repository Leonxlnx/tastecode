import {
  IconBrandCpp,
  IconBrandCSharp,
  IconBrandCss3,
  IconBrandDocker,
  IconBrandGolang,
  IconBrandJavascript,
  IconBrandKotlin,
  IconBrandPhp,
  IconBrandPython,
  IconBrandReact,
  IconBrandRust,
  IconBrandSvelte,
  IconBrandSwift,
  IconBrandTypescript,
  IconBrandVue,
  IconBraces,
  IconCode,
  IconCoffee,
  IconDatabase,
  IconDiamond,
  IconFileCode,
  IconFileText,
  IconLetterC,
  IconMarkdown,
  IconPhoto,
  IconSettings,
  IconTerminal2,
  type TablerIcon,
} from '@tabler/icons-react'
import { fileReferenceKind, type FileReferenceKind } from './file-reference.js'

type IconSpec = {
  kind: string
  Icon: TablerIcon
}

const ICONS = {
  react: { kind: 'react', Icon: IconBrandReact },
  typescript: { kind: 'typescript', Icon: IconBrandTypescript },
  javascript: { kind: 'javascript', Icon: IconBrandJavascript },
  style: { kind: 'style', Icon: IconBrandCss3 },
  markup: { kind: 'markup', Icon: IconCode },
  data: { kind: 'data', Icon: IconBraces },
  markdown: { kind: 'markdown', Icon: IconMarkdown },
  text: { kind: 'text', Icon: IconFileText },
  database: { kind: 'database', Icon: IconDatabase },
  shell: { kind: 'shell', Icon: IconTerminal2 },
  python: { kind: 'python', Icon: IconBrandPython },
  rust: { kind: 'rust', Icon: IconBrandRust },
  ruby: { kind: 'ruby', Icon: IconDiamond },
  java: { kind: 'java', Icon: IconCoffee },
  kotlin: { kind: 'kotlin', Icon: IconBrandKotlin },
  go: { kind: 'go', Icon: IconBrandGolang },
  swift: { kind: 'swift', Icon: IconBrandSwift },
  php: { kind: 'php', Icon: IconBrandPhp },
  c: { kind: 'c', Icon: IconLetterC },
  cpp: { kind: 'cpp', Icon: IconBrandCpp },
  csharp: { kind: 'csharp', Icon: IconBrandCSharp },
  vue: { kind: 'vue', Icon: IconBrandVue },
  svelte: { kind: 'svelte', Icon: IconBrandSvelte },
  image: { kind: 'image', Icon: IconPhoto },
  config: { kind: 'config', Icon: IconSettings },
  docker: { kind: 'docker', Icon: IconBrandDocker },
  code: { kind: 'code', Icon: IconFileCode },
} satisfies Record<FileReferenceKind, IconSpec>

export function FileTypeIcon({ path }: { path: string }) {
  const spec: IconSpec = ICONS[fileReferenceKind(path) ?? 'code']
  const Icon = spec.Icon

  return (
    <span className="md-file-ref__icon" data-file-icon={spec.kind} aria-hidden>
      <Icon />
    </span>
  )
}
