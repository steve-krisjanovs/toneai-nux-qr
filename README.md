# toneai-nux-qr

AI-generated NUX MightyAmp QR tone presets for any album, song, or artist.

Describe what you want — a full album, a single song, a live set, a vibe — and get a folder of scannable QR codes dialled in to match each track's guitar or bass tone. Powered by Claude with per-recording web search for accurate gear research.

[![npm](https://img.shields.io/npm/v/toneai-nux-qr)](https://www.npmjs.com/package/toneai-nux-qr)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Install

**Windows** — download and run the installer from [Releases](https://github.com/steve-krisjanovs/toneai-nux-qr/releases)

**macOS (Homebrew):**
```bash
brew tap steve-krisjanovs/tools
brew install toneai-nux-qr
```

**macOS (pkg):** Download `tnqr-macos.pkg` from [Releases](https://github.com/steve-krisjanovs/toneai-nux-qr/releases).
> Right-click → Open the first time to bypass Gatekeeper.

**Linux (Debian/Ubuntu):**
```bash
sudo dpkg -i tnqr_<version>_amd64.deb
```

**Linux (Fedora/RHEL):**
```bash
sudo rpm -i toneai-nux-qr-<version>-1.x86_64.rpm
```

**npm / Node.js 18+:**
```bash
npm install -g toneai-nux-qr
```

**Bun:**
```bash
bun install -g toneai-nux-qr
```

On first run, `tnqr` will walk you through setting up your Anthropic API key. Your key is stored in `~/.toneai-nux-qr/config.json` and never leaves your machine except to call the Anthropic API.

You can also set it directly:

```bash
tnqr set-key sk-ant-...
```

Get a free key at [console.anthropic.com](https://console.anthropic.com) — no credit card required to start.

---

## Quick Start

```bash
# First time setup — save your API key
tnqr set-key sk-ant-...

# Full album — defaults to Mighty Plug Pro
tnqr "led zeppelin physical graffiti"

# Single song
tnqr "comfortably numb"

# Live recording
tnqr "pink floyd pulse live" -d mightyair_v2

# All devices
tnqr "metallica master of puppets" -d all

# With pickup context
tnqr "srv texas flood" -p "strat middle single coil, vol full, tone 7"

# Bass
tnqr "primus sailing the seas of cheese" -I bass

# Dry run — see what would be generated without burning API credits
tnqr "led zeppelin physical graffiti" --dry-run

# List all supported devices
tnqr --list-devices
```

---

## Options

| Short | Long | Env Var | Description | Default |
|---|---|---|---|---|
| — | `set-key <key>` | — | Save Anthropic API key to config file | — |
| `-q` | `--query <text>` | `TNQR_QUERY` | What to generate tones for | — |
| `-d` | `--device <id>` | `TNQR_DEVICE` | Target NUX device | `plugpro` |
| `-I` | `--instrument` | `TNQR_INSTRUMENT` | `guitar` or `bass` | `guitar` |
| `-o` | `--output <path>` | `TNQR_OUTPUT` | Output directory | `./output` |
| `-k` | `--api-key <key>` | `TNQR_ANTHROPIC_API_KEY` | Anthropic API key | — |
| `-p` | `--pickup <desc>` | `TNQR_PICKUP` | Instrument signal context (free text) | — |
| `-z` | `--zip` | `TNQR_ZIP` | Also create a zip archive | `false` |
| `-l` | `--ceiling <n>` | `TNQR_CEILING` | Max tracks before confirmation prompt | `25` |
| `-c` | `--concurrency <n>` | `TNQR_CONCURRENCY` | Parallel track generation (max 25) | `5` |
| `-y` | `--yes` | `TNQR_YES` | Skip confirmation prompt | `false` |
| `-s` | `--silent` | `TNQR_SILENT` | Suppress progress display | `false` |
| `-n` | `--dry-run` | — | Show tracklist without generating | `false` |
| `-r` | `--resume [N\|all]` | — | Resume failed tracks (see below) | — |
| `-L` | `--log <path>` | `TNQR_LOG` | Log file path | `~/.toneai-nux-qr/logs/` |
| — | `--log-format` | `TNQR_LOG_FORMAT` | `jsonl` or `text` | `jsonl` |
| `-F` | `--folder-format` | `TNQR_FOLDER_FORMAT` | Folder name format (tokens below) | `{artist}-{album}` |
| `-f` | `--file-format` | `TNQR_FILE_FORMAT` | File name format (tokens below) | `{track}-{song}` |
| `-m` | `--model <model>` | `TNQR_MODEL` | Tone generation model | `claude-sonnet-4-6` |
| `-i` | `--intent-model` | `TNQR_INTENT_MODEL` | Intent resolution model | `claude-haiku-4-5-20251001` |
| — | `--list-devices` | — | List all supported devices and exit | — |
| — | `--list-runs [N]` | — | Show recent runs (default: 10) | — |
| `-v` | `--version` | — | Show version and exit | — |
| `-h` | `--help` | — | Show help | — |

### `--pickup` examples

The pickup flag accepts free text describing your full signal context:

```bash
-p "Les Paul bridge humbucker, vol 7, tone 8"
-p "Strat neck single coil, vol full, tone rolled to 5"
-p "Tele bridge, vol 10, tone 10, TS808 always on"
-p "Precision bass, flatwounds, vol 7"
-p "Active EMG 81 bridge, vol full"
```

When omitted, the AI researches the specific guitar and pickup used on each recording.

---

## Output Format

```
output/
  led-zeppelin-physical-graffiti/
    plugpro/
      01-custard-pie.png
      02-the-rover.png
      ...
```

Folder and file names are controlled by `--folder-format` and `--file-format` using token templates:

| Token | Description |
|---|---|
| `{artist}` | Artist name |
| `{album}` | Album or context name |
| `{track}` | Zero-padded track number (omitted for single songs) |
| `{song}` | Song title |
| `{preset}` | AI-generated preset name |
| `{device}` | Device ID |

Empty tokens are dropped cleanly — no double dashes or empty path segments.

```bash
# Subfolders by artist then album
tnqr "physical graffiti" -F "{artist}/{album}"

# Device-first layout
tnqr "physical graffiti" -d all -F "{device}/{artist}-{album}"

# Include preset name in filename
tnqr "kashmir" -f "{track}-{song}-{preset}"
```

Each PNG is a decorated QR code with the app name and version in the header, and the artist, song, and device in the footer. Pro format devices (Plug Pro, Space, Lite MkII, 8BT MkII) embed the preset name directly in the QR payload.

---

## Resuming Failed Runs

Every run writes a log to `~/.toneai-nux-qr/logs/`. If tracks fail, resume without needing to find or type any file path:

```bash
# Resume most recent failed run
tnqr -r

# Resume 3rd most recent run
tnqr -r 3

# Resume all runs with failures
tnqr -r all

# See recent runs and their status
tnqr --list-runs
```

---

## Devices

| ID | Device | Format |
|---|---|---|
| `plugpro` | Mighty Plug Pro | Pro (113 bytes) |
| `space` | Mighty Space | Pro (113 bytes) |
| `litemk2` | Mighty Lite MkII | Pro (113 bytes) |
| `8btmk2` | Mighty 8BT MkII | Pro (113 bytes) |
| `plugair_v1` | Mighty Plug (v1) | Standard (40 bytes) |
| `plugair_v2` | Mighty Plug (v2) | Standard (40 bytes) |
| `mightyair_v1` | Mighty Air (v1) | Standard (40 bytes) |
| `mightyair_v2` | Mighty Air (v2) | Standard (40 bytes) |
| `lite` | Mighty Lite BT | Standard (40 bytes) |
| `8bt` | Mighty 8BT | Standard (40 bytes) |
| `2040bt` | Mighty 20/40BT | Standard (40 bytes) |
| `all` | All of the above | — |

Device names are fuzzy-matched — `"plug pro"`, `"mighty air v2"`, `"lite bt"` all work.

---

## Shell Profile Setup

Set your frequently-used options once:

```bash
# ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish
export TNQR_ANTHROPIC_API_KEY=sk-ant-...
export TNQR_DEVICE=mightyair_v2
export TNQR_PICKUP="Les Paul bridge humbucker, vol 7, tone 8"
```

Then just:

```bash
tnqr "led zeppelin physical graffiti"
```

---

## Requirements

**Standalone installers (Windows/macOS/Linux)** — nothing required. The binary is self-contained with Bun bundled in.

**npm install:** Node.js 18+

**bun install:** Bun

All distributions require an Anthropic API key — [get one free at console.anthropic.com](https://console.anthropic.com)

---

## Credits

QR format reverse-engineered from the NUX MightyAmp ecosystem. Special thanks to [tuntorius](https://github.com/tuntorius) for the open-source [mightier_amp](https://github.com/tuntorius/mightier_amp) app, which was an invaluable reference for the QR encoding format.
