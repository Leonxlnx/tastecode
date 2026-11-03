import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BUNDLED = [
  ['cinetic', 'cinematic videos and motion design made in code'],
  ['design-taste-frontend', 'art direction for websites and app screens (tasteskill)'],
  ['cook', 'long reference-matching loops for ambitious visual builds'],
] as const

/**
 * Writes a bundle like packages/default-skills/scripts/sync.js lays out under
 * `parent`, with only the `present` skill folders on disk, and returns its root.
 */
export async function writeDefaultSkillsFixture(
  parent: string,
  present: readonly string[] = BUNDLED.map(([folder]) => folder),
): Promise<string> {
  const root = path.join(parent, 'bundle')
  await mkdir(path.join(root, 'skills'), { recursive: true })
  await writeFile(
    path.join(root, 'skills.json'),
    JSON.stringify({
      plugin: { name: 'tastecode' },
      skills: BUNDLED.map(([folder, summary]) => ({ folder, summary })),
    }),
  )
  for (const folder of present) {
    await mkdir(path.join(root, 'skills', folder), { recursive: true })
    await writeFile(
      path.join(root, 'skills', folder, 'SKILL.md'),
      `---\nname: ${folder}\ndescription: The long ${folder} description.\n---\n# ${folder}\n`,
    )
  }
  return root
}
