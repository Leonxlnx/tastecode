import type { AppBackgroundEffect } from './app-background.js'
import {
  DITHER_CELL,
  DITHER_ROWS,
  DITHER_TOP,
  EFFECT_BAND,
  HALFTONE_PITCH,
  HALFTONE_RADIUS,
} from './app-background-patterns.js'

/*
 * Window background › Effect, in motion. Dither and Halftone are drawn by a
 * fragment shader into one canvas along the top edge of the window, the band
 * the still tiles (app-background-patterns.ts) cover. A soft band of light
 * drifts sideways through it, so the dither's threshold and the halftone's
 * dot sizes shift slowly under it.
 *
 * The main thread does almost nothing per frame: one uniform and one draw
 * call, about 30 times a second, with no layout, style or DOM paint, and no
 * object made for the frame: one repeating timer drives every frame instead
 * of a new timer plus an animation frame each time. (A window left on the
 * effect overnight grew to 5 GB of garbage that only a forced GC freed;
 * per-frame scheduler records are the suspected source.) Every
 * canvas on screen (the window's and Settings' preview) shares one clock and
 * one timer, which stops while the window is hidden or out of focus and never
 * starts with reduced motion; each canvas then keeps its last frame. Where
 * WebGL is missing or software-only, no canvas is drawn and the still tile
 * shows instead.
 */

/** Frames a second while the effect moves. */
export const EFFECT_FPS = 30
const FRAME_MS = 1000 / EFFECT_FPS
/** The most one frame advances the clock, so a stalled frame does not jump. */
const MAX_STEP_MS = 100
/** Sharper than this costs pixels without showing more. */
const MAX_PIXEL_RATIO = 2
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

type Rgb = readonly [number, number, number]
/** Used when the text colour cannot be read: visible in light and dark alike. */
const FALLBACK_COLOR: Rgb = [0.5, 0.5, 0.5]

// ---------- the shared clock ----------

type MotionSink = { draw: (seconds: number) => void }

const sinks = new Set<MotionSink>()
/** Seconds the effects have moved; it only runs while they do. */
let seconds = 0
let lastFrame: number | undefined
let timer: ReturnType<typeof setInterval> | undefined
let focusCheck: ReturnType<typeof setTimeout> | undefined
let focused = true
let reducedMotion: MediaQueryList | undefined
let listening = false

/** How far the effects have moved, in seconds: where a redrawn canvas picks up. */
export function motionSeconds(): number {
  return seconds
}

function readFocus(): boolean {
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true
}

function shouldMove(): boolean {
  return (
    sinks.size > 0 &&
    focused &&
    document.visibilityState !== 'hidden' &&
    !(reducedMotion?.matches ?? false)
  )
}

function stopFrames(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  lastFrame = undefined
}

function drawSink(sink: MotionSink): void {
  sink.draw(seconds)
}

function tick(): void {
  if (!shouldMove()) {
    stopFrames()
    return
  }
  const now = performance.now()
  if (lastFrame !== undefined) seconds += Math.min(Math.max(0, now - lastFrame), MAX_STEP_MS) / 1000
  lastFrame = now
  // forEach with a named function: no iterator or closure is made per frame.
  sinks.forEach(drawSink)
}

function update(): void {
  // One repeating timer, not an animation frame per refresh: the main thread
  // wakes about 30 times a second instead of 60 to 144.
  if (!shouldMove()) stopFrames()
  else if (timer === undefined) timer = setInterval(tick, FRAME_MS)
}

function onFocus(): void {
  focused = true
  update()
}

/**
 * Focus moving into a frame inside the page (a preview) blurs the window too;
 * only a blur that leaves the whole page stops the motion.
 */
function onBlur(): void {
  if (focusCheck !== undefined) clearTimeout(focusCheck)
  focusCheck = setTimeout(() => {
    focusCheck = undefined
    focused = readFocus()
    update()
  }, 0)
}

function listen(): void {
  if (listening) return
  listening = true
  reducedMotion = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION) : undefined
  reducedMotion?.addEventListener('change', update)
  document.addEventListener('visibilitychange', update)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  focused = readFocus()
}

function unlisten(): void {
  if (!listening) return
  listening = false
  reducedMotion?.removeEventListener('change', update)
  reducedMotion = undefined
  document.removeEventListener('visibilitychange', update)
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('blur', onBlur)
  if (focusCheck !== undefined) clearTimeout(focusCheck)
  focusCheck = undefined
}

/**
 * Draws `sink` at once where the clock stands, then on every frame while the
 * effects move. Returns its removal; the clock stops with the last sink.
 */
export function addMotionSink(sink: MotionSink): () => void {
  sinks.add(sink)
  listen()
  sink.draw(seconds)
  update()
  return () => {
    if (!sinks.delete(sink)) return
    if (sinks.size > 0) return
    stopFrames()
    unlisten()
  }
}

/** Forget every sink and the clock; tests only. */
export function resetEffectMotionForTests(): void {
  sinks.clear()
  stopFrames()
  unlisten()
  seconds = 0
  focused = true
}

// ---------- the canvas size ----------

export type EffectCanvasSize = {
  /** The drawing buffer, in its own pixels. */
  width: number
  height: number
  /** The size the canvas takes on the page, in CSS pixels. */
  cssWidth: number
  cssHeight: number
  /** Buffer pixels per CSS pixel of the full-size window. */
  unit: number
}

/**
 * The buffer for a canvas `width` CSS pixels wide that stands for the window
 * at `scale` (1 for the window itself). Dither draws one buffer pixel per
 * cell and is scaled up without smoothing, so its cells stay hard-edged at a
 * fraction of the pixels; Halftone draws at the screen's own pixels.
 */
export function effectCanvasSize(
  effect: AppBackgroundEffect,
  width: number,
  scale: number,
  pixelRatio: number,
): EffectCanvasSize {
  if (effect === 'dither') {
    const cell = DITHER_CELL * scale
    const columns = Math.max(1, Math.ceil(width / cell))
    return {
      width: columns,
      height: DITHER_ROWS,
      cssWidth: columns * cell,
      cssHeight: DITHER_ROWS * cell,
      unit: 1 / DITHER_CELL,
    }
  }
  const ratio = Math.min(MAX_PIXEL_RATIO, Math.max(1, pixelRatio))
  const bufferWidth = Math.max(1, Math.ceil(width * ratio))
  const bufferHeight = Math.max(1, Math.ceil(EFFECT_BAND * scale * ratio))
  return {
    width: bufferWidth,
    height: bufferHeight,
    cssWidth: bufferWidth / ratio,
    cssHeight: bufferHeight / ratio,
    unit: scale * ratio,
  }
}

// ---------- the shaders ----------

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const FRAGMENT_PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_size;
uniform float u_unit;
uniform float u_time;
uniform vec3 u_color;

// A soft band of light, 0 to 1, that drifts sideways at about 25 CSS pixels a
// second and sways slowly; p is a point of the window in CSS pixels.
float light(vec2 p) {
  float sway = 1.7 * sin(p.x * 0.0021 - u_time * 0.07);
  return 0.5 + 0.5 * sin(p.x * 0.0047 + p.y * 0.004 - u_time * 0.12 + sway);
}
`

/** Ordered dither of the fade from the top edge, as the still tile, under the light. */
const DITHER_SHADER = `${FRAGMENT_PRELUDE}
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}

// The 8x8 Bayer threshold, 0 to 63/64, built from three 2x2 steps.
float bayer8(vec2 a) {
  return bayer2(a) + 0.25 * bayer2(a * 0.5) + 0.0625 * bayer2(a * 0.25);
}

void main() {
  vec2 cell = floor(vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y));
  float fade = pow(max(0.0, 1.0 - cell.y / ${glslFloat(DITHER_ROWS)}), 2.0);
  float level = ${glslFloat(DITHER_TOP)} * fade * (0.7 + 0.6 * light((cell + 0.5) * ${glslFloat(DITHER_CELL)}));
  float lit = step(bayer8(mod(cell, 8.0)) + 0.5 / 64.0, level);
  gl_FragColor = vec4(u_color, 1.0) * lit;
}
`

/** The staggered dot grid of the still tile, each dot swelling as the light passes. */
const HALFTONE_SHADER = `${FRAGMENT_PRELUDE}
float disc(vec2 p, vec2 centre) {
  float fade = pow(max(0.0, 1.0 - centre.y / ${glslFloat(EFFECT_BAND)}), 1.5);
  float radius = ${glslFloat(HALFTONE_RADIUS)} * fade * (0.75 + 0.45 * light(centre));
  radius = min(radius, ${glslFloat(HALFTONE_PITCH / 2 - 0.1)});
  if (radius < 0.3) return 0.0;
  return clamp((radius - distance(p, centre)) * u_unit + 0.5, 0.0, 1.0);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y) / u_unit;
  // Two columns every two pitches, the second half a pitch lower.
  vec2 lattice = vec2(${glslFloat(HALFTONE_PITCH * 2)}, ${glslFloat(HALFTONE_PITCH)});
  vec2 first = vec2(${glslFloat(HALFTONE_PITCH / 2)}, ${glslFloat(HALFTONE_PITCH / 2)});
  vec2 second = vec2(${glslFloat(HALFTONE_PITCH * 1.5)}, ${glslFloat(HALFTONE_PITCH)});
  vec2 a = first + lattice * floor((p - first) / lattice + 0.5);
  vec2 b = second + lattice * floor((p - second) / lattice + 0.5);
  gl_FragColor = vec4(u_color, 1.0) * max(disc(p, a), disc(p, b));
}
`

export const EFFECT_SHADERS = {
  dither: DITHER_SHADER,
  halftone: HALFTONE_SHADER,
} as const satisfies Record<AppBackgroundEffect, string>

// ---------- the renderer ----------

/**
 * No antialiasing, depth or stencil, and nothing kept between frames. A
 * software-only context is refused: it would draw on the CPU, and the still
 * tile costs nothing.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'low-power',
  failIfMajorPerformanceCaveat: true,
}

type EffectRenderer = {
  resize: (size: EffectCanvasSize) => void
  draw: (seconds: number, color: Rgb) => void
  dispose: () => void
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | undefined {
  const shader = gl.createShader(type)
  if (!shader) return undefined
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return undefined
}

function openContext(canvas: HTMLCanvasElement): WebGLRenderingContext | undefined {
  try {
    const gl = canvas.getContext('webgl', CONTEXT_ATTRIBUTES)
    return gl && !gl.isContextLost() ? gl : undefined
  } catch {
    return undefined
  }
}

function createEffectRenderer(
  canvas: HTMLCanvasElement,
  effect: AppBackgroundEffect,
): EffectRenderer | undefined {
  const gl = openContext(canvas)
  if (!gl) return undefined
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, EFFECT_SHADERS[effect])
  const program = vertex && fragment ? gl.createProgram() : null
  const buffer = program ? gl.createBuffer() : null
  const release = () => {
    if (buffer) gl.deleteBuffer(buffer)
    if (program) gl.deleteProgram(program)
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
  }
  if (!vertex || !fragment || !program || !buffer) {
    release()
    return undefined
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    release()
    return undefined
  }
  gl.useProgram(program)
  // One triangle that covers the whole buffer.
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const sizeUniform = gl.getUniformLocation(program, 'u_size')
  const unitUniform = gl.getUniformLocation(program, 'u_unit')
  const timeUniform = gl.getUniformLocation(program, 'u_time')
  const colorUniform = gl.getUniformLocation(program, 'u_color')
  gl.clearColor(0, 0, 0, 0)

  return {
    resize(size) {
      canvas.width = size.width
      canvas.height = size.height
      canvas.style.width = `${size.cssWidth}px`
      canvas.style.height = `${size.cssHeight}px`
      gl.viewport(0, 0, size.width, size.height)
      gl.uniform2f(sizeUniform, size.width, size.height)
      gl.uniform1f(unitUniform, size.unit)
    },
    draw(time, color) {
      gl.uniform1f(timeUniform, time)
      gl.uniform3f(colorUniform, color[0], color[1], color[2])
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      release()
      // Give the context back once the canvas has left the page, rather than
      // whenever it is collected. StrictMode's replay and a switch between
      // effects keep the canvas on the page and draw on the same context again.
      setTimeout(() => {
        if (!canvas.isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext()
      }, 0)
    },
  }
}

// ---------- the text colour ----------

/** A computed CSS colour as 0-to-1 channels: rgb()/rgba() or color(srgb …). */
export function parseCssColor(value: string): Rgb | undefined {
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value)
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255]
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(value)
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])]
  return undefined
}

/** Any other colour syntax, through a one-pixel 2D canvas. */
function paintedColor(value: string): Rgb | undefined {
  try {
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    const context = probe.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data
    return [red / 255, green / 255, blue / 255]
  } catch {
    return undefined
  }
}

/** The canvas's own colour, which its stylesheet sets to the text colour. */
function readColor(canvas: HTMLCanvasElement): Rgb {
  const value = getComputedStyle(canvas).color
  return parseCssColor(value) ?? paintedColor(value) ?? FALLBACK_COLOR
}

function sameColor(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** Root attributes the theme, accent and backdrop are set through (theme.ts). */
const THEME_ATTRIBUTES = ['class', 'style', 'data-theme', 'data-accent', 'data-backdrop']

// ---------- a canvas on the page ----------

export type EffectCanvasOptions = {
  /**
   * The window width this canvas stands for when it is drawn smaller (the
   * Settings preview); the effect shrinks with it. Omitted: the window itself.
   */
  windowWidth?: number | undefined
  /** Called if the canvas stops drawing for good (its GL context was lost). */
  onLost?: (() => void) | undefined
}

/**
 * Draws `effect` into `canvas`, sized to the width of its parent, until the
 * returned function stops it. Undefined, and nothing drawn, where WebGL is
 * missing: the caller keeps the still tile.
 */
export function startEffectCanvas(
  canvas: HTMLCanvasElement,
  effect: AppBackgroundEffect,
  options: EffectCanvasOptions = {},
): (() => void) | undefined {
  const created = createEffectRenderer(canvas, effect)
  if (!created) return undefined
  // A named const keeps the narrowing inside the hoisted stop() below.
  const renderer: EffectRenderer = created
  const frameElement = canvas.parentElement ?? canvas
  let color = readColor(canvas)
  let width: number | undefined
  const draw = (time: number) => {
    if (width !== undefined) renderer.draw(time, color)
  }
  const layout = (next: number) => {
    if (next === width) return
    width = next
    const scale = options.windowWidth ? next / options.windowWidth : 1
    renderer.resize(effectCanvasSize(effect, next, scale, window.devicePixelRatio || 1))
    draw(motionSeconds())
  }

  // Window and preview sizes change rarely; neither is read per frame.
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          const entry = entries.at(-1)
          if (entry) layout(entry.contentRect.width)
        })
      : undefined
  if (resizeObserver) resizeObserver.observe(frameElement)
  else layout(frameElement.clientWidth)

  const themeObserver = new MutationObserver(() => {
    const next = readColor(canvas)
    if (sameColor(next, color)) return
    color = next
    draw(motionSeconds())
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: THEME_ATTRIBUTES,
  })

  const removeSink = addMotionSink({ draw })
  let stopped = false
  function stop(): void {
    if (stopped) return
    stopped = true
    removeSink()
    resizeObserver?.disconnect()
    themeObserver.disconnect()
    canvas.removeEventListener('webglcontextlost', lost)
    renderer.dispose()
  }
  function lost(): void {
    stop()
    options.onLost?.()
  }
  canvas.addEventListener('webglcontextlost', lost)
  return stop
}
