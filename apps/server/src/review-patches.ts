type RunGit = (cwd: string, args: string[]) => Promise<string>

const patchOptions = [
  '--binary',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  '--unified=3',
]

export function readFilePatch(
  git: RunGit,
  cwd: string,
  base: string,
  commit: string,
  file: { path: string; previousPath?: string | undefined },
): Promise<string> {
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path]
  return git(cwd, [
    'diff',
    ...patchOptions,
    base,
    commit,
    '--',
    // A pathspec also matches everything below a folder of the same name.
    ...paths.flatMap((name) => [`:(top,literal)${name}`, `:(top,literal,exclude)${name}/`]),
  ])
}

/** Only reuse a patch when its explicit header agrees with Git's NUL-delimited record. */
export async function readReviewPatches(
  git: RunGit,
  cwd: string,
  base: string,
  commit: string,
  scope: string,
): Promise<Map<string, string>> {
  // The legacy pathspecs can select different names when the environment overrides their magic.
  if (process.env.GIT_LITERAL_PATHSPECS || process.env.GIT_ICASE_PATHSPECS) return new Map()
  let output: string
  try {
    output = await git(cwd, [
      'diff',
      ...patchOptions,
      '--raw',
      '-z',
      '--patch',
      '--submodule=short',
      base,
      commit,
      '--',
      ...(scope === '.' ? [] : [`:(top,literal)${scope}`]),
    ])
  } catch {
    // In particular, the combined patch can exceed the per-command buffer or timeout.
    return new Map()
  }

  const separator = output.indexOf('\0\0')
  if (separator < 0) return new Map()
  const fields = output.slice(0, separator).split('\0')
  const patches = new Map<string, string>()
  const nextPatch = (start: number) => {
    const next = output.indexOf('\ndiff --git ', start)
    return next < 0 ? output.length : next + 1
  }
  let start = separator + 2
  for (let i = 0; i < fields.length;) {
    const record = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(fields[i++] ?? '')
    if (!record || !output.startsWith('diff --git ', start)) return new Map()
    const [, oldMode, newMode, status] = record
    if (status === 'R' || status === 'C') i++
    const name = fields[i++]
    if (!name) return new Map()
    // Hunk lines have an indicator, and binary payload lines contain no spaces.
    // Short gitlinks keep nested patches out of this stream. Read the actual
    // gitlink separately to honor the repository's submodule display settings.
    let end = nextPatch(start)
    if (status === 'T') {
      // Git can emit a deletion followed by an addition under the same header.
      const header = output.slice(start, output.indexOf('\n', start) + 1)
      if (header && output.startsWith(header, end)) end = nextPatch(end)
    }
    if (
      (status === 'M' || status === 'A' || status === 'D') &&
      !name.includes('\uFFFD') &&
      oldMode !== '160000' &&
      newMode !== '160000' &&
      output.startsWith(`diff --git a/${name} b/${name}\n`, start)
    ) {
      patches.set(name, output.slice(start, end))
    }
    start = end
  }
  // Never reuse a partial match if the two streams lost alignment.
  return start === output.length ? patches : new Map()
}
