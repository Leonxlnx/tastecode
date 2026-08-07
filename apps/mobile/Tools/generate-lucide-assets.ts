import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type IconNode = [tag: string, attributes: Record<string, string>]

const icons = [
  ['archive', 'archive'],
  ['arrowDown', 'arrow-down'],
  ['arrowLeft', 'arrow-left'],
  ['arrowRight', 'arrow-right'],
  ['arrowUp', 'arrow-up'],
  ['bookOpen', 'book-open'],
  ['brain', 'brain'],
  ['check', 'check'],
  ['checkCheck', 'check-check'],
  ['circleCheck', 'circle-check-big'],
  ['chevronDown', 'chevron-down'],
  ['chevronRight', 'chevron-right'],
  ['chevronUp', 'chevron-up'],
  ['circle', 'circle'],
  ['circleAlert', 'circle-alert'],
  ['circleQuestion', 'circle-question-mark'],
  ['circleX', 'circle-x'],
  ['clipboardPaste', 'clipboard-paste'],
  ['clock', 'clock-3'],
  ['copy', 'copy'],
  ['cornerDownLeft', 'corner-down-left'],
  ['cornerDownRight', 'corner-down-right'],
  ['database', 'database'],
  ['ellipsis', 'ellipsis'],
  ['file', 'file'],
  ['fileArchive', 'file-archive'],
  ['fileDiff', 'file-diff'],
  ['filePen', 'file-pen-line'],
  ['fileText', 'file-text'],
  ['folder', 'folder'],
  ['folderPen', 'folder-pen'],
  ['folderSearch', 'folder-search'],
  ['gitBranch', 'git-branch'],
  ['gitFork', 'git-fork'],
  ['hardDrive', 'hard-drive'],
  ['history', 'history'],
  ['house', 'house'],
  ['image', 'image'],
  ['images', 'images'],
  ['info', 'info'],
  ['keyboard', 'keyboard'],
  ['keyRound', 'key-round'],
  ['laptop', 'laptop'],
  ['laptopMinimal', 'laptop-minimal'],
  ['link', 'link'],
  ['listChecks', 'list-checks'],
  ['loader', 'loader-circle'],
  ['lockKeyhole', 'lock-keyhole'],
  ['messagesSquare', 'messages-square'],
  ['monitor', 'monitor'],
  ['monitorSmartphone', 'monitor-smartphone'],
  ['monitorX', 'monitor-x'],
  ['network', 'network'],
  ['palette', 'palette'],
  ['plus', 'plus'],
  ['qrCode', 'qr-code'],
  ['refreshCw', 'refresh-cw'],
  ['rotateCcw', 'rotate-ccw'],
  ['search', 'search'],
  ['server', 'server'],
  ['settings', 'settings-2'],
  ['shieldAlert', 'shield-alert'],
  ['shieldCheck', 'shield-check'],
  ['slidersHorizontal', 'sliders-horizontal'],
  ['square', 'square'],
  ['squarePen', 'square-pen'],
  ['squareTerminal', 'square-terminal'],
  ['trash', 'trash-2'],
  ['triangleAlert', 'triangle-alert'],
  ['undo', 'undo-2'],
  ['userCog', 'user-cog'],
  ['vibrate', 'vibrate'],
  ['wifi', 'wifi'],
  ['wifiOff', 'wifi-off'],
  ['wrench', 'wrench'],
  ['x', 'x'],
  ['zap', 'zap'],
] as const

const toolsDirectory = import.meta.dirname
const mobileDirectory = path.resolve(toolsDirectory, '..')
const webDirectory = path.resolve(toolsDirectory, '..', '..', 'web')
const lucideDirectory = path.join(webDirectory, 'node_modules', 'lucide-react')
const iconSourceDirectory = path.join(lucideDirectory, 'dist', 'esm', 'icons')
const assetCatalogDirectory = path.join(mobileDirectory, 'Resources', 'Assets.xcassets')
const generatedSwiftPath = path.join(
  mobileDirectory,
  'Sources',
  'HarnessMobile',
  'UI',
  'LucideIcons.generated.swift',
)

const packageJSON = JSON.parse(
  await readFile(path.join(lucideDirectory, 'package.json'), 'utf8'),
) as { version: string }

for (const [swiftName, slug] of icons) {
  const nodes = await readIconNodes(slug)
  const assetName = `Lucide${upperFirst(swiftName)}`
  await writeImageSet(assetName, `${slug}.svg`, lucideSVG(nodes, packageJSON.version))
}

async function readIconNodes(slug: string): Promise<IconNode[]> {
  const modulePath = path.join(iconSourceDirectory, `${slug}.mjs`)
  const module = (await import(pathToFileURL(modulePath).href)) as { __iconNode?: IconNode[] }
  if (module.__iconNode) return module.__iconNode

  const source = await readFile(modulePath, 'utf8')
  const alias = source.match(/export \{ default \} from '\.\/(.+)\.mjs'/)?.[1]
  if (alias) return readIconNodes(alias)
  throw new Error(`Could not read Lucide icon nodes for ${slug}`)
}

await writeImageSet(
  'LucideSquareFilled',
  'square-filled.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" fill="#000"/></svg>\n',
)

const providerSource = await readFile(
  path.join(webDirectory, 'src', 'ui', 'ProviderIcon.tsx'),
  'utf8',
)
for (const mark of [
  'anthropic',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'gemini',
  'qwen',
] as const) {
  const expression = new RegExp(`${mark}:\\s*(?:\\n\\s*)?'([^']+)'`)
  const providerMatch = providerSource.match(expression)
  if (!providerMatch?.[1]) throw new Error(`Could not read desktop provider mark for ${mark}`)
  await writeImageSet(`Provider${upperFirst(mark)}`, `${mark}.svg`, filledPathSVG(providerMatch[1]))
}

await writeImageSet(
  'ProviderAcp',
  'acp.svg',
  strokedPathSVG('M7 6.5h10M7 17.5h10M6 9.5v5M18 9.5v5M9.5 12h5'),
)
await writeImageSet(
  'ProviderCustom',
  'custom.svg',
  strokedPathSVG(
    'M8.5 7.5h-2A2.5 2.5 0 0 0 4 10v4a2.5 2.5 0 0 0 2.5 2.5h2m7-9h2A2.5 2.5 0 0 1 20 10v4a2.5 2.5 0 0 1-2.5 2.5h-2M9 12h6',
  ),
)
await writeImageSet(
  'ProviderKimi',
  'kimi.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 25">
  <path d="m9.39 13.95 8.43-8.36c.16-.16.07-.47-.14-.47h-4.54l-.14.06-9.08 9.01c-.14.14-.35.02-.35-.21V5.39c0-.15-.1-.27-.22-.27H.22c-.12 0-.22.12-.22.27v18.53c0 .15.1.27.22.27h3.13c.12 0 .22-.12.22-.27v-3.78c0-.08.03-.16.08-.21l2.82-2.79c.07-.07.16-.08.24-.03l7.53 5.54c1.23.83 2.61 1.34 4.01 1.49.12.01.23-.11.23-.27v-3.56c0-.14-.08-.25-.19-.26-.82-.13-1.63-.45-2.35-.94L9.42 14.39c-.14-.09-.15-.32-.03-.44Z" fill="#000"/>
</svg>
`,
)
await writeImageSet(
  'ProviderKimiAccent',
  'kimi-accent.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 25"><path d="M21.72.94a2.23 2.23 0 0 1 0 4.46h-1.97a.26.26 0 0 1-.26-.26V3.17A2.23 2.23 0 0 1 21.72.94Z" fill="#1783ff"/></svg>
`,
  false,
)

await writeFile(
  path.join(mobileDirectory, 'Resources', 'Lucide-ISC-LICENSE.txt'),
  await readFile(path.join(lucideDirectory, 'LICENSE'), 'utf8'),
)
await writeFile(generatedSwiftPath, generatedSwift(packageJSON.version))

async function writeImageSet(
  assetName: string,
  filename: string,
  svg: string,
  template = true,
): Promise<void> {
  const directory = path.join(assetCatalogDirectory, `${assetName}.imageset`)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, filename), svg)
  await writeFile(
    path.join(directory, 'Contents.json'),
    `${JSON.stringify(
      {
        images: [{ filename, idiom: 'universal' }],
        info: { author: 'xcode', version: 1 },
        properties: template
          ? {
              'preserves-vector-representation': true,
              'template-rendering-intent': 'template',
            }
          : { 'preserves-vector-representation': true },
      },
      null,
      2,
    )}\n`,
  )
}

function lucideSVG(nodes: IconNode[], version: string): string {
  const body = nodes
    .map(([tag, attributes]) => {
      const serialized = Object.entries(attributes)
        .filter(([name]) => name !== 'key')
        .map(([name, value]) => `${attributeName(name)}="${escapeXML(value)}"`)
        .join(' ')
      return `  <${tag} ${serialized}/>`
    })
    .join('\n')
  return `<!-- Generated from lucide-react ${version}, ISC. -->\n<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>\n`
}

function filledPathSVG(data: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${escapeXML(data)}" fill="#000"/></svg>\n`
}

function strokedPathSVG(data: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"><path d="${escapeXML(data)}"/></svg>\n`
}

function attributeName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function escapeXML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function generatedSwift(version: string): string {
  const cases = icons
    .map(([swiftName]) => `  case ${swiftName} = "Lucide${upperFirst(swiftName)}"`)
    .concat('  case squareFilled = "LucideSquareFilled"')
    .join('\n')
  return `// Generated by Tools/generate-lucide-assets.ts from lucide-react ${version} (ISC).\n// Do not edit this file directly.\n\nimport SwiftUI\n\nenum LucideIcon: String, CaseIterable, Sendable {\n${cases}\n\n  var assetName: String { rawValue }\n}\n\nstruct LucideIconView: View {\n  let icon: LucideIcon\n  var size: CGFloat\n\n  init(_ icon: LucideIcon, size: CGFloat = 16) {\n    self.icon = icon\n    self.size = size\n  }\n\n  var body: some View {\n    Image(icon.assetName)\n      .resizable()\n      .renderingMode(.template)\n      .scaledToFit()\n      .frame(\n        width: HarnessIconMetrics.renderedSize(size),\n        height: HarnessIconMetrics.renderedSize(size)\n      )\n      .frame(width: size, height: size)\n      .accessibilityHidden(true)\n  }\n}\n`
}
