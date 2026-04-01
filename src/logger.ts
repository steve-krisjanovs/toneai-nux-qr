import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const TNQR_DIR = path.join(os.homedir(), '.toneai-nux-qr')
export const LOGS_DIR = path.join(TNQR_DIR, 'logs')

export type LogFormat = 'jsonl' | 'text'

export interface RunMeta {
  version: string
  query: string
  context: string
  artist: string
  devices: string[]
  instrument: string
  pickup?: string
  concurrency: number
  toneModel: string
  intentModel: string
  totalTracks: number
  startedAt: string
}

export interface TrackLog {
  trackNumber: number
  title: string
  note?: string
  device: string
  status: 'success' | 'failed'
  presetName?: string
  qrString?: string
  promptSent?: string
  rawToolInput?: unknown
  coercedParams?: unknown
  nudgeRequired?: boolean
  nudgeElapsedMs?: number
  elapsedMs?: number
  error?: string
  startedAt: string
  completedAt: string
}

export interface RunSummary {
  succeeded: number
  failed: number
  totalElapsedMs: number
  outputDir: string
  zipPath?: string
  completedAt: string
}

export interface ParsedLog {
  meta: RunMeta & { type: 'run_start' }
  tracks: (TrackLog & { type: 'track' })[]
  summary?: RunSummary & { type: 'run_end' }
}

export function parseLog(logPath: string): ParsedLog {
  const raw = fs.readFileSync(logPath, 'utf8')
  const lines = raw.trim().split('\n').filter(Boolean)

  let meta: ParsedLog['meta'] | undefined
  const tracks: ParsedLog['tracks'] = []
  let summary: ParsedLog['summary'] | undefined

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'run_start') meta = entry
      else if (entry.type === 'track') tracks.push(entry)
      else if (entry.type === 'run_end') summary = entry
    } catch { /* skip malformed lines */ }
  }

  if (!meta) throw new Error(`Log file does not contain a valid run_start entry: ${logPath}`)
  return { meta, tracks, summary }
}

export class RunLogger {
  private logPath: string
  private format: LogFormat
  private meta: RunMeta
  private trackLogs: TrackLog[] = []
  private enabled: boolean

  constructor(logPath: string | undefined, format: LogFormat, meta: RunMeta) {
    this.format = format
    this.meta = meta

    if (logPath) {
      this.enabled = true
      this.logPath = logPath
    } else {
      // Default: ~/.toneai-nux-qr/logs/<timestamp>-<slug>.jsonl
      this.enabled = true
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const slug = meta.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      const ext = format === 'text' ? 'log' : 'jsonl'
      fs.mkdirSync(LOGS_DIR, { recursive: true })
      this.logPath = path.join(LOGS_DIR, `${timestamp}-${slug}.${ext}`)
    }
  }

  disable(): void {
    this.enabled = false
  }

  logTrack(entry: TrackLog): void {
    if (!this.enabled) return
    this.trackLogs.push(entry)
  }

  flush(summary: RunSummary): void {
    if (!this.enabled) return
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
      if (this.format === 'text') {
        fs.writeFileSync(this.logPath, this.buildTextLog(summary), 'utf8')
      } else {
        fs.writeFileSync(this.logPath, this.buildJsonlLog(summary), 'utf8')
      }
    } catch (err) {
      // Non-fatal — never crash the app over logging
      process.stderr.write(`Warning: could not write log: ${err instanceof Error ? err.message : err}\n`)
    }
  }

  get path(): string { return this.logPath }

  trackCount(status: 'success' | 'failed'): number {
    return this.trackLogs.filter(t => t.status === status).length
  }

  private buildJsonlLog(summary: RunSummary): string {
    const lines: string[] = []
    lines.push(JSON.stringify({ type: 'run_start', ...this.meta }))
    for (const t of this.trackLogs) {
      lines.push(JSON.stringify({ type: 'track', ...t }))
    }
    lines.push(JSON.stringify({ type: 'run_end', ...summary }))
    return lines.join('\n') + '\n'
  }

  private buildTextLog(summary: RunSummary): string {
    const lines: string[] = []
    lines.push(`# toneai-nux-qr run log`)
    lines.push(`# Started:  ${this.meta.startedAt}`)
    lines.push(`# Query:    ${this.meta.query}`)
    lines.push(`# Context:  ${this.meta.context}`)
    lines.push(`# Devices:  ${this.meta.devices.join(', ')}`)
    lines.push(`# Instrument: ${this.meta.instrument}`)
    if (this.meta.pickup) lines.push(`# Pickup:   ${this.meta.pickup}`)
    lines.push(`# Model:    ${this.meta.toneModel}`)
    lines.push(`# Tracks:   ${this.meta.totalTracks}`)
    lines.push('')

    for (const t of this.trackLogs) {
      lines.push(`[${t.status === 'success' ? '✓' : '✗'}] ${t.trackNumber}. ${t.title}${t.note ? ` (${t.note})` : ''} — ${t.device}`)
      if (t.status === 'success') {
        lines.push(`    Preset:   ${t.presetName}`)
        lines.push(`    QR:       ${t.qrString}`)
        lines.push(`    Elapsed:  ${((t.elapsedMs ?? 0) / 1000).toFixed(1)}s`)
        if (t.nudgeRequired) lines.push(`    Nudge:    yes (${((t.nudgeElapsedMs ?? 0) / 1000).toFixed(1)}s)`)
        if (t.promptSent) lines.push(`    Prompt:   ${t.promptSent}`)
        if (t.rawToolInput) lines.push(`    AI tool input: ${JSON.stringify(t.rawToolInput)}`)
        if (t.coercedParams) lines.push(`    Coerced:  ${JSON.stringify(t.coercedParams)}`)
      } else {
        lines.push(`    Error:    ${t.error}`)
        lines.push(`    Elapsed:  ${((t.elapsedMs ?? 0) / 1000).toFixed(1)}s`)
      }
      lines.push('')
    }

    lines.push(`# Completed: ${summary.completedAt}`)
    lines.push(`# Succeeded: ${summary.succeeded}/${this.meta.totalTracks}`)
    lines.push(`# Failed:    ${summary.failed}/${this.meta.totalTracks}`)
    lines.push(`# Total time: ${(summary.totalElapsedMs / 1000).toFixed(1)}s`)
    lines.push(`# Output:    ${summary.outputDir}`)
    if (summary.zipPath) lines.push(`# Zip:       ${summary.zipPath}`)
    return lines.join('\n') + '\n'
  }
}
