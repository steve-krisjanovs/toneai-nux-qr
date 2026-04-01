import { createCanvas, loadImage } from '@napi-rs/canvas'

const VERSION  = '1.0.0'
const APP_NAME = 'toneai-nux-qr'

const QR_SIZE  = 500
const PADDING  = 24
const HEADER_H = 52
const FOOTER_H = 68
const TOTAL_W  = QR_SIZE + PADDING * 2
const TOTAL_H  = QR_SIZE + HEADER_H + FOOTER_H

const BG       = '#0f0f0f'
const ACCENT   = '#e63946'
const TEXT_MAIN = '#ffffff'
const TEXT_SUB  = '#aaaaaa'

// Pro devices embed the preset name in the QR payload
const PRO_DEVICES = new Set(['plugpro', 'space', 'litemk2', '8btmk2'])

export async function decorateQR(
  qrPng: Buffer,
  artist: string,
  song: string,
  deviceId: string,
  deviceName: string,
): Promise<Buffer> {
  const hasEmbeddedName = PRO_DEVICES.has(deviceId)
  const canvas = createCanvas(TOTAL_W, TOTAL_H)
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, TOTAL_W, TOTAL_H)

  // ── Header ──────────────────────────────────────────────────────────────
  // App name (left)
  ctx.font = 'bold 15px Arial'
  ctx.fillStyle = ACCENT
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(APP_NAME, PADDING, HEADER_H / 2)

  // Version (right)
  ctx.font = '13px Arial'
  ctx.fillStyle = TEXT_SUB
  ctx.textAlign = 'right'
  ctx.fillText(`v${VERSION}`, TOTAL_W - PADDING, HEADER_H / 2)

  // Accent divider line
  ctx.fillStyle = ACCENT
  ctx.globalAlpha = 0.4
  ctx.fillRect(0, HEADER_H - 2, TOTAL_W, 2)
  ctx.globalAlpha = 1

  // ── QR Code ──────────────────────────────────────────────────────────────
  const qrImg = await loadImage(qrPng)
  ctx.drawImage(qrImg, PADDING, HEADER_H, QR_SIZE, QR_SIZE)

  // ── Footer ──────────────────────────────────────────────────────────────
  const footerTop = HEADER_H + QR_SIZE

  // Accent divider line
  ctx.fillStyle = ACCENT
  ctx.globalAlpha = 0.4
  ctx.fillRect(0, footerTop, TOTAL_W, 2)
  ctx.globalAlpha = 1

  // Artist — Song (truncate if needed)
  const cx = TOTAL_W / 2
  const line1 = `${artist} — ${song}`
  ctx.font = 'bold 15px Arial'
  ctx.fillStyle = TEXT_MAIN
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(line1, cx, footerTop + FOOTER_H * 0.36, TOTAL_W - PADDING * 2)

  // Device name + embedded name indicator
  const line2 = hasEmbeddedName
    ? `${deviceName}  ·  name embedded in QR`
    : deviceName
  ctx.font = '12px Arial'
  ctx.fillStyle = TEXT_SUB
  ctx.fillText(line2, cx, footerTop + FOOTER_H * 0.70, TOTAL_W - PADDING * 2)

  return canvas.toBuffer('image/png')
}

