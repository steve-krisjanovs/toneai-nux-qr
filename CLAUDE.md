# toneai-nux-qr — Claude Code Context

## What this is

A Node.js/TypeScript CLI npm package (`tnqr`) that generates NUX MightyAmp QR code tone presets for any album, song, live set, or artist vibe. Uses Claude (Sonnet for tone generation, Haiku for intent resolution) with native web search to research per-recording gear details before generating each preset.

Companion to the web app at https://github.com/steve-krisjanovs/mighty-ai-qr-web — same QR encoding logic, same AI system prompt, but optimised for bulk album-scale generation rather than interactive single-tone refinement.

## Architecture

```
src/
  cli.ts        — tnqr binary entrypoint, all arg parsing, generation loop, progress display
  ai.ts         — resolveIntent() and generateToneForSong() — all Anthropic API calls
  encoder.ts    — NUX QR binary payload encoding + coerceParams() for LLM output normalisation
  nux.ts        — device types, configs, and preset parameter interfaces
  decorate.ts   — PNG decoration (header/footer) using @napi-rs/canvas
  progress.ts   — ProgressDisplay class, TTY-aware (fancy redraw vs plain line output)
  logger.ts     — RunLogger class, JSONL run logging, parseLog()/listRuns()/resolveRunPath() for resume
  config.ts     — API key resolution, first-run wizard, config stored at ~/.toneai-nux-qr/
  index.ts      — public API exports for programmatic use
```

## Key design decisions

**Bun for binary compilation** — `bun build src/cli.ts --compile` produces a standalone binary with no Node/Bun runtime required on the target machine. Used for installer distributions. The npm package ships compiled JS via `tsc` for users who install via `npm install -g` and have Node 18+. The `bun install -g` path runs natively under Bun.

**Two-model approach** — Haiku for intent resolution (cheap, fast, just needs to identify tracks), Sonnet for tone generation (needs quality reasoning about gear, amp models, effects).

**Native web search** — uses `web_search_20250305` Anthropic tool. Web search results come back inline as `web_search_tool_result` blocks, not as a `tool_use` requiring a `tool_result` response. However in some cases `web_search` CAN appear as a `tool_use` block — we handle both cases by feeding back tool_results for any non-generateQR tool_use blocks.

**Nudge pattern** — if the model stops without calling `generateQR` (usually after web search returns results and the model responds conversationally), we send one follow-up message explicitly asking it to call the tool. `nudgeRequired` is logged per track.

**coerceParams()** — normalises raw LLM tool call output into valid `ProPresetParams`. LLMs occasionally use wrong field names or omit required fields. Coercion happens at the boundary before encoding.

**Device families:**
- Pro format (113-byte payload): `plugpro`, `space`, `litemk2`, `8btmk2` — full feature set, preset name embedded in QR
- Standard format (40-byte payload): `plugair_v1/v2`, `mightyair_v1/v2`, `lite`, `8bt`, `2040bt` — different amp/effect IDs per device, no preset name in payload

## NUX QR format

`nux://MightyAmp:<base64>` where base64 decodes to:
- Byte 0: deviceQRId
- Byte 1: deviceQRVersion
- Bytes 2+: payload (113 bytes for pro, 40 bytes for standard)

Pro payload byte layout is documented in `encoder.ts`. Standard device layouts vary — see the per-device build functions in `encoder.ts`.

## AI system prompt

The full system prompt in `ai.ts` (`TONE_SYSTEM_PROMPT`) contains:
- All Pro device amp/cabinet/EFX/mod/delay/reverb IDs with real-world equivalents
- Per-standard-device amp and effect IDs (different from Pro)
- Device-specific constraints (Lite single ambience slot, 8BT separate delay+reverb, 2040BT wah, no cabinet for Lite/8BT/2040BT)
- Bass tone rules (BassMate amp, TR212Pro cab, no noise gate, compressor required)
- Pickup/signal context injection per track
- EQ availability per device family
- Tone vocabulary guide and EFX stacking strategy

**Do not simplify or shorten the system prompt.** The per-device detail is what makes standard device presets correct — without it the AI uses Pro device IDs on standard devices which produces wrong binary payloads.

## File locations

```
~/.toneai-nux-qr/
  config.json       — stores Anthropic API key
  logs/
    <timestamp>-<query>.jsonl   — one log per run
```

Log format is JSONL — one JSON object per line:
- `{ type: "run_start", ...RunMeta }` — query, devices, models, pickup, instrument, etc.
- `{ type: "track", ...TrackLog }` — per-track result with prompt sent, raw AI tool input, coerced params, QR string, nudge info, elapsed time
- `{ type: "run_end", ...RunSummary }` — success/fail counts, output dir, total elapsed

## Post-clone setup

On a fresh machine after cloning, remind the user to:
1. Set the API key: `tnqr set-key <key>` — the key is stored on the MacBook Air in `~/.toneai-nux-qr/config.json`
2. Set the default output dir: add `export TNQR_OUTPUT=~/Documents/tnqr` (or equivalent) to the shell profile (`~/.zshrc`, `~/.config/fish/config.fish`, etc.)

## Common commands

```bash
# Dev
bun run src/cli.ts --help          # run TypeScript directly, no compile step
npm run build                       # tsc → dist/
bun build src/cli.ts --compile --outfile tnqr   # standalone binary

# Setup
./tnqr set-key sk-ant-...          # save API key to ~/.toneai-nux-qr/config.json

# Test
./tnqr -q "kashmir led zeppelin" -d plugpro -k <key>
./tnqr --list-devices
./tnqr -q "led zeppelin physical graffiti" --dry-run

# Resume most recent failed run
./tnqr -r
# Resume 3rd most recent
./tnqr -r 3
# List recent runs
./tnqr --list-runs
```

## Dependencies

- `@anthropic-ai/sdk` — Anthropic API client
- `qrcode` — QR code generation to PNG buffer
- `@napi-rs/canvas` — PNG composition for decorated QR images (chosen over sharp because sharp native binaries can't be bundled into Bun SEA)
- `jszip` — optional zip archive creation

## Versioning

`VERSION.txt` is the source of truth. `package.json` version must match. Both `cli.ts` and `decorate.ts` read the version from `package.json` at build time (via JSON import). When bumping the version, update both `VERSION.txt` and `package.json`.

**Output naming** is controlled by `--folder-format` (-F) and `--file-format` (-f) using Sonarr-style token templates: `{artist}`, `{album}`, `{track}`, `{song}`, `{preset}`, `{device}`. Empty tokens collapse cleanly. Single tracks omit `{track}`.

## Release pipeline

GitHub Actions on `v*` tags:
1. Build binaries for all 4 platforms via `bun build --compile --target=<platform>`
2. Build installers: Inno Setup (.exe), pkgbuild (.pkg), dpkg (.deb), rpmbuild (.rpm)
3. Create GitHub release with all artifacts
4. Auto-update `steve-krisjanovs/homebrew-tools` Formula via `HOMEBREW_TAP_TOKEN` secret

## Related

- `mighty-ai-qr-web` — the web app this was extracted from. Same QR encoding, same system prompt, same Anthropic native web search approach. Use the web app for interactive single-tone refinement; use tnqr for bulk album generation.
- `winrawprinter` — another npm module by the same author
