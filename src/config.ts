import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { TNQR_DIR } from './logger.js'

const CONFIG_DIR  = TNQR_DIR
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// Migrate from old ~/.config/toneai-nux-qr/ location if it exists
const OLD_CONFIG_FILE = path.join(os.homedir(), '.config', 'toneai-nux-qr', 'config.json')
function migrateIfNeeded(): void {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(OLD_CONFIG_FILE)) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      fs.copyFileSync(OLD_CONFIG_FILE, CONFIG_FILE)
    } catch { /* non-fatal */ }
  }
}

interface Config {
  anthropicApiKey?: string
}

export function loadConfig(): Config {
  migrateIfNeeded()
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config
    }
  } catch {
    // Malformed config — treat as empty
  }
  return {}
}

function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}

function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

export async function runFirstTimeSetup(): Promise<string> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Welcome to toneai-nux-qr (tnqr)                 ║
║   AI-generated NUX MightyAmp tones for any song or album  ║
╚════════════════════════════════════════════════════════════╝

To generate tones, tnqr needs an Anthropic API key.
Anthropic offers a free tier — no credit card required to start.

Steps:
  1. Go to https://console.anthropic.com
  2. Sign up for a free account
  3. Go to API Keys → Create Key
  4. Copy and paste your key below

Your key will be saved to: ${CONFIG_FILE}
It will never leave your machine except to call the Anthropic API.
`)

  while (true) {
    const key = await prompt('Paste your Anthropic API key (sk-ant-...): ')

    if (!key) {
      console.log('No key entered. You can also set TNQR_ANTHROPIC_API_KEY in your environment.')
      process.exit(1)
    }

    if (!key.startsWith('sk-ant-')) {
      console.log('That doesn\'t look like a valid Anthropic API key (should start with sk-ant-).')
      const retry = await prompt('Try again? [y/N] ')
      if (retry.toLowerCase() !== 'y') process.exit(1)
      continue
    }

    const config = loadConfig()
    config.anthropicApiKey = key
    saveConfig(config)

    console.log(`\n✅ API key saved to ${CONFIG_FILE}`)
    console.log('You\'re all set! Run tnqr again to generate your first tones.\n')
    return key
  }
}

// Resolve API key with full priority chain:
// 1. Explicit CLI arg
// 2. TNQR_ANTHROPIC_API_KEY env var
// 3. ANTHROPIC_API_KEY env var (standard Anthropic SDK convention)
// 4. Stored config file
// 5. First-run wizard
export async function resolveApiKey(cliArg?: string): Promise<string> {
  if (cliArg) return cliArg
  if (process.env.TNQR_ANTHROPIC_API_KEY) return process.env.TNQR_ANTHROPIC_API_KEY
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY

  const config = loadConfig()
  if (config.anthropicApiKey) return config.anthropicApiKey

  // Nothing found — run first-time setup wizard
  return runFirstTimeSetup()
}
