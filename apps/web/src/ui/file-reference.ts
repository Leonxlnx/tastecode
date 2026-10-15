/** What kind of file a path names, without the icon set that draws it. */
export type FileReferenceKind =
  | 'react'
  | 'typescript'
  | 'javascript'
  | 'style'
  | 'markup'
  | 'data'
  | 'markdown'
  | 'text'
  | 'database'
  | 'shell'
  | 'python'
  | 'rust'
  | 'ruby'
  | 'java'
  | 'kotlin'
  | 'go'
  | 'swift'
  | 'php'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'vue'
  | 'svelte'
  | 'image'
  | 'config'
  | 'docker'
  | 'code'

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
} satisfies Record<string, FileReferenceKind>

const KIND_BY_FILENAME = {
  dockerfile: 'docker',
  makefile: 'shell',
  procfile: 'shell',
  '.gitignore': 'config',
  '.gitattributes': 'config',
  license: 'text',
  readme: 'markdown',
} satisfies Record<string, FileReferenceKind>

export function isFileReference(path: string): boolean {
  return fileReferenceKind(path) !== undefined
}

// A command (`cat package.json`) or member access (`process.env`) is code, not a file.
// A dotenv file is `.env` itself or sits in a folder.
export function isInlineFileReference(text: string): boolean {
  return !/\s/.test(text) && !/^[^/\\]+\.env$/i.test(text) && isFileReference(text)
}

export function fileReferenceKind(path: string): FileReferenceKind | undefined {
  const withoutPosition = path.includes(':') ? path.replace(/:\d+(?::\d+)?$/, '') : path
  const separator = Math.max(withoutPosition.lastIndexOf('/'), withoutPosition.lastIndexOf('\\'))
  const filename = withoutPosition.slice(separator + 1).toLowerCase()
  if (!filename) return undefined

  if (Object.hasOwn(KIND_BY_FILENAME, filename)) {
    return KIND_BY_FILENAME[filename as keyof typeof KIND_BY_FILENAME]
  }

  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
  return Object.hasOwn(KIND_BY_EXTENSION, extension)
    ? KIND_BY_EXTENSION[extension as keyof typeof KIND_BY_EXTENSION]
    : undefined
}
