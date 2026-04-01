#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import JSZip from 'jszip'
import { ALL_DEVICES, VALID_DEVICES, DEVICES } from './nux.js'
import { generateQRPng } from './encoder.js'
import { decorateQR } from './decorate.js'
import { resolveIntent, generateToneForSong } from './ai.js'
import { resolveApiKey } from './config.js'
import { ProgressDisplay } from './progress.js'
import { RunLogger, parseLog, listRuns, resolveRunPath } from './logger.js'
import type { LogFormat } from './logger.js'
import type { DeviceType } from './nux.js'

const HARD_CEILING = 100
const DEFAULT_CEILING = 25
const DEFAULT_CONCURRENCY = 5
const MAX_CONCURRENCY = 25

function confirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

function fuzzyMatchDevice(input: string): DeviceType | 'all' | null {
  const s = input.toLowerCase().replace(/\s+/g, '')

  if (s === 'all') return 'all'

  // Exact match first
  if (VALID_DEVICES.has(s as DeviceType)) return s as DeviceType

  // Alias map — common shorthand and natural language variants
  const aliases: Record<string, DeviceType> = {
    // Plug Pro
    'plugpro': 'plugpro', 'mightyplugrpo': 'plugpro', 'plugpropro': 'plugpro',
    'pro': 'plugpro', 'mightypro': 'plugpro',
    // Space
    'mightyspace': 'space',
    // Lite MkII
    'litemk2': 'litemk2', 'litemkii': 'litemk2', 'mightylitemk2': 'litemk2', 'mightylitemkii': 'litemk2',
    // 8BT MkII
    '8btmk2': '8btmk2', '8btmkii': '8btmk2', 'mighty8btmk2': '8btmk2',
    // Plug Air v1
    'plugairv1': 'plugair_v1', 'plugv1': 'plugair_v1', 'airv1': 'plugair_v1',
    'mightyplugv1': 'plugair_v1', 'mightyplugairv1': 'plugair_v1',
    // Plug Air v2
    'plugairv2': 'plugair_v2', 'plugv2': 'plugair_v2', 'airv2': 'plugair_v2',
    'mightyplugv2': 'plugair_v2', 'mightyplugairv2': 'plugair_v2',
    // Mighty Air v1
    'mightyairv1': 'mightyair_v1', 'mightyair1': 'mightyair_v1',
    // Mighty Air v2
    'mightyairv2': 'mightyair_v2', 'mightyair2': 'mightyair_v2', 'mightyair': 'mightyair_v2',
    // Lite BT
    'lite': 'lite', 'mightylite': 'lite', 'litebt': 'lite', 'mightylitebt': 'lite',
    // 8BT
    '8bt': '8bt', 'mighty8bt': '8bt', '8btoriginal': '8bt',
    // 20/40BT
    '2040bt': '2040bt', 'mighty2040bt': '2040bt', '20bt': '2040bt', '40bt': '2040bt',
    '2040': '2040bt', 'mighty20': '2040bt', 'mighty40': '2040bt',
  }

  if (aliases[s]) return aliases[s]

  // Substring match against display names — e.g. "plug pro" → "Mighty Plug Pro"
  for (const [id, config] of Object.entries(DEVICES) as [DeviceType, typeof DEVICES[DeviceType]][]) {
    const normalized = config.displayName.toLowerCase().replace(/\s+/g, '')
    if (normalized.includes(s) || s.includes(normalized)) return id
  }

  return null
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function pad(n: number, total: number): string {
  return String(n).padStart(Math.max(2, String(total).length), '0')
}

const DEFAULT_FOLDER_FORMAT = '{artist}-{album}'
const DEFAULT_FILE_FORMAT = '{track}-{song}'

function formatTemplate(template: string, vars: Record<string, string>): string {
  const result = template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = vars[key]
    return val !== undefined ? slugify(val) : ''
  })
  // Clean up: collapse multiple dashes/slashes from empty tokens, trim edges
  return result.replace(/-{2,}/g, '-').replace(/\/{2,}/g, '/').replace(/(^[-/]+|[-/]+$)/g, '').replace(/\/-/g, '/').replace(/-\//g, '/')
}

function extractAlbum(context: string): string {
  // context is like "Led Zeppelin — Physical Graffiti (1975 double album)"
  const afterDash = context.split('—')[1]?.trim()
  if (!afterDash) return context
  return afterDash.split('(')[0].trim()
}

function printHelp(): void {
  console.log(`
tnqr — AI-generated NUX MightyAmp QR tone presets for any album, song, or artist

Usage:
  tnqr "<query>" [device] [options]
  tnqr -q "<query>" -d <device> [options]
  tnqr set-key <key>

Examples:
  tnqr set-key sk-ant-...
  tnqr "led zeppelin physical graffiti"
  tnqr "led zeppelin physical graffiti" plugpro
  tnqr -q "led zeppelin physical graffiti" -d plugpro
  tnqr -q "comfortably numb" -d plugpro
  tnqr -q "pink floyd the wall" -d mightyair_v2 -o ~/Desktop/qrcodes
  tnqr -q "metallica master of puppets" -d all -o ./my-presets
  tnqr -q "srv texas flood" -d plugpro -p "strat middle single coil"

Options:
  -q, --query <text>     What to generate tones for                     $TNQR_QUERY
  -d, --device <id>      Target NUX device (default: plugpro)          $TNQR_DEVICE
  -I, --instrument       Instrument type: guitar or bass (default: guitar) $TNQR_INSTRUMENT
  -o, --output <path>    Output directory (default: ./output)           $TNQR_OUTPUT
  -k, --api-key <key>    Anthropic API key                              $TNQR_ANTHROPIC_API_KEY
                         Get a free key at: https://console.anthropic.com
                         Save permanently:  tnqr set-key <key>
  -p, --pickup <desc>    Instrument signal context — pickup type,       $TNQR_PICKUP
                         vol/tone pot positions, inline effects, anything
                         that affects your signal before the amp.
                         e.g. "Les Paul bridge humbucker, vol 7, tone 8"
                              "Jazz bass bridge pickup, vol full, tone 8"
                              "Precision bass, flatwounds, vol 7"
                              "Active EMG 81 bridge, vol full"
  -z, --zip              Create a zip archive of all QR codes           $TNQR_ZIP
  -l, --ceiling <n>      Max tracks before confirmation (default: 25)   $TNQR_CEILING
  -c, --concurrency <n>  Parallel track generation (default: 5, max 25) $TNQR_CONCURRENCY
  -y, --yes              Skip confirmation prompt                        $TNQR_YES
  -s, --silent           Suppress progress display                      $TNQR_SILENT
  -n, --dry-run          Resolve and show tracklist without generating
  -r, --resume [N|all]   Resume failed tracks from a previous run
                         -r         most recent run with failures
                         -r 3       third most recent run
                         -r all     all runs with failures
      --list-runs [N]    Show recent runs (default: 10)
  -L, --log <path>       Log file path (default: ~/.toneai-nux-qr/logs/<timestamp>.jsonl) $TNQR_LOG
      --log-format       Log format: jsonl or text (default: jsonl)    $TNQR_LOG_FORMAT
  -F, --folder-format    Folder name format (default: {artist}-{album})  $TNQR_FOLDER_FORMAT
                         Supports / for subfolders, e.g. {artist}/{album}
  -f, --file-format      File name format (default: {track}-{song})     $TNQR_FILE_FORMAT
                         Tokens: {artist} {album} {track} {song} {preset} {device}
                         Empty tokens are dropped cleanly (no double dashes)
      --list-devices     List all supported devices and exit
  -m, --model <model>    Tone generation model                          $TNQR_MODEL
                         (default: claude-sonnet-4-6)
  -i, --intent-model     Intent resolution model                        $TNQR_INTENT_MODEL
                         (default: claude-haiku-4-5-20251001)

Devices:
${ALL_DEVICES.map(d => `  ${d.padEnd(14)} ${DEVICES[d].displayName}`).join('\n')}
  all            Generate for every device

Environment Variables:
  TNQR_QUERY                 What to generate tones for (same as -q)
  TNQR_DEVICE                Target NUX device (same as -d, default: plugpro)
  TNQR_INSTRUMENT            Instrument type: guitar or bass (same as -I, default: guitar)
  TNQR_OUTPUT                Output directory (same as -o, default: ./output)
  TNQR_ANTHROPIC_API_KEY     Anthropic API key (same as -k)
                             Also accepts: ANTHROPIC_API_KEY (standard Anthropic convention)
  TNQR_PICKUP                Guitar signal context (same as -p)
  TNQR_ZIP                   Create zip archive, set to 1 or true (same as -z)
  TNQR_CEILING               Max tracks before confirmation prompt (same as -l, default: 25)
  TNQR_CONCURRENCY           Parallel track generation (same as -c, default: 5, max: 25)
  TNQR_YES                   Skip confirmation, set to 1 or true (same as -y)
  TNQR_SILENT                Suppress progress display, set to 1 or true (same as -s)
  TNQR_MODEL                 Tone generation model (same as -m, default: claude-sonnet-4-6)
  TNQR_INTENT_MODEL          Intent resolution model (same as -i, default: claude-haiku-4-5-20251001)
  TNQR_LOG                   Log file path (same as -L, default: ~/.toneai-nux-qr/logs/)
  TNQR_LOG_FORMAT            Log format: jsonl or text (same as --log-format, default: jsonl)
  TNQR_FOLDER_FORMAT         Folder name format (same as --folder-format)
  TNQR_FILE_FORMAT           File name format (same as --file-format)

  Tip: Set your frequently-used options in ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish
  e.g. export TNQR_ANTHROPIC_API_KEY=sk-ant-...
       export TNQR_DEVICE=mightyair_v2
       export TNQR_PICKUP="Les Paul bridge humbucker, vol 7, tone 8"

Config file: ~/.toneai-nux-qr/config.json (created on first run, stores API key)
Log files:   ~/.toneai-nux-qr/logs/ (one per run)

Output:
  output/<folder-format>/<device>/<file-format>.png
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp()
    process.exit(0)
  }

  // set-key subcommand — save API key to config file
  if (args[0] === 'set-key') {
    const key = args[1]
    if (!key) {
      console.error('Usage: tnqr set-key <key>')
      console.error('Get a free key at: https://console.anthropic.com')
      process.exit(1)
    }
    if (!key.startsWith('sk-ant-')) {
      console.error(`Error: that doesn't look like a valid Anthropic API key (should start with sk-ant-).`)
      process.exit(1)
    }
    const { loadConfig } = await import('./config.js')
    const fs2 = await import('node:fs')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const { TNQR_DIR } = await import('./logger.js')
    const configPath = path2.join(TNQR_DIR, 'config.json')
    fs2.mkdirSync(TNQR_DIR, { recursive: true })
    const existing = loadConfig()
    existing.anthropicApiKey = key
    fs2.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf8')
    console.log(`\n✅ API key saved to ${configPath}`)
    console.log('   Run tnqr --help to get started.\n')
    process.exit(0)
  }
  if (args.includes('--list-devices')) {
    console.log('\nSupported NUX MightyAmp devices:\n')
    for (const [id, config] of Object.entries(DEVICES)) {
      console.log(`  ${id.padEnd(14)} ${config.displayName}  (${config.format}, ${config.payloadBytes} bytes)`)
    }
    console.log(`  ${'all'.padEnd(14)} Generate for every device`)
    console.log()
    process.exit(0)
  }

  // --list-runs [N] — show recent runs
  const listRunsIdx = args.findIndex(a => a === '--list-runs')
  if (listRunsIdx !== -1) {
    const limitArg = args[listRunsIdx + 1]
    const limit = limitArg && !limitArg.startsWith('-') ? parseInt(limitArg, 10) || 10 : 10
    const runs = listRuns(limit)
    if (runs.length === 0) {
      console.log('\nNo runs found in ~/.toneai-nux-qr/logs/\n')
      process.exit(0)
    }
    console.log('\nRecent runs:\n')
    const statusIcon = { success: '✅', partial: '⚠️', failed: '❌', unknown: '?' }
    for (const r of runs) {
      const failStr = r.failed > 0 ? ` (${r.failed} failed)` : ''
      console.log(`  ${String(r.index).padStart(2)}  ${statusIcon[r.status]}  ${r.date}  ${r.context}  [${r.succeeded}/${r.totalTracks}]${failStr}`)
    }
    console.log(`\nResume with: tnqr -r <number>  |  tnqr -r  (most recent failed)  |  tnqr -r all\n`)
    process.exit(0)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function parseStr(long: string, short: string, envVar: string): string | undefined {
    const idx = args.findIndex(a => a === long || a === short)
    if (idx !== -1) {
      const val = args[idx + 1]
      if (!val || val.startsWith('-')) { console.error(`Error: ${long} requires a value.`); process.exit(1) }
      args.splice(idx, 2)
      return val
    }
    return process.env[envVar]
  }

  function parseBool(long: string, short: string, envVar: string): boolean {
    const idx = args.findIndex(a => a === long || a === short)
    if (idx !== -1) { args.splice(idx, 1); return true }
    const env = process.env[envVar]
    return env === '1' || env === 'true'
  }

  function parseBoolNoEnv(long: string, short: string): boolean {
    const idx = args.findIndex(a => a === long || a === short)
    if (idx !== -1) { args.splice(idx, 1); return true }
    return false
  }

  function parseStrNoEnv(long: string, short: string): string | undefined {
    const idx = args.findIndex(a => a === long || a === short)
    if (idx !== -1) {
      const val = args[idx + 1]
      if (!val || val.startsWith('-')) { console.error(`Error: ${long} requires a value.`); process.exit(1) }
      args.splice(idx, 2)
      return val
    }
    return undefined
  }

  function parseInt_(long: string, short: string, envVar: string, defaultVal: number, max: number): number {
    const raw = parseStr(long, short, envVar)
    if (raw === undefined) return defaultVal
    const val = parseInt(raw, 10)
    if (isNaN(val) || val < 1) { console.error(`Error: ${long} must be a positive integer.`); process.exit(1) }
    if (val > max) { console.error(`Error: ${long} cannot exceed ${max}.`); process.exit(1) }
    return val
  }

  // ── Parse all flags ───────────────────────────────────────────────────────
  const query_flag   = parseStr('--query',        '-q', 'TNQR_QUERY')
  const instrumentRaw = parseStr('--instrument',  '-I', 'TNQR_INSTRUMENT') ?? 'guitar'
  const instrument = (['guitar', 'bass'].includes(instrumentRaw.toLowerCase())
    ? instrumentRaw.toLowerCase()
    : (() => { console.error(`Error: --instrument must be "guitar" or "bass".`); process.exit(1) })()) as 'guitar' | 'bass'
  const silent      = parseBool('--silent',       '-s', 'TNQR_SILENT')
  const concurrency = parseInt_('--concurrency',  '-c', 'TNQR_CONCURRENCY',  DEFAULT_CONCURRENCY, MAX_CONCURRENCY)
  const skipConfirm = parseBool('--yes',           '-y', 'TNQR_YES')
  const ceiling     = parseInt_('--ceiling',       '-l', 'TNQR_CEILING',      DEFAULT_CEILING,     HARD_CEILING)
  const createZip   = parseBool('--zip',           '-z', 'TNQR_ZIP')
  const dryRun      = parseBoolNoEnv('--dry-run',  '-n')

  // --resume / -r: optional value (no arg = most recent failed, number = Nth, "all" = all failed)
  let resumeFlag = false
  let resumeArg: string | undefined
  const resumeIdx = args.findIndex(a => a === '--resume' || a === '-r')
  if (resumeIdx !== -1) {
    resumeFlag = true
    const next = args[resumeIdx + 1]
    if (next && !next.startsWith('-')) {
      resumeArg = next
      args.splice(resumeIdx, 2)
    } else {
      args.splice(resumeIdx, 1)
    }
  }
  const logPath     = parseStr('--log',             '-L', 'TNQR_LOG')
  const logFormatRaw = parseStr('--log-format',     '--log-format', 'TNQR_LOG_FORMAT') ?? 'jsonl'
  const logFormat: LogFormat = logFormatRaw === 'text' ? 'text' : 'jsonl'
  const outputBase  = parseStr('--output',         '-o', 'TNQR_OUTPUT')    ?? 'output'
  const deviceFlag  = parseStr('--device',         '-d', 'TNQR_DEVICE')
  const pickup      = parseStr('--pickup',         '-p', 'TNQR_PICKUP')
  const apiKeyArg   = parseStr('--api-key',        '-k', 'TNQR_ANTHROPIC_API_KEY')
  const toneModel   = parseStr('--model',          '-m', 'TNQR_MODEL')     ?? 'claude-sonnet-4-6'
  const intentModel = parseStr('--intent-model',   '-i', 'TNQR_INTENT_MODEL') ?? 'claude-haiku-4-5-20251001'
  const folderFormat = parseStr('--folder-format', '-F', 'TNQR_FOLDER_FORMAT') ?? DEFAULT_FOLDER_FORMAT
  const fileFormat   = parseStr('--file-format',   '-f', 'TNQR_FILE_FORMAT')   ?? DEFAULT_FILE_FORMAT

  // ── Positional args ───────────────────────────────────────────────────────
  const [positionalQuery, positionalDevice] = args

  // Query priority: --query/-q > positional arg > TNQR_QUERY env var
  const query = query_flag || positionalQuery

  if (!query && !resumeFlag) {
    console.error('Error: query is required. Use -q/--query or pass as first positional argument.\n')
    printHelp()
    process.exit(1)
  }

  // Device priority: --device/-d > positional arg > plugpro default
  // If --query was used, positionalQuery is the device (no query consumed from positionals)
  const positionalDeviceResolved = query_flag ? positionalQuery : positionalDevice
  const rawDevice = deviceFlag || positionalDeviceResolved || 'plugpro'
  const matched = fuzzyMatchDevice(rawDevice)
  let devices: DeviceType[]

  if (matched === 'all') {
    devices = ALL_DEVICES
  } else if (matched) {
    if (matched !== rawDevice.toLowerCase().replace(/\s+/g, '')) {
      console.log(`ℹ️  Device "${rawDevice}" → ${DEVICES[matched].displayName} (${matched})`)
    }
    devices = [matched]
  } else {
    console.error(`Error: unknown device "${rawDevice}"`)
    console.error(`Valid options: ${ALL_DEVICES.join(', ')}, all`)
    console.error(`Or use a natural name like "plug pro", "mighty air v2", "lite bt"`)
    process.exit(1)
  }

  // Resolve API key — --api-key > TNQR_ANTHROPIC_API_KEY > ANTHROPIC_API_KEY > config file > wizard
  const apiKey = await resolveApiKey(apiKeyArg ?? process.env.ANTHROPIC_API_KEY)
  const client = new Anthropic({ apiKey })

  // ── Resume mode — restore everything from log file ────────────────────────
  if (resumeFlag) {
    const logPaths = resolveRunPath(resumeArg)

    for (const logFile of logPaths) {
      let parsed: Awaited<ReturnType<typeof parseLog>>
      try {
        parsed = parseLog(logFile)
      } catch (err) {
        console.error(`Error parsing log file: ${err instanceof Error ? err.message : err}`)
        continue
      }

      const { meta, tracks: logTracks, summary } = parsed
      const failedTracks = logTracks.filter(t => t.status === 'failed')

      if (failedTracks.length === 0) {
        console.log(`\n✅ No failed tracks in ${meta.context} — skipping.`)
        continue
      }

      console.log(`\n🔄 Resuming: ${meta.context}`)
      console.log(`   ${failedTracks.length} failed track${failedTracks.length === 1 ? '' : 's'} to retry: ${failedTracks.map(t => t.title).join(', ')}`)
      console.log(`   Output dir: ${summary?.outputDir ?? 'unknown'}`)
      console.log()

      const resumeOutputDir = summary?.outputDir ?? path.join(outputBase, slugify(meta.context).slice(0, 60))
      const resumeDevices = meta.devices as DeviceType[]
      const resumeInstrument = (meta.instrument ?? 'guitar') as 'guitar' | 'bass'
      const resumeToneModel = toneModel !== 'claude-sonnet-4-6' ? toneModel : meta.toneModel
      const resumePickup = pickup ?? meta.pickup
      const runStart = Date.now()

      const resumeLogger = new RunLogger(undefined, logFormat, {
        ...meta,
        totalTracks: failedTracks.length,
        startedAt: new Date().toISOString(),
      })

      for (const device of resumeDevices) {
        const deviceInfo = DEVICES[device as DeviceType]
        if (!deviceInfo) continue
        if (!silent) console.log(`\n🎸 Retrying for: ${deviceInfo.displayName} (${device})`)

        const outDir = path.join(resumeOutputDir, device)
        fs.mkdirSync(outDir, { recursive: true })

        const progress = new ProgressDisplay(failedTracks.map(t => t.title), silent)
        progress.start()

        const chunks: typeof failedTracks[] = []
        for (let i = 0; i < failedTracks.length; i += concurrency) {
          chunks.push(failedTracks.slice(i, i + concurrency))
        }

        let trackIndex = 0
        for (const chunk of chunks) {
          await Promise.allSettled(
            chunk.map(async (t, chunkIdx) => {
              const i = trackIndex + chunkIdx
              const trackNum = meta.totalTracks === 1 ? '' : pad(t.trackNumber, meta.totalTracks)
              const resumeAlbum = extractAlbum(meta.context)
              const trackStart = Date.now()
              const trackStarted = new Date().toISOString()

              progress.setQuerying(i)
              try {
                const { params, promptSent, rawToolInput, nudgeRequired, nudgeElapsedMs } = await generateToneForSong(
                  client, t.title, meta.artist, meta.context,
                  device as DeviceType, resumePickup, t.note, resumeToneModel, resumeInstrument
                )
                const fileVars = { artist: meta.artist, album: resumeAlbum, track: trackNum, song: t.title, preset: params.preset_name, device: device as string }
                const filename = `${formatTemplate(fileFormat, fileVars)}.png`
                const outPath = path.join(outDir, filename)
                const qrRaw = await generateQRPng(params)
                const { buildQRString } = await import('./encoder.js')
                const qrString = buildQRString(params)
                const png = await decorateQR(qrRaw, meta.artist, t.title, device, deviceInfo.displayName)
                fs.writeFileSync(outPath, png)
                const elapsed = Date.now() - trackStart
                progress.setDone(i, params.preset_name, elapsed)
                resumeLogger.logTrack({ trackNumber: t.trackNumber, title: t.title, note: t.note, device, status: 'success', presetName: params.preset_name, qrString, promptSent, rawToolInput, coercedParams: params, nudgeRequired, nudgeElapsedMs, elapsedMs: elapsed, startedAt: trackStarted, completedAt: new Date().toISOString() })
              } catch (err) {
                const elapsed = Date.now() - trackStart
                const errMsg = err instanceof Error ? err.message : String(err)
                progress.setFailed(i, errMsg, elapsed)
                resumeLogger.logTrack({ trackNumber: t.trackNumber, title: t.title, note: t.note, device, status: 'failed', error: errMsg, elapsedMs: elapsed, startedAt: trackStarted, completedAt: new Date().toISOString() })
              }
            })
          )
          trackIndex += chunk.length
        }
        progress.stop()
      }

      resumeLogger.flush({ succeeded: resumeLogger.trackCount('success'), failed: resumeLogger.trackCount('failed'), totalElapsedMs: Date.now() - runStart, outputDir: resumeOutputDir, completedAt: new Date().toISOString() })
      if (!silent) {
        console.log(`\n✅ Resume complete! Output in: ${resumeOutputDir}/`)
        console.log(`   📋 Log saved: ${resumeLogger.path}\n`)
      }
    }
    process.exit(0)
  }

  // 1. Resolve intent — single song, album, live set, vibe, etc.
  console.log(`\n🔍 Resolving: "${query}"...`)
  let artist: string, context: string, tracks: { title: string; note?: string }[]
  try {
    ;({ artist, context, tracks } = await resolveIntent(client, query!, intentModel))
  } catch (err) {
    console.error(`Error resolving query: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // ── Dry run — show tracklist and exit ────────────────────────────────────
  if (dryRun) {
    console.log(`\n📀 ${context}`)
    console.log(`   ${tracks.length} track${tracks.length === 1 ? '' : 's'}:\n`)
    tracks.forEach((t, i) => {
      const note = t.note ? `  (${t.note})` : ''
      console.log(`   ${pad(i + 1, tracks.length)}. ${t.title}${note}`)
    })
    console.log(`\n   ${tracks.length * devices.length} QR code${tracks.length * devices.length === 1 ? '' : 's'} would be generated across ${devices.length} device${devices.length === 1 ? '' : 's'}.`)
    console.log(`   Run without --dry-run to generate.\n`)
    process.exit(0)
  }

  console.log(`\n📀 ${context}`)
  console.log(`   ${tracks.length} track${tracks.length === 1 ? '' : 's'}: ${tracks.map(t => t.title).join(', ')}`)
  if (instrument === 'bass') console.log(`   🎸 Instrument: Bass`)
  if (pickup) console.log(`   🎸 Pickup: ${pickup}`)

  // Ceiling check
  if (tracks.length > HARD_CEILING) {
    console.error(`\nError: ${tracks.length} tracks resolved — exceeds the hard maximum of ${HARD_CEILING}. Refine your query.`)
    process.exit(1)
  }

  if (tracks.length > ceiling) {
    if (skipConfirm) {
      console.log(`\n⚠️  ${tracks.length} tracks resolved (ceiling: ${ceiling}) — proceeding with --yes`)
    } else {
      const totalQrs = tracks.length * devices.length
      const proceed = await confirm(`\n⚠️  ${tracks.length} tracks resolved (ceiling: ${ceiling}). This will generate ${totalQrs} QR code${totalQrs === 1 ? '' : 's'}. Continue? [y/N] `)
      if (!proceed) {
        console.log('Aborted. Refine your query or raise --ceiling.')
        process.exit(0)
      }
    }
  }

  console.log()

  // Build folder path from format template
  const album = extractAlbum(context)
  const folderVars = { artist, album, device: devices[0] }
  const contextSlug = formatTemplate(folderFormat, folderVars)
  const zip = createZip ? new JSZip() : null
  const runStart = Date.now()

  // Instantiate logger
  const logger = new RunLogger(logPath, logFormat, {
    version: '1.0.0',
    query: query!,
    context,
    artist,
    devices: devices as string[],
    instrument,
    pickup,
    concurrency,
    toneModel,
    intentModel,
    totalTracks: tracks.length,
    startedAt: new Date().toISOString(),
  })

  // Graceful Ctrl+C — finish the current chunk then stop cleanly
  let aborted = false
  let activeProgress: InstanceType<typeof ProgressDisplay> | null = null
  process.once('SIGINT', () => {
    aborted = true
    if (activeProgress) {
      activeProgress.stop()
      const outDir = path.join(outputBase, contextSlug, devices[0])
      const done = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(f => f.endsWith('.png')).length : 0
      console.log(`\n⚠️  Cancelled. ${done}/${tracks.length} QR codes saved to: ${outputBase}/${contextSlug}/\n`)
    } else {
      console.log('\n⚠️  Cancelled.\n')
    }
    process.exit(0)
  })

  // 2. Generate QR per song per device — concurrent with progress display
  for (const device of devices) {
    if (aborted) break
    const deviceInfo = DEVICES[device]
    if (!silent) console.log(`\n🎸 Generating for: ${deviceInfo.displayName} (${device})`)

    const outDir = path.join(outputBase, contextSlug, device)
    fs.mkdirSync(outDir, { recursive: true })

    // ── Retry mode: find tracks missing a PNG in the output dir ─────────────
    let tracksToGenerate = tracks
    if (retryDir) {
      const retryDeviceDir = path.join(retryDir, device)
      tracksToGenerate = tracks.filter((t, i) => {
        // Look for any PNG starting with the track number prefix
        const prefix = tracks.length === 1 ? slugify(t.title) : `${pad(i + 1, tracks.length)}-${slugify(t.title)}`
        const existing = fs.existsSync(retryDeviceDir)
          ? fs.readdirSync(retryDeviceDir).some(f => f.startsWith(prefix))
          : false
        return !existing
      })
      if (tracksToGenerate.length === 0) {
        console.log(`   ✓ All tracks already complete for ${deviceInfo.displayName} — nothing to retry.`)
        continue
      }
      console.log(`   Retrying ${tracksToGenerate.length} failed track${tracksToGenerate.length === 1 ? '' : 's'}...`)
    }

    const progress = new ProgressDisplay(tracksToGenerate.map(t => t.title), silent)
    activeProgress = progress
    progress.start()

    const chunks: typeof tracksToGenerate[] = []
    for (let i = 0; i < tracksToGenerate.length; i += concurrency) {
      chunks.push(tracksToGenerate.slice(i, i + concurrency))
    }

    let trackIndex = 0
    for (const chunk of chunks) {
      if (aborted) break
      await Promise.allSettled(
        chunk.map(async ({ title, note }, chunkIdx) => {
          if (aborted) return
          const globalIdx = tracks.findIndex(t => t.title === title)
          const i = trackIndex + chunkIdx
          const trackNum = tracks.length === 1 ? '' : pad(globalIdx + 1, tracks.length)
          const trackStart = Date.now()

          progress.setQuerying(i)
          const trackStarted = new Date().toISOString()
          try {
            const { params, promptSent, rawToolInput, nudgeRequired, nudgeElapsedMs } = await generateToneForSong(client, title, artist, context, device, pickup, note, toneModel, instrument)
            const fileVars = { artist, album, track: trackNum, song: title, preset: params.preset_name, device }
            const filename = `${formatTemplate(fileFormat, fileVars)}.png`
            const outPath = path.join(outDir, filename)
            const qrRaw = await generateQRPng(params)
            const { buildQRString } = await import('./encoder.js')
            const qrString = buildQRString(params)
            const png = await decorateQR(qrRaw, artist, title, device, deviceInfo.displayName)
            fs.writeFileSync(outPath, png)
            if (zip) zip.folder(device)!.file(filename, png)
            const elapsed = Date.now() - trackStart
            progress.setDone(i, params.preset_name, elapsed)
            logger.logTrack({
              trackNumber: globalIdx + 1,
              title,
              note,
              device,
              status: 'success',
              presetName: params.preset_name,
              qrString,
              promptSent,
              rawToolInput,
              coercedParams: params,
              nudgeRequired,
              nudgeElapsedMs,
              elapsedMs: elapsed,
              startedAt: trackStarted,
              completedAt: new Date().toISOString(),
            })
          } catch (err) {
            const elapsed = Date.now() - trackStart
            const errMsg = err instanceof Error ? err.message : String(err)
            progress.setFailed(i, errMsg, elapsed)
            logger.logTrack({
              trackNumber: globalIdx + 1,
              title,
              note,
              device,
              status: 'failed',
              error: errMsg,
              elapsedMs: elapsed,
              startedAt: trackStarted,
              completedAt: new Date().toISOString(),
            })
          }
        })
      )
      trackIndex += chunk.length
    }

    activeProgress = null
    progress.stop()
  }

  // 3. Write zip if requested
  let zipPath: string | undefined
  if (zip) {
    zipPath = path.join(outputBase, `${contextSlug}.zip`)
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    fs.writeFileSync(zipPath, zipBuffer)
    if (!silent) console.log(`\n📦 Zip saved: ${zipPath}`)
  }

  // 4. Flush log
  const finalOutDir = path.join(outputBase, contextSlug)
  logger.flush({
    succeeded: logger.trackCount('success'),
    failed: logger.trackCount('failed'),
    totalElapsedMs: Date.now() - runStart,
    outputDir: finalOutDir,
    zipPath,
    completedAt: new Date().toISOString(),
  })
  if (!silent) console.log(`   📋 Log saved: ${logger.path}`)

  if (!silent) console.log(`\n✅ Done! Output in: ${outputBase}/${contextSlug}/\n`)
  else console.log(`${outputBase}/${contextSlug}/`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
