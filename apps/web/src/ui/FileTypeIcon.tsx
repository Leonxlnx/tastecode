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
} satisfies Record<string, IconSpec>

type IconKind = keyof typeof ICONS

const KIND_BY_EXTENSION = {
  tsx: 'react',
  jsx: 'react',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  json: 'data',
  jsonc: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  csv: 'data',
  md: 'markdown',
  mdx: 'markdown',
  adoc: 'markdown',
  txt: 'text',
  sql: 'database',
  prisma: 'database',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  bat: 'shell',
  cmd: 'shell',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  swift: 'swift',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  vue: 'vue',
  svelte: 'svelte',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  bmp: 'image',
  ini: 'config',
  conf: 'config',
  env: 'config',
  graphql: 'code',
  gql: 'code',
  dart: 'code',
  ex: 'code',
  exs: 'code',
  lua: 'code',
} satisfies Record<string, IconKind>

const KIND_BY_FILENAME = {
  dockerfile: 'docker',
  makefile: 'shell',
  procfile: 'shell',
  '.gitignore': 'config',
  '.gitattributes': 'config',
  license: 'text',
  readme: 'markdown',
} satisfies Record<string, IconKind>

export function isFileReference(path: string): boolean {
  return iconKind(path) !== undefined
}

export function FileTypeIcon({ path }: { path: string }) {
  const spec: IconSpec = ICONS[iconKind(path) ?? 'code']
  const Icon = spec.Icon

  return (
    <span className="md-file-ref__icon" data-file-icon={spec.kind} aria-hidden>
      <Icon />
    </span>
  )
}

function iconKind(path: string): IconKind | undefined {
  const withoutPosition = path.includes(':') ? path.replace(/:\d+(?::\d+)?$/, '') : path
  const separator = Math.max(withoutPosition.lastIndexOf('/'), withoutPosition.lastIndexOf('\\'))
  const filename = withoutPosition.slice(separator + 1).toLowerCase()
  if (!filename) return undefined

  const namedKind: IconKind | undefined =
    KIND_BY_FILENAME[filename as keyof typeof KIND_BY_FILENAME]
  if (namedKind) return namedKind

  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
  return KIND_BY_EXTENSION[extension as keyof typeof KIND_BY_EXTENSION]
}
