import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')

it('keeps the activity heatmap month labels at 10px or more on a narrow page', () => {
  expect(css).toMatch(
    /\.profile-activity__months \{[^}]*font-size: clamp\(10px, 1\.35cqi, var\(--t-xs\)\);/s,
  )
})
