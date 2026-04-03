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
  inputTokens?: number
  outputTokens?: number
  webSearches?: number
  startedAt: string
  completedAt: string
}

export interface RunSummary {
  succeeded: number
  failed: number
  totalElapsedMs: number
  outputDir: string
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalWebSearches?: number
  estimatedCostUsd?: number
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

export interface RunInfo {
  index: number
  path: string
  filename: string
  query: string
  context: string
  artist: string
  date: string
  totalTracks: number
  succeeded: number
  failed: number
  status: 'success' | 'partial' | 'failed' | 'unknown'
}

export function listRuns(limit: number = 10): RunInfo[] {
  if (!fs.existsSync(LOGS_DIR)) return []
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, limit)

  return files.map((filename, i) => {
    const logPath = path.join(LOGS_DIR, filename)
    try {
      const parsed = parseLog(logPath)
      const succeeded = parsed.tracks.filter(t => t.status === 'success').length
      const failed = parsed.tracks.filter(t => t.status === 'failed').length
      const status = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
      return {
        index: i + 1,
        path: logPath,
        filename,
        query: parsed.meta.query,
        context: parsed.meta.context,
        artist: parsed.meta.artist,
        date: parsed.meta.startedAt.slice(0, 16).replace('T', ' '),
        totalTracks: parsed.meta.totalTracks,
        succeeded,
        failed,
        status,
      }
    } catch {
      return {
        index: i + 1,
        path: logPath,
        filename,
        query: '?',
        context: '?',
        artist: '?',
        date: '?',
        totalTracks: 0,
        succeeded: 0,
        failed: 0,
        status: 'unknown' as const,
      }
    }
  })
}

export function resolveRunPath(arg: string | undefined): string[] {
  return resolveRuns(arg, 'failed').map(r => r.path)
}

export function resolveRuns(arg: string | undefined, filter?: 'failed'): RunInfo[] {
  const runs = listRuns(100)
  if (runs.length === 0) {
    console.error('Error: no runs found in ~/.toneai-nux-qr/logs/')
    process.exit(1)
  }

  // No arg = most recent (optionally filtered)
  if (!arg) {
    const target = filter === 'failed' ? runs.find(r => r.failed > 0) : runs[0]
    if (!target) {
      console.log(filter === 'failed' ? '\n✅ No failed runs to resume.\n' : '\nNo runs found.\n')
      process.exit(0)
    }
    return [target]
  }

  // "all" = all runs (optionally filtered)
  if (arg === 'all') {
    const targets = filter === 'failed' ? runs.filter(r => r.failed > 0) : runs
    if (targets.length === 0) {
      console.log(filter === 'failed' ? '\n✅ No failed runs to resume.\n' : '\nNo runs found.\n')
      process.exit(0)
    }
    return targets
  }

  // Number = Nth most recent
  const n = parseInt(arg, 10)
  if (!isNaN(n) && n >= 1 && n <= runs.length) {
    return [runs[n - 1]]
  }

  console.error(`Error: invalid target "${arg}". Use a number (1-${runs.length}), "all", or omit for most recent.`)
  process.exit(1)
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
    return lines.join('\n') + '\n'
  }
}
