import {
  Atom,
  Bird,
  Braces,
  CodeXml,
  Coffee,
  Cog,
  Container,
  Database,
  FileCode2,
  FileText,
  Gem,
  Hash,
  Image as ImageIcon,
  Settings2,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'

type IconSpec = {
  kind: string
  Icon?: LucideIcon
  label?: string
}

const ICONS = {
  react: { kind: 'react', Icon: Atom },
  typescript: { kind: 'typescript', label: 'TS' },
  javascript: { kind: 'javascript', label: 'JS' },
  style: { kind: 'style', Icon: Hash },
  markup: { kind: 'markup', Icon: CodeXml },
  data: { kind: 'data', Icon: Braces },
  markdown: { kind: 'markdown', Icon: FileText },
  text: { kind: 'text', Icon: FileText },
  database: { kind: 'database', Icon: Database },
  shell: { kind: 'shell', Icon: SquareTerminal },
  python: { kind: 'python', label: 'PY' },
  rust: { kind: 'rust', Icon: Cog },
  ruby: { kind: 'ruby', Icon: Gem },
  java: { kind: 'java', Icon: Coffee },
  kotlin: { kind: 'kotlin', label: 'K' },
  go: { kind: 'go', label: 'GO' },
  swift: { kind: 'swift', Icon: Bird },
  php: { kind: 'php', label: 'PHP' },
  c: { kind: 'c', label: 'C' },
  cpp: { kind: 'cpp', label: 'C++' },
  csharp: { kind: 'csharp', label: 'C#' },
  vue: { kind: 'vue', label: 'V' },
  svelte: { kind: 'svelte', label: 'S' },
  image: { kind: 'image', Icon: ImageIcon },
  config: { kind: 'config', Icon: Settings2 },
  docker: { kind: 'docker', Icon: Container },
  code: { kind: 'code', Icon: FileCode2 },
} satisfies Record<string, IconSpec>

type IconKind = keyof typeof ICONS

const KIND_BY_EXTENSION: Record<string, IconKind> = {
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
}

const KIND_BY_FILENAME: Record<string, IconKind> = {
  dockerfile: 'docker',
  makefile: 'shell',
  procfile: 'shell',
  '.gitignore': 'config',
  '.gitattributes': 'config',
  license: 'text',
  readme: 'markdown',
}

export function isFileReference(path: string): boolean {
  return iconKind(path) !== undefined
}

export function FileTypeIcon({ path }: { path: string }) {
  const spec: IconSpec = ICONS[iconKind(path) ?? 'code']
  const Icon = spec.Icon

  return (
    <span className="md-file-ref__icon" data-file-icon={spec.kind} aria-hidden>
      {Icon ? <Icon /> : <span className="md-file-ref__monogram">{spec.label}</span>}
    </span>
  )
}

function iconKind(path: string): IconKind | undefined {
  const withoutPosition = path.replace(/:\d+(?::\d+)?$/, '')
  const filename = withoutPosition.split(/[\\/]/).at(-1)?.toLowerCase()
  if (!filename) return undefined

  const namedKind = KIND_BY_FILENAME[filename]
  if (namedKind) return namedKind

  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
  return KIND_BY_EXTENSION[extension]
}
