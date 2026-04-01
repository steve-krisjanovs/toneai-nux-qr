// Live progress display for batch tone generation
// Auto-detects TTY: fancy redrawn display in a real terminal,
// plain line-by-line output when piped, buffered, or in CI.

export interface TrackStatus {
  title: string
  state: 'waiting' | 'querying' | 'done' | 'failed'
  elapsed?: number
  presetName?: string
  error?: string
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function progressBar(done: number, total: number, width = 20): string {
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

export class ProgressDisplay {
  private tracks: TrackStatus[]
  private startTime: number
  private spinnerFrame = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private silent: boolean
  private isTTY: boolean
  private totalLines = 0

  constructor(titles: string[], silent: boolean) {
    this.silent = silent
    this.isTTY = process.stdout.isTTY === true
    this.startTime = Date.now()
    this.tracks = titles.map(title => ({ title, state: 'waiting' as const }))
  }

  start(): void {
    if (this.silent) return
    if (this.isTTY) {
      this.render()
      this.timer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
        this.render()
      }, 100)
    } else {
      console.log(`  Generating ${this.tracks.length} tone${this.tracks.length === 1 ? '' : 's'}...`)
    }
  }

  setQuerying(index: number): void {
    this.tracks[index].state = 'querying'
    if (!this.silent && !this.isTTY) {
      const name = this.tracks[index].title
      process.stdout.write(`  [ ${String(index + 1).padStart(String(this.tracks.length).length)}/${this.tracks.length} ] ${name}...`)
    }
  }

  setDone(index: number, presetName: string, elapsed: number): void {
    this.tracks[index].state = 'done'
    this.tracks[index].presetName = presetName
    this.tracks[index].elapsed = elapsed
    if (!this.silent && !this.isTTY) {
      console.log(` ✓  ${presetName}  (${formatTime(elapsed)})`)
    } else if (!this.silent && this.isTTY) {
      this.render()
    }
  }

  setFailed(index: number, error: string, elapsed: number): void {
    this.tracks[index].state = 'failed'
    this.tracks[index].error = error
    this.tracks[index].elapsed = elapsed
    if (!this.silent && !this.isTTY) {
      console.log(` ✗  ${error}`)
    } else if (!this.silent && this.isTTY) {
      this.render()
    }
  }

  stop(): void {
    if (this.silent) return
    if (this.isTTY) {
      if (this.timer) { clearInterval(this.timer); this.timer = null }
      this.render(true)
      process.stdout.write('\n')
    } else {
      const done   = this.tracks.filter(t => t.state === 'done').length
      const failed = this.tracks.filter(t => t.state === 'failed').length
      const elapsed = Date.now() - this.startTime
      console.log(`  Done: ${done} succeeded, ${failed} failed  (${formatTime(elapsed)})`)
    }
  }

  log(msg: string): void {
    if (this.silent) return
    if (this.isTTY) {
      this.clear()
      console.log(msg)
      this.render()
    } else {
      console.log(msg)
    }
  }

  private clear(): void {
    if (this.totalLines === 0) return
    process.stdout.write(`\x1b[${this.totalLines}A\x1b[0J`)
  }

  private render(final = false): void {
    const done    = this.tracks.filter(t => t.state === 'done').length
    const failed  = this.tracks.filter(t => t.state === 'failed').length
    const total   = this.tracks.length
    const elapsed = Date.now() - this.startTime

    const doneTracks = this.tracks.filter(t => t.state === 'done' && t.elapsed)
    const avgMs = doneTracks.length > 0
      ? doneTracks.reduce((sum, t) => sum + (t.elapsed ?? 0), 0) / doneTracks.length
      : null
    const remaining = total - done - failed
    const etaMs = avgMs !== null && remaining > 0 ? avgMs * remaining : null

    const spin = final ? '✓' : SPINNER[this.spinnerFrame]
    const pct  = total > 0 ? Math.round(((done + failed) / total) * 100) : 0

    const lines: string[] = []

    lines.push(`${spin} Generating tones... [${progressBar(done + failed, total)}] ${done + failed}/${total}  (${pct}%)`)
    lines.push('')

    for (const t of this.tracks) {
      const name = t.title.length > 28 ? t.title.slice(0, 26) + '…' : t.title.padEnd(28)
      if (t.state === 'done') {
        const time   = t.elapsed ? formatTime(t.elapsed) : ''
        const preset = t.presetName ? `  ${t.presetName}` : ''
        lines.push(`  ✓ ${name} ${time}${preset}`)
      } else if (t.state === 'failed') {
        lines.push(`  ✗ ${name} ${t.error ?? 'failed'}`)
      } else if (t.state === 'querying') {
        lines.push(`  ${SPINNER[this.spinnerFrame]} ${name} querying...`)
      } else {
        lines.push(`  ─ ${name}`)
      }
    }

    lines.push('')
    const timeInfo = etaMs !== null
      ? `Elapsed: ${formatTime(elapsed)}  ·  Est. remaining: ${formatTime(etaMs)}`
      : `Elapsed: ${formatTime(elapsed)}`
    lines.push(`  ${timeInfo}`)

    this.clear()
    process.stdout.write(lines.join('\n') + '\n')
    this.totalLines = lines.length
  }
}
