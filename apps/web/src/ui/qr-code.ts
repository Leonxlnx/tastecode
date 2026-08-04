import * as QRCode from 'qrcode'

export function renderQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    width: 192,
    color: { dark: '#111111', light: '#ffffff' },
  })
}
