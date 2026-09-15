export type HexColor = `#${string}`
export type HsvColor = { h: number; s: number; v: number }

export function normalizeHexColor(value: string): HexColor | undefined {
  const hex = value.trim().replace(/^#/, '')
  if (/^[\da-f]{3}$/i.test(hex)) {
    return `#${[...hex]
      .map((digit) => digit.repeat(2))
      .join('')
      .toUpperCase()}`
  }
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : undefined
}

function rgbChannels(color: HexColor): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16) / 255,
    Number.parseInt(color.slice(3, 5), 16) / 255,
    Number.parseInt(color.slice(5, 7), 16) / 255,
  ]
}

export function colorForeground(color: HexColor): '#ffffff' | '#171717' {
  const [r, g, b] = rgbChannels(color).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.179 ? '#171717' : '#ffffff'
}

export function hexToHsv(color: HexColor): HsvColor {
  const [r, g, b] = rgbChannels(color)
  const v = Math.max(r, g, b)
  const delta = v - Math.min(r, g, b)
  const hue =
    delta === 0
      ? 0
      : v === r
        ? (g - b) / delta
        : v === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4
  return { h: (hue * 60 + 360) % 360, s: v === 0 ? 0 : delta / v, v }
}

export function hsvToHex({ h, s, v }: HsvColor): HexColor {
  const channel = (offset: number) => {
    const k = (offset + h / 60) % 6
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase() as HexColor
}

const ACCENT_COLORS = {
  neutral: ['#4C9DFF', '#2563EB'],
  ocean: ['#65B8FF', '#1677BE'],
  forest: ['#71C695', '#247B4F'],
  sunset: ['#C69CFF', '#7E4BC2'],
  amber: ['#E0AD61', '#936017'],
  rose: ['#E593AD', '#A34264'],
  lavender: ['#AE9EEA', '#6653AA'],
} as const

const BACKDROP_COLORS = {
  default: ['#0F0F0F', '#FDFDFD'],
  slate: ['#0E1013', '#F7F9FC'],
  mocha: ['#121010', '#FCFAF8'],
  forest: ['#0E120F', '#F8FBF8'],
  midnight: ['#0B0D14', '#F5F7FC'],
  plum: ['#120F13', '#FBF8FC'],
} as const

export type AccentPreset = keyof typeof ACCENT_COLORS
export type BackdropPreset = keyof typeof BACKDROP_COLORS

export function accentColor(value: AccentPreset | HexColor, light: boolean): HexColor {
  return normalizeHexColor(value) ?? ACCENT_COLORS[value as AccentPreset][light ? 1 : 0]
}

export function backdropColor(value: BackdropPreset | HexColor, light: boolean): HexColor {
  return normalizeHexColor(value) ?? BACKDROP_COLORS[value as BackdropPreset][light ? 1 : 0]
}

export function backdropColorScheme(
  value: BackdropPreset | HexColor,
): 'light' | 'dark' | undefined {
  const color = normalizeHexColor(value)
  return color ? (colorForeground(color) === '#171717' ? 'light' : 'dark') : undefined
}
