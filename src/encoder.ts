import QRCode from 'qrcode'
import { DEVICES, STANDARD_DEVICES_NO_CAB, PLUG_AIR_DEVICES } from './nux.js'
import type { ProPresetParams, DeviceType } from './nux.js'

function encodeParam(value: number, inMin: number, inMax: number): number {
  return Math.round(((Math.max(inMin, Math.min(inMax, value)) - inMin) / (inMax - inMin)) * 100)
}
function encodeDbPro(db: number): number { return encodeParam(db, -12, 12) }
function encodeDbEQ(db: number): number  { return encodeParam(db, -15, 15) }
function headByte(nuxIndex: number, enabled: boolean): number { return nuxIndex | (enabled ? 0x00 : 0x40) }
function stdEnable(on: boolean): number { return on ? 0x7f : 0x00 }

function buildProPayload(p: ProPresetParams): Buffer {
  const data = Buffer.alloc(113, 0)
  data[1] = headByte(p.compressor?.id ?? 1, p.compressor?.enabled ?? false)
  data[2] = headByte(p.efx?.id ?? 1,        p.efx?.enabled ?? false)
  data[3] = headByte(p.amp.id,              true)
  data[4] = headByte(p.eq?.id ?? 1,         p.eq?.enabled ?? false)
  data[5] = headByte(1,                     p.noise_gate.enabled)
  data[6] = headByte(p.modulation?.id ?? 2, p.modulation?.enabled ?? false)
  data[7] = headByte(p.delay?.id ?? 2,      p.delay?.enabled ?? false)
  data[8] = headByte(p.reverb?.id ?? 1,     p.reverb?.enabled ?? false)
  data[9] = headByte(p.cabinet!.id,         true)

  if (p.compressor?.enabled) { data[15] = p.compressor.p1; data[16] = p.compressor.p2; if (p.compressor.p3 !== undefined) data[17] = p.compressor.p3 }
  if (p.efx?.enabled)        { data[20] = p.efx.p1; data[21] = p.efx.p2; if (p.efx.p3 !== undefined) data[22] = p.efx.p3 }

  data[27] = p.amp.gain; data[28] = p.amp.master
  data[29] = p.amp.bass; data[30] = p.amp.mid; data[31] = p.amp.treble
  if (p.amp.param6 !== undefined) data[32] = p.amp.param6
  if (p.amp.param7 !== undefined) data[33] = p.amp.param7

  if (p.eq?.enabled) p.eq.bands.forEach((db, i) => { data[36 + i] = encodeDbEQ(db) })

  data[49] = p.noise_gate.sensitivity; data[50] = p.noise_gate.decay

  if (p.modulation?.enabled) { data[54] = p.modulation.p1; data[55] = p.modulation.p2; if (p.modulation.p3 !== undefined) data[56] = p.modulation.p3 }
  if (p.delay?.enabled)      { data[61] = p.delay.p1; data[62] = p.delay.p2; data[63] = p.delay.p3 ?? 0 }
  if (p.reverb?.enabled)     { data[70] = p.reverb.p1; data[71] = p.reverb.p2; if (p.reverb.p3 !== undefined) data[72] = p.reverb.p3 }

  data[78] = encodeDbPro(p.cabinet!.level_db)
  data[79] = encodeParam(p.cabinet!.low_cut_hz, 20, 300)
  data[80] = Math.round(Math.max(0, Math.min(100, p.cabinet!.high_cut)))
  data[84] = encodeDbPro(p.master_db)

  ;[5, 1, 6, 2, 3, 9, 4, 8, 7].forEach((fxid, i) => { data[89 + i] = fxid })

  const qrName = (p.preset_name_short || p.preset_name).slice(0, 15)
  Buffer.from(qrName, 'ascii').copy(data, 98)
  return data
}

function buildPlugAirPayload(p: ProPresetParams): Buffer {
  const data = Buffer.alloc(40, 0)
  data[0] = stdEnable(p.noise_gate.enabled); data[1] = p.noise_gate.sensitivity; data[2] = p.noise_gate.decay
  data[3] = stdEnable(p.efx?.enabled ?? false); data[4] = p.efx?.id ?? 0; data[5] = p.efx?.p1 ?? 0; data[6] = p.efx?.p2 ?? 0; data[7] = p.efx?.p3 ?? 0
  data[8] = 0x7f; data[9] = p.amp.id; data[10] = p.amp.gain; data[11] = p.amp.master
  data[12] = p.amp.bass; data[13] = p.amp.mid; data[14] = p.amp.treble; data[15] = p.amp.param6 ?? 0
  data[16] = 0x7f; data[17] = p.cabinet?.id ?? 0; data[18] = encodeDbPro(p.cabinet?.level_db ?? 0)
  data[19] = stdEnable(p.modulation?.enabled ?? false); data[20] = p.modulation?.id ?? 0; data[21] = p.modulation?.p1 ?? 0; data[22] = p.modulation?.p2 ?? 0; data[23] = p.modulation?.p3 ?? 0
  data[24] = stdEnable(p.delay?.enabled ?? false); data[25] = p.delay?.id ?? 0; data[26] = p.delay?.p1 ?? 0; data[27] = p.delay?.p2 ?? 0; data[28] = p.delay?.p3 ?? 0
  data[29] = stdEnable(p.reverb?.enabled ?? false); data[30] = p.reverb?.id ?? 0; data[31] = p.reverb?.p1 ?? 0; data[32] = p.reverb?.p2 ?? 0; data[33] = p.reverb?.p3 ?? 0
  return data
}

function buildLitePayload(p: ProPresetParams): Buffer {
  const data = Buffer.alloc(40, 0)
  data[0] = stdEnable(p.noise_gate.enabled); data[1] = p.noise_gate.sensitivity; data[2] = p.noise_gate.decay
  data[7] = p.amp.gain; data[8] = p.amp.master; data[12] = p.amp.param6 ?? 50
  data[13] = stdEnable(p.modulation?.enabled ?? false); data[14] = p.modulation?.id ?? 0; data[15] = p.modulation?.p1 ?? 0; data[16] = p.modulation?.p2 ?? 0
  if (p.reverb?.enabled) {
    data[18] = 0x7f; data[19] = (p.reverb.id) + 10; data[21] = p.reverb.p1 ?? 0; data[22] = p.reverb.p2 ?? 0
  } else if (p.delay?.enabled) {
    data[18] = 0x7f; data[19] = p.delay.id; data[24] = p.delay.p1 ?? 0; data[25] = p.delay.p2 ?? 0; data[26] = p.delay.p3 ?? 0
  }
  return data
}

function build8BTPayload(p: ProPresetParams): Buffer {
  const data = Buffer.alloc(40, 0)
  data[0] = stdEnable(p.noise_gate.enabled); data[1] = p.noise_gate.sensitivity; data[2] = p.noise_gate.decay
  data[7] = p.amp.gain; data[8] = p.amp.master; data[12] = p.amp.param6 ?? 50
  data[13] = stdEnable(p.modulation?.enabled ?? false); data[14] = p.modulation?.id ?? 0; data[15] = p.modulation?.p1 ?? 0; data[16] = p.modulation?.p2 ?? 0
  data[20] = p.reverb?.id ?? 0; data[21] = p.reverb?.p1 ?? 0; data[22] = p.reverb?.p2 ?? 0; data[32] = stdEnable(p.reverb?.enabled ?? false)
  data[23] = p.delay?.id ?? 0; data[24] = p.delay?.p1 ?? 0; data[25] = p.delay?.p2 ?? 0; data[26] = p.delay?.p3 ?? 0; data[33] = stdEnable(p.delay?.enabled ?? false)
  return data
}

function build2040BTPayload(p: ProPresetParams): Buffer {
  const data = Buffer.alloc(40, 0)
  data[0] = stdEnable(p.noise_gate.enabled); data[1] = p.noise_gate.sensitivity
  data[2] = stdEnable(p.wah?.enabled ?? false); data[3] = p.wah?.pedal ?? 50
  data[5] = p.amp.gain; data[6] = p.amp.master; data[7] = p.amp.bass; data[8] = p.amp.mid; data[9] = p.amp.treble
  data[10] = stdEnable(p.modulation?.enabled ?? false); data[11] = p.modulation?.id ?? 0; data[12] = p.modulation?.p1 ?? 0; data[13] = p.modulation?.p2 ?? 0; data[14] = p.modulation?.p3 ?? 0
  data[15] = stdEnable(p.delay?.enabled ?? false); data[16] = p.delay?.id ?? 0; data[17] = p.delay?.p1 ?? 0; data[18] = p.delay?.p2 ?? 0; data[19] = p.delay?.p3 ?? 0
  data[20] = stdEnable(p.reverb?.enabled ?? false); data[21] = p.reverb?.id ?? 0; data[22] = p.reverb?.p1 ?? 0; data[23] = p.reverb?.p2 ?? 0; data[24] = p.reverb?.p3 ?? 0
  return data
}

export function buildQRString(p: ProPresetParams): string {
  const device = DEVICES[p.device]
  if (!device) throw new Error(`Unknown device: ${p.device}`)
  let payload: Buffer
  if (device.format === 'pro') {
    payload = buildProPayload(p)
  } else {
    switch (p.device) {
      case 'plugair_v1': case 'plugair_v2': case 'mightyair_v1': case 'mightyair_v2':
        payload = buildPlugAirPayload(p); break
      case 'lite':   payload = buildLitePayload(p); break
      case '8bt':    payload = build8BTPayload(p); break
      case '2040bt': payload = build2040BTPayload(p); break
      default: throw new Error(`Unknown standard device: ${p.device}`)
    }
  }
  const full = Buffer.concat([Buffer.from([device.deviceQRId, device.deviceQRVersion]), payload])
  return 'nux://MightyAmp:' + full.toString('base64')
}

export async function generateQRPng(p: ProPresetParams): Promise<Buffer> {
  const qrString = buildQRString(p)
  return QRCode.toBuffer(qrString, {
    errorCorrectionLevel: 'H',
    width: 500,
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
  }) as Promise<Buffer>
}

// ── Coerce raw LLM tool output → ProPresetParams ──────────────────────────────

function n(v: unknown, fallback: number): number { const x = Number(v); return isFinite(x) ? x : fallback }
function b(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1) return true
  if (v === 'false' || v === 0) return false
  return fallback
}

const GENERIC_NAMES = new Set(['my tone','custom tone','preset','guitar tone','bass tone','my preset','tone','custom preset','unnamed tone'])

export function coerceParams(raw: Record<string, unknown>, device: DeviceType): ProPresetParams {
  const amp = (raw.amp as Record<string, unknown>) ?? {}
  const cab = (raw.cabinet as Record<string, unknown>) ?? {}
  const ng  = (raw.noise_gate as Record<string, unknown>) ?? {}
  const hasCabinet = !STANDARD_DEVICES_NO_CAB.has(device)
  const defaultAmpId = PLUG_AIR_DEVICES.has(device) ? 0 : 2
  const rawName = ((raw.preset_name as string) || '').trim()

  const coerced: ProPresetParams = {
    device,
    preset_name: rawName && !GENERIC_NAMES.has(rawName.toLowerCase()) ? rawName : 'Unnamed Tone',
    preset_name_short: ((raw.preset_name_short as string) || '').trim().slice(0, 15) || undefined,
    amp: {
      id:     n(amp.id ?? amp.nuxIndex, defaultAmpId),
      gain:   n(amp.gain, 50),
      master: n(amp.master ?? amp.volume ?? amp.master_volume, 70),
      bass:   n(amp.bass, 50),
      mid:    n(amp.mid, 50),
      treble: n(amp.treble, 50),
      ...(amp.param6 !== undefined ? { param6: n(amp.param6, 50) } : {}),
      ...(amp.param7 !== undefined ? { param7: n(amp.param7, 50) } : {}),
    },
    ...(hasCabinet ? { cabinet: { id: n(cab.id ?? cab.nuxIndex, 2), level_db: n(cab.level_db ?? cab.level, 0), low_cut_hz: n(cab.low_cut_hz ?? cab.low_cut, 80), high_cut: n(cab.high_cut, 50) } } : {}),
    noise_gate: { enabled: b(ng.enabled ?? ng.active, false), sensitivity: n(ng.sensitivity ?? ng.threshold, 50), decay: n(ng.decay ?? ng.release, 50) },
    master_db: n(raw.master_db, 0),
  }

  if (device === '2040bt' && raw.wah && typeof raw.wah === 'object') {
    const w = raw.wah as Record<string, unknown>
    coerced.wah = { enabled: b(w.enabled, false), pedal: n(w.pedal, 50) }
  }

  for (const key of ['efx','compressor','modulation','delay','reverb'] as const) {
    const e = raw[key] as Record<string, unknown> | undefined
    if (!e || e.id === undefined || e.id === null || !isFinite(Number(e.id))) continue
    ;(coerced as unknown as Record<string, unknown>)[key] = {
      id: n(e.id, 1), enabled: b(e.enabled ?? e.active, false),
      p1: n(e.p1 ?? e.param1, 50), p2: n(e.p2 ?? e.param2, 50),
      ...(e.p3 !== undefined ? { p3: n(e.p3, 50) } : {}),
      ...(e.p4 !== undefined ? { p4: n(e.p4, 50) } : {}),
      ...(e.p5 !== undefined ? { p5: n(e.p5, 50) } : {}),
    }
  }

  if (raw.eq && typeof raw.eq === 'object') {
    const e = raw.eq as Record<string, unknown>
    const eqId = n(e.id, 1)
    const defaultBands = eqId === 3 ? new Array(11).fill(0) : new Array(6).fill(0)
    const bands = Array.isArray(e.bands) ? (e.bands as unknown[]).map(v => n(v, 0)) : defaultBands
    coerced.eq = { id: eqId, enabled: b(e.enabled ?? e.active, true), bands }
  }

  return coerced
}
