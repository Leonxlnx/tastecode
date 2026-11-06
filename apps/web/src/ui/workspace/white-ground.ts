/**
 * Paints a canvas white before a page capture is drawn on it. A page without a background of
 * its own captures transparent, which an image viewer or a vision model shows as black; the
 * browser pane shows such a page on white (#2228), so its pictures do too.
 */
export function paintWhiteGround(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
}

/**
 * Scales a PNG data URL down to at most a width and returns its base64, on white: a narrower
 * capture is redrawn too, so a page without its own background never goes out transparent.
 */
export async function scalePng(dataUrl: string, width: number): Promise<string> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.min(width, image.naturalWidth)
  canvas.height = Math.round((image.naturalHeight * canvas.width) / image.naturalWidth)
  const context = canvas.getContext('2d')
  if (!context) return dataUrl.slice(dataUrl.indexOf(',') + 1)
  paintWhiteGround(context, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const scaled = canvas.toDataURL('image/png')
  return scaled.slice(scaled.indexOf(',') + 1)
}
