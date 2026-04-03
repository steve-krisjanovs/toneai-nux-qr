# toneai-nux-qr — Feature Roadmap

## v1.4.0 — Cloud Export
## v1.5.0 — First-Run Onboarding + Chat Mode
## v1.6.0 — Spotify TUI Browser

---

## Overview

Add optional upload of QR code PNGs to Google Drive, Dropbox, and/or OneDrive. Each file is uploaded immediately as it's generated — not batched at the end — so a Ctrl+C mid-run still leaves a partial but useful cloud folder. Local files are always kept as the source of truth. Cloud export is a mirror, never a replacement.

---

## What Changed Between Releases (Context)

| Version | Key additions relevant to this feature |
|---|---|
| v1.0.0 | Base CLI, logger, config at `~/.toneai-nux-qr/` |
| v1.1.0 | `--folder-format` / `--file-format`, `--list-runs`, resume by number, `VERSION.txt` |
| v1.2.0 | API cost tracking (`ApiUsage`), prompt caching, `pricing.json`, token breakdown in final summary |
| v1.3.0 | `--delete`, double Ctrl+C force quit, `[y/N/a(ll)]` confirm, `resolveRuns()` refactor |
| v1.3.1 | Removed `--zip` / `-z` / `TNQR_ZIP` and `jszip` dependency |

Cloud export slots naturally after the generation loop. The `RunLogger` flush already captures `outputDir` — add upload URLs to it.

---

## CLI Interface

### New generation flags

Cloud flags are long-form only — no short flags. The intended usage pattern is to set them once in your shell profile via env vars rather than typing them interactively at the CLI.

| Long | Env Var | Description |
|---|---|---|
| `--gdrive` | `TNQR_GDRIVE` | Upload to Google Drive as each file is generated |
| `--dropbox` | `TNQR_DROPBOX` | Upload to Dropbox as each file is generated |
| `--onedrive` | `TNQR_ONEDRIVE` | Upload to OneDrive as each file is generated |
| `--gdrive-folder <path>` | `TNQR_GDRIVE_FOLDER` | Remote folder path in Drive — supports `{artist}` `{album}` `{device}` tokens |
| `--dropbox-folder <path>` | `TNQR_DROPBOX_FOLDER` | Remote folder path in Dropbox — same tokens |
| `--onedrive-folder <path>` | `TNQR_ONEDRIVE_FOLDER` | Remote folder path in OneDrive — same tokens |

Typical shell profile setup:
```bash
export TNQR_GDRIVE=true
export TNQR_GDRIVE_FOLDER="NUX Tones/{artist}/{album}"
```
Then just `tnqr "led zeppelin physical graffiti"` — no cloud flags needed at the CLI.

### New subcommands

```bash
tnqr auth gdrive              # OAuth browser flow, store token
tnqr auth dropbox             # OAuth browser flow, store token
tnqr auth onedrive            # OAuth browser flow, store token
tnqr auth --status            # show which services are authenticated
tnqr auth --revoke gdrive     # revoke and delete token
tnqr auth --revoke dropbox
tnqr auth --revoke onedrive
tnqr auth --revoke all        # revoke all tokens

tnqr --sync [N|all]           # upload all local files for a run without regenerating
                              # same N/all syntax as --resume and --delete
                              # e.g. tnqr --sync        → most recent run
                              #      tnqr --sync 3      → 3rd most recent run
                              #      tnqr --sync all    → all runs
```

### Example usage

```bash
# One-time auth per service
tnqr auth gdrive
tnqr auth dropbox

# Generate and upload to Drive
tnqr "led zeppelin physical graffiti" --gdrive

# Upload to multiple services
tnqr "led zeppelin physical graffiti" --gdrive --dropbox

# Custom remote folder
tnqr "led zeppelin physical graffiti" --gdrive --gdrive-folder "NUX Tones/{artist}/{album}"

# Via env vars — always upload
export TNQR_GDRIVE=true
export TNQR_GDRIVE_FOLDER="NUX Tones/{artist}/{album}"
tnqr "led zeppelin physical graffiti"

# Sync existing local files to cloud without regenerating
tnqr --sync --gdrive                    # most recent run
tnqr --sync 3 --gdrive                  # 3rd most recent run
tnqr --sync all --gdrive --dropbox      # all runs, multiple providers
tnqr --sync 2 --gdrive --gdrive-folder "NUX Tones/{artist}/{album}"
```

---

## Token Storage

```
~/.toneai-nux-qr/
  config.json              ← existing (Anthropic API key)
  gdrive-token.json        ← Google OAuth2 token (access + refresh)
  dropbox-token.json       ← Dropbox OAuth2 token
  onedrive-token.json      ← MSAL token cache
```

Tokens refresh automatically by each SDK when expired. Never committed to git (already covered by `.gitignore` pattern `~/.toneai-nux-qr/`).

---

## New File: `src/cloud.ts`

Single module for all three providers. No provider-specific code leaks into `cli.ts`.

```typescript
export type CloudProvider = 'gdrive' | 'dropbox' | 'onedrive'

export interface CloudUploadResult {
  provider: CloudProvider
  remotePath: string
  url?: string        // shareable link if available
  elapsedMs: number
}

// Auth
export async function authProvider(provider: CloudProvider): Promise<void>
export async function revokeProvider(provider: CloudProvider): Promise<void>
export async function isAuthenticated(provider: CloudProvider): Promise<boolean>
export async function getAuthStatus(): Promise<Record<CloudProvider, boolean>>

// Upload — per file, called immediately after each track is written locally
export async function uploadFile(
  provider: CloudProvider,
  localPath: string,      // e.g. output/led-zeppelin-physical-graffiti/plugpro/01-kashmir-plexi100.png
  remoteFolder: string,   // resolved remote path with tokens substituted
): Promise<CloudUploadResult>
```

Upload is fire-and-forget within each track's try/catch — a failed upload never blocks generation of subsequent tracks.

---

## Dependencies

```bash
bun add google-auth-library googleapis dropbox @microsoft/microsoft-graph-client @azure/msal-node
```

| Provider | Packages | Notes |
|---|---|---|
| Google Drive | `google-auth-library` + `googleapis` | Official Google packages. ADC compatible. |
| Dropbox | `dropbox` | Official Dropbox SDK. Handles token refresh. |
| OneDrive | `@microsoft/microsoft-graph-client` + `@azure/msal-node` | Microsoft Graph + MSAL for OAuth. |

---

## One-Time OAuth App Registrations

These are set up once by you — credentials are baked into the binary as app identity only. Users authenticate against their own accounts.

### Google Drive

1. [console.cloud.google.com](https://console.cloud.google.com) → New project: `toneai-nux-qr`
2. Enable **Google Drive API**
3. OAuth consent screen → External → add scope `https://www.googleapis.com/auth/drive.file`
   - `drive.file` = access only to files created by this app. No scary "full Drive access" prompt.
4. Credentials → OAuth 2.0 Client ID → Desktop app
5. Download → note `client_id` and `client_secret`
6. Add to `.env`: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`

### Dropbox

1. [dropbox.com/developers](https://www.dropbox.com/developers) → Create app
2. Scoped access → Full Dropbox (or App folder — your call)
3. Permissions tab → enable `files.content.write`
4. Note **App key** and **App secret**
5. Add to `.env`: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`

### OneDrive

1. [portal.azure.com](https://portal.azure.com) → Azure Active Directory → App registrations → New
2. Name: `toneai-nux-qr` → Accounts in any organizational directory + personal Microsoft accounts
3. Authentication → Add platform → Mobile and desktop applications → `http://localhost` redirect URI
4. API permissions → Microsoft Graph → Delegated → `Files.ReadWrite`
5. Note **Application (client) ID**
6. Add to `.env`: `ONEDRIVE_CLIENT_ID`
   - OneDrive public OAuth doesn't require a client secret for desktop apps

---

## Baking Credentials into Binary

Credentials are injected at build time via environment variables, bundled into the binary by `bun build --compile`. They identify the app, not any user account.

In `src/cloud.ts`:
```typescript
const GDRIVE_CLIENT_ID     = process.env.GDRIVE_CLIENT_ID     ?? ''
const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET ?? ''
const DROPBOX_APP_KEY      = process.env.DROPBOX_APP_KEY      ?? ''
const DROPBOX_APP_SECRET   = process.env.DROPBOX_APP_SECRET   ?? ''
const ONEDRIVE_CLIENT_ID   = process.env.ONEDRIVE_CLIENT_ID   ?? ''
```

In `release.yml` — add secrets to the build step:
```yaml
- name: Build binary
  env:
    GDRIVE_CLIENT_ID: ${{ secrets.GDRIVE_CLIENT_ID }}
    GDRIVE_CLIENT_SECRET: ${{ secrets.GDRIVE_CLIENT_SECRET }}
    DROPBOX_APP_KEY: ${{ secrets.DROPBOX_APP_KEY }}
    DROPBOX_APP_SECRET: ${{ secrets.DROPBOX_APP_SECRET }}
    ONEDRIVE_CLIENT_ID: ${{ secrets.ONEDRIVE_CLIENT_ID }}
  run: bun build src/cli.ts --compile ...
```

Add all 5 as GitHub Actions secrets in the repo settings.

---

## Integration Points in `cli.ts`

### 1. Parse new flags (add to existing flag parsing block)

```typescript
const uploadGdrive   = parseBool('--gdrive',          '--gdrive',          'TNQR_GDRIVE')
const uploadDropbox  = parseBool('--dropbox',         '--dropbox',         'TNQR_DROPBOX')
const uploadOnedrive = parseBool('--onedrive',        '--onedrive',        'TNQR_ONEDRIVE')
const gdriveFolder   = parseStr('--gdrive-folder',    '--gdrive-folder',   'TNQR_GDRIVE_FOLDER')
const dropboxFolder  = parseStr('--dropbox-folder',   '--dropbox-folder',  'TNQR_DROPBOX_FOLDER')
const onedriveFolder = parseStr('--onedrive-folder',  '--onedrive-folder', 'TNQR_ONEDRIVE_FOLDER')
```

### 2. Add `auth` subcommand handler (before helpers block)

```typescript
if (args[0] === 'auth') {
  const sub = args[1]
  const revoke = args.includes('--revoke')
  const status = args.includes('--status')
  // ... dispatch to cloud.ts functions
}
```

### 3. Per-file upload inside the track generation try/catch

Upload fires immediately after `fs.writeFileSync`, before `progress.setDone`. Upload failure is non-fatal — caught separately, logged, generation continues.

```typescript
try {
  const { params, ... } = await generateToneForSong(...)
  const filename = `${formatTemplate(fileFormat, fileVars)}.png`
  const outPath = path.join(outDir, filename)
  const png = await decorateQR(...)
  fs.writeFileSync(outPath, png)

  // Cloud upload — per file, immediately after local write
  const cloudResults: CloudUploadResult[] = []
  for (const { enabled, provider, folder } of activeProviders) {
    try {
      const remoteFolder = resolveRemoteFolder(folder, { artist, album, device })
      const result = await uploadFile(provider, outPath, remoteFolder)
      cloudResults.push(result)
    } catch (uploadErr) {
      // Non-fatal — log warning, continue
      progress.log(`   ⚠️  ${provider} upload failed for "${title}": ${uploadErr}`)
    }
  }

  progress.setDone(i, params.preset_name, Date.now() - trackStart, cloudResults)
  logger.logTrack({ ..., cloudUploads: cloudResults })
}
```

### 4. Progress display — show cloud status per track

Extend `ProgressDisplay.setDone()` to accept upload results and show a ☁️ indicator:

```
✓ Kashmir Physical Graffiti '75  00:33  ☁️ ✓✓   ← both providers succeeded
✓ The Rover – Page '75           00:28  ☁️ ✓✗   ← one provider failed
✓ Custard Pie Page '75           00:41               ← no cloud configured
```

### 5. Log upload results (add to `TrackLog` and `RunSummary` in `logger.ts`)

```typescript
// TrackLog — per track
cloudUploads?: Array<{ provider: string; remotePath: string; url?: string; success: boolean; error?: string }>

// RunSummary — aggregate
cloudProviders?: string[]                  // which providers were configured for this run
cloudPaths?: Record<string, string>        // provider → resolved remote folder path used
```

Storing `cloudProviders` and `cloudPaths` in `RunSummary` enables `--list-runs` to show a ☁️ indicator on runs that had cloud export, and gives resume the context it needs.

---

## Local Files — Always Kept

Local files in `output/<folder-format>/<device>/` are never deleted after upload. They remain the source of truth for:
- `--resume` — reads local PNGs to determine what succeeded
- `--delete` — explicitly cleans up local files and logs
- Manual verification — user can scan locally before files go to cloud
- Upload failure fallback — local files survive even if cloud upload fails

If users want local-only, they simply don't pass `--gdrive` etc. A future `--no-local` flag could be added as an explicit opt-in but is out of scope for v1.4.0.

---

## Remote File Handling — Overwrite by Filename, No Pre-Delete

When regenerating an album that already has cloud files:

- **Same filename** (same preset name) → provider overwrites silently. Clean.
- **Different filename** (preset name changed) → new file uploaded, old file remains. Both coexist in the remote folder. This is acceptable — the user can clean up via the provider's native UI, or a future `tnqr --cloud-delete` command.

No pre-delete of the remote folder before upload. Rationale: destructive and surprising, especially if the user has manually organised their Drive folder. Keep it additive for v1.4.0.

---

## Resume + Cloud Interaction

Four scenarios handled explicitly:

| Original run | Retry | Behaviour |
|---|---|---|
| Had cloud | No cloud flags on retry | Retry generates locally only — cloud flags must be explicit at retry time |
| No cloud | Cloud flags on retry | Retry generates and uploads failed tracks only |
| Had cloud | Cloud flags on retry | Retry generates and uploads failed tracks, overwrites remote if filename matches |
| Had cloud | Cloud flags on retry | Only retried tracks are uploaded — succeeded tracks from original run are **not** re-uploaded |

The last point is intentional. If a user wants all tracks uploaded (e.g. original run had no cloud and now they want everything in Drive), they use `--sync`:

```bash
# Original run had no cloud — now want everything in Drive
tnqr --sync 3 --gdrive
```

`--sync` reads the log for the specified run, gets `outputDir` from `run_end`, walks all local PNGs in that directory, and uploads each one via `uploadFile`. No AI calls, no regeneration. Uses the same `resolveRuns()` / N/all syntax as `--resume` and `--delete` for consistency.

```typescript
// --sync implementation outline in cli.ts
if (syncFlag) {
  const runs = resolveRuns(syncArg)
  for (const run of runs) {
    const parsed = parseLog(run.path)
    const outputDir = parsed.summary?.outputDir
    if (!outputDir || !fs.existsSync(outputDir)) {
      console.log(`  ⚠️  ${run.context} — output dir not found, skipping`)
      continue
    }
    // Walk all PNGs in outputDir recursively
    // Upload each via uploadFile() for each active provider
    // Log results
  }
}
```

The `cloudProviders` and `cloudPaths` fields in `RunSummary` (stored in the log) give `--list-runs` the data to show ☁️ indicators per run, so users can see at a glance which runs had cloud export configured.

---

## OAuth Browser Flow Pattern

All three providers use the same pattern — open a local HTTP server on a random port, launch the browser to the provider's auth URL, catch the callback, exchange code for tokens, store to disk.

```typescript
import { createServer } from 'node:http'

async function runLocalOAuthFlow(authUrl: string): Promise<string> {
  // Start local server on random port
  // Open browser to authUrl with redirect_uri=http://localhost:<port>
  // Wait for callback, extract code
  // Return code
}
```

The `open` npm package (`bun add open`) handles cross-platform browser launching (macOS `open`, Linux `xdg-open`, Windows `start`).

---

## README / CLAUDE.md Updates

After implementation:
- Add `tnqr auth gdrive|dropbox|onedrive` to Quick Start section
- Add cloud export flags to Options table
- Add "Cloud Export" section to README explaining per-file upload behaviour, local files always kept, and auth setup
- Update CLAUDE.md with `src/cloud.ts` architecture notes, OAuth app registration steps, and resume/cloud interaction table
- Update CLAUDE.md common commands with `tnqr auth` examples

---

## Binary Size Impact

The current v1.3.0 binary is **~157MB**. This is dominated by the Bun runtime (~100MB) baked into every `bun build --compile` output — unavoidable with Bun SEA.

Adding cloud export is expected to bring the binary to **~160-175MB** once `cloud.ts` is fully wired in. Bun tree-shakes aggressively — the cloud packages only add bytes for what's actually imported and used.

Breakdown of the 30 new packages:
- `google-auth-library` + `googleapis` — moderate (JSON discovery docs)
- `dropbox` — lean official SDK
- `@azure/msal-node` — heaviest, pulls in crypto dependencies
- `@microsoft/microsoft-graph-client` — moderate

**Update README.md** to set expectations before the v1.4.0 release:

```markdown
## Binary Size

The standalone installer binary is ~160MB. This is expected — the Bun runtime
is bundled into every binary regardless of app size. No runtime installation
required on the target machine.
```

Add this to the Requirements section, between the standalone installer note and the npm/bun install lines.

---

## Implementation Order

### Step 1 — Remove zip feature (same PR as cloud work)

Remove the following:
- `--zip` / `-z` / `TNQR_GDRIVE` flag and all parsing
- `TNQR_ZIP` env var
- `jszip` dependency (`bun remove jszip`)
- In-memory zip assembly in the generation loop (`zip.folder(device)!.file(...)`)
- Zip write block after generation (`zip.generateAsync(...)`, `fs.writeFileSync(zipPath, ...)`)
- `zipPath` from `RunSummary` interface and `logger.flush()` call
- Zip-related output line (`📦 Zip saved: ...`)

**Forward compatibility:** v1.3.0 logs that contain `zipPath` in their `run_end` entry resume cleanly in v1.4.0. `parseLog()` uses plain `JSON.parse` with no strict schema — unknown fields are silently ignored. No migration needed, no resume regressions.

**Communicate to users:** Since the repo isn't public yet and you're the only user, no changelog entry needed. Just drop it.

### Step 2 — Register OAuth apps (one-time, before writing code)
- Google Cloud Console → project `toneai-nux-qr` → Drive API → Desktop OAuth client
- Dropbox Developer Console → Scoped app → `files.content.write`
- Azure Portal → App Registration → Microsoft Graph `Files.ReadWrite`

### Step 3 — Add GitHub Actions secrets
Add all 5 credentials: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `ONEDRIVE_CLIENT_ID`

### Step 4 — Create `src/cloud.ts` — auth only, no upload yet
Implement `authProvider`, `isAuthenticated`, `getAuthStatus`, `revokeProvider`. Test OAuth browser flow for all three providers end-to-end before touching upload.

### Step 5 — Add `auth` subcommand to `cli.ts`
Wire up `tnqr auth gdrive|dropbox|onedrive`, `--status`, `--revoke`. Verify tokens are stored and refreshed correctly.

### Step 6 — Implement `uploadFile` in `cloud.ts` per provider
Start with Google Drive, then Dropbox, then OneDrive. Test each independently before wiring into the generation loop.

### Step 7 — Wire per-file upload into generation loop
Add `uploadFile` call inside the track try/catch immediately after `fs.writeFileSync`. Upload failure is non-fatal — caught separately, logged as a warning, generation continues.

### Step 8 — Implement `--sync` subcommand
Add `--sync [N|all]` to `cli.ts`. Uses `resolveRuns()` (already exists), `parseLog()` (already exists), walks local PNGs in `outputDir`, calls `uploadFile` per file per active provider. Same N/all syntax as `--resume` and `--delete`. No new interfaces needed in `cloud.ts`.

### Step 9 — Extend progress display
Update `ProgressDisplay.setDone()` to accept cloud upload results and show ☁️ ✓/✗ per track inline.

### Step 10 — Update logger
- Add `cloudUploads` to `TrackLog`
- Add `cloudProviders` and `cloudPaths` to `RunSummary`
- Update `--list-runs` output to show ☁️ indicator on runs with cloud export configured

### Step 11 — Update README and CLAUDE.md
- Remove zip references
- Add cloud export section, auth setup, per-file upload behaviour, `--sync` usage
- Add binary size note to Requirements section
- Update CLAUDE.md with `src/cloud.ts` architecture, OAuth registration steps, resume/cloud interaction table

### Step 12 — Post-install dialogs

Add a simple informational finish page to all platform installers telling the user what to do next.

**Windows (Inno Setup)** — add to `[Setup]` section:
```ini
[Setup]
; Custom finish page message
SetupAppRunningTemplate=tnqr has been installed successfully.%n%nOpen a new Command Prompt or PowerShell and run:%n%n  tnqr%n%nThis will guide you through setup on first run.
```
Or via the `[Code]` section for a custom finish wizard page.

**macOS (pkg)** — add a `conclusion.html` to the pkg resources:
```html
<h2>tnqr is installed.</h2>
<p>Open Terminal and run:</p>
<pre>tnqr</pre>
<p>This will guide you through setup on first run.</p>
```

**macOS (Homebrew)** — add a `caveats` method to the Formula. Homebrew prints this automatically after `brew install` or `brew upgrade` completes — no extra invocation needed:
```ruby
def caveats
  <<~EOS
    toneai-nux-qr has been installed.

    To get started, open a new terminal and run:
      tnqr

    This will guide you through setup on first run.
  EOS
end
```

Output in terminal after install:
```
==> Caveats
toneai-nux-qr has been installed.

To get started, open a new terminal and run:
  tnqr

==> Summary
🍺 /opt/homebrew/Cellar/toneai-nux-qr/1.4.0: 1 file, 157MB
```

Note: Homebrew caveats show the same message on both fresh install and upgrade — no way to differentiate. Expected behaviour for Homebrew users.

**Linux deb** — add to `postinst` script:
```bash
echo ""
echo "tnqr has been installed successfully."
echo "Open your terminal and run: tnqr"
echo ""
```

**Linux rpm** — same message in `%post` scriptlet.

### Step 13 — Bump to v1.4.0, tag and release

---
---

# First-Run Onboarding + Chat Mode — Roadmap v1.5.0

## Overview

Two complementary features that eliminate the learning curve for new users:

1. **First-run detection** — when `tnqr` is invoked with no args and no API key configured, automatically launch an interactive onboarding flow instead of printing help
2. **`--chat` mode** — guided step-by-step generation for any user, any time

Both use `@clack/prompts`. No new heavy dependencies.

---

## First-Run Detection Logic

```
tnqr  ← no args, no key  →  onboarding + guided generation
tnqr  ← no args, key set →  print help (unchanged, non-breaking)
tnqr --chat               →  chat mode always, regardless of key
```

---

## Onboarding Flow

### Step 1 — Welcome + API key setup

```
  🎸 Welcome to toneai-nux-qr!

  To generate tones, you need a free Anthropic API key.
  Get one at: https://console.anthropic.com
  (No credit card required to start)

  Paste your API key:
  > sk-ant-...

  ✅ Key looks valid!
```

### Step 2 — Key storage options

```
  How would you like to store your API key?

  ▸ Save to ~/.toneai-nux-qr/config.json  (simplest, just works)
  ▸ Add to shell profile                   (recommended for developers)
  ▸ Both
```

If shell profile selected:

```
  Which shell are you using?

  ▸ zsh   (~/.zshrc)
  ▸ bash  (~/.bashrc)
  ▸ fish  (~/.config/fish/config.fish)
  ▸ Other (I'll do it manually)
```

For zsh/bash — appends to profile:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```
Then instructs:
```
  ✅ Added to ~/.zshrc

  To activate in your current session:
    source ~/.zshrc

  Or just open a new terminal.
```

For fish — uses persistent universal variable (sets in current session immediately, no source needed):
```fish
set -Ux ANTHROPIC_API_KEY sk-ant-...
```

### Step 3 — Guided generation

After key is saved, flows immediately into `--chat` mode — no need to re-run `tnqr`.

---

## `--chat` Mode Flow

```
  What would you like to generate tones for?
  > Pink Floyd The Wall

  Which NUX device do you have?
  ▸ Mighty Plug Pro
  ▸ Mighty Space
  ▸ Mighty Air v2
  ▸ Other (enter device ID)

  Do you want to specify your pickup/guitar?
  ▸ Yes
  ▸ No (AI will research the recording)

  > Les Paul bridge humbucker, vol 7, tone 8

  Upload to cloud storage?
  ▸ No
  ▸ Google Drive
  ▸ Dropbox
  ▸ OneDrive

  Ready! Here's the command that will run:

  tnqr -q "pink floyd the wall" -d plugpro -p "Les Paul bridge humbucker, vol 7, tone 8" -y

  [ Run it ]  [ Edit command ]  [ Cancel ]
```

The generated command is shown before execution — users learn the CLI naturally over time just by using chat mode.

---

## Implementation Order (v1.5.0)

1. Add `@clack/prompts` (`bun add @clack/prompts`)
2. Create `src/onboarding.ts` — API key setup flow, shell profile detection and writing, key validation
3. Add first-run detection to `cli.ts` — check for key + no args, invoke onboarding
4. Create `src/chat.ts` — guided generation question flow, command builder, confirm + execute
5. Add `--chat` flag to `cli.ts`
6. Update README and CLAUDE.md
7. Bump to v1.5.0, tag and release

# Spotify Integration — Roadmap v1.6.0

---

## Overview

Add Spotify integration via two complementary modes — both require OAuth authentication against the user's Spotify account. A single auth flow covers both modes.

**Mode 1 — Direct URL/URI** — power user shortcut, paste a Spotify URL or URI directly:
```bash
tnqr --spotify "https://open.spotify.com/album/1234567"
tnqr --spotify "spotify:playlist:abc123"
```

**Mode 2 — TUI Browser** — interactive browser for exploring personal library:
```bash
tnqr --spotify
```

Both modes skip Haiku intent resolution — Spotify provides the authoritative tracklist directly. Faster and cheaper per run.

---

## Why Unified OAuth (Not Client Credentials)

Anonymous client credentials access would work for public catalog lookups, but OAuth is the right choice for both modes because:

- Anyone using `--spotify <url>` almost certainly has a Spotify account — they're copying URLs from their own Spotify session
- OAuth unlocks personal library access for the TUI browser — same token, both modes
- One auth flow, one token, one mental model — consistent with cloud provider auth pattern already established in v1.4.0
- No split behaviour to explain or maintain

---

## CLI Interface

### Auth subcommands

```bash
tnqr auth spotify               # OAuth browser flow, store token
tnqr auth spotify --revoke      # revoke and delete token
tnqr auth spotify --status      # show auth status
tnqr auth --status              # show status for all providers (cloud + spotify)
```

Follows the same `tnqr auth <provider>` pattern established in v1.4.0 for cloud providers.

### Generation flags

| Long | Env Var | Description |
|---|---|---|
| `--spotify [url/uri]` | `TNQR_SPOTIFY` | No value = TUI browser. With value = direct URL/URI mode. |

No short flag — consistent with cloud flags decision from v1.4.0 (long-form only for non-core flags).

### Direct URL/URI mode examples

```bash
# Spotify share URLs (copied from Share → Copy Link)
tnqr --spotify "https://open.spotify.com/album/1BKnGDyiABaFgJgp6sCFJB"
tnqr --spotify "https://open.spotify.com/playlist/37i9dQZF1DX5Ejj0EkURtP"
tnqr --spotify "https://open.spotify.com/artist/16oZKvXb6WkQlVAjwo2Wbg"
tnqr --spotify "https://open.spotify.com/track/2uqYupMPE5QKmgVAomZaVC"

# Spotify URIs
tnqr --spotify "spotify:album:1BKnGDyiABaFgJgp6sCFJB"
tnqr --spotify "spotify:playlist:37i9dQZF1DX5Ejj0EkURtP"

# Composable with all existing flags
tnqr --spotify "https://open.spotify.com/album/1BKnGDyiABaFgJgp6sCFJB" -d plugpro -p "Les Paul bridge humbucker"
tnqr --spotify "spotify:playlist:37i9dQZF1DX5Ejj0EkURtP" -d all --gdrive
```

### TUI browser mode

```bash
tnqr --spotify          # launches interactive browser
tnqr --spotify -d plugpro  # browser with device pre-selected
```

```
  🎵 toneai-nux-qr — Spotify Browser

  ▸ Recent Albums
  ▸ Saved Albums
  ▸ Playlists
  ▸ Search...

  [ Select ]  [ Cancel ]
```

Navigating into a selection:

```
  📀 Physical Graffiti — Led Zeppelin (1975)
  15 tracks: Custard Pie, The Rover, In My Time of Dying...

  [ Generate Tones ]  [ Back ]  [ Cancel ]
```

---

## URL/URI Parsing

Auto-detect type from URL/URI structure — no `--spotify-type` flag needed:

```typescript
function parseSpotifyInput(input: string): { type: 'album' | 'artist' | 'playlist' | 'track', id: string } {
  // https://open.spotify.com/album/1BKnGDyiABaFgJgp6sCFJB
  // https://open.spotify.com/album/1BKnGDyiABaFgJgp6sCFJB?si=xxx  ← strip query string
  // spotify:album:1BKnGDyiABaFgJgp6sCFJB
}
```

Supported types and their behaviour:

| Type | Spotify API call | Tracks returned |
|---|---|---|
| `album` | `GET /albums/{id}/tracks` | Full album tracklist in order |
| `playlist` | `GET /playlists/{id}/tracks` | All playlist tracks |
| `artist` | `GET /artists/{id}/top-tracks` | Top 10 tracks for that artist |
| `track` | `GET /tracks/{id}` | Single track |

For `artist` type — top tracks is a reasonable default but could prompt the user to select an album instead via TUI. TBD.

---

## Authentication

### Spotify app registration (one-time)

1. [developer.spotify.com](https://developer.spotify.com) → Dashboard → Create app
2. App name: `toneai-nux-qr`
3. Redirect URI: `http://localhost` (for desktop OAuth flow)
4. APIs used: Web API
5. Note **Client ID** and **Client Secret**
6. Add to `.env`: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
7. Add to GitHub Actions secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`

### OAuth scopes required

| Scope | Required for |
|---|---|
| `user-read-recently-played` | TUI — Recent Albums |
| `user-library-read` | TUI — Saved Albums |
| `playlist-read-private` | TUI — Playlists + direct playlist URLs |
| `playlist-read-collaborative` | TUI — collaborative playlists |

Note: Public album/track lookups by URL work with any authenticated user token — no special scope needed beyond basic auth.

### OAuth flow

Same local HTTP server pattern used for cloud providers in v1.4.0:
1. Start local server on random port
2. Open browser to Spotify auth URL with `redirect_uri=http://localhost:<port>`
3. User logs in and approves
4. Catch callback, exchange code for access + refresh tokens
5. Store to `~/.toneai-nux-qr/spotify-token.json`

Token refreshes automatically using the refresh token when expired.

### Token storage

```
~/.toneai-nux-qr/
  spotify-token.json    ← access token, refresh token, expiry
```

Already covered by existing `.gitignore` pattern.

---

## New File: `src/spotify.ts`

```typescript
// Auth
export async function authSpotify(): Promise<void>
export async function revokeSpotify(): Promise<void>
export async function isSpotifyAuthenticated(): Promise<boolean>

// URL/URI parsing
export function parseSpotifyInput(input: string): SpotifyTarget
export interface SpotifyTarget {
  type: 'album' | 'artist' | 'playlist' | 'track'
  id: string
}

// API calls — all return ResolvedIntent directly
export async function resolveSpotifyTarget(target: SpotifyTarget): Promise<ResolvedIntent>
export async function getRecentAlbums(): Promise<SpotifyAlbum[]>
export async function getSavedAlbums(): Promise<SpotifyAlbum[]>
export async function getPlaylists(): Promise<SpotifyPlaylist[]>
export async function searchSpotify(query: string): Promise<SpotifySearchResults>
```

### New file: `src/spotify-tui.ts`

```typescript
// Interactive TUI browser using @clack/prompts
export async function runSpotifyBrowser(): Promise<ResolvedIntent>
```

---

## Integration with Generation Pipeline

Both modes resolve to `ResolvedIntent` — the same shape `resolveIntent()` returns today:

```typescript
{
  artist: "Led Zeppelin",
  context: "Led Zeppelin — Physical Graffiti (1975 studio album)",
  tracks: [
    { title: "Custard Pie" },
    { title: "The Rover" },
    ...
  ]
}
```

In `cli.ts`, Spotify bypasses the `resolveIntent()` call entirely:

```typescript
let resolvedIntent: ResolvedIntent

if (spotifyInput) {
  // Direct URL/URI mode
  const target = parseSpotifyInput(spotifyInput)
  resolvedIntent = await resolveSpotifyTarget(target)
} else if (spotifyTUI) {
  // TUI browser mode
  resolvedIntent = await runSpotifyBrowser()
} else {
  // Existing flow — Haiku + web search
  resolvedIntent = await resolveIntent(client, query!, intentModel)
}
```

No changes to the tone generation loop — Spotify is purely an input source.

---

## Dependencies

```bash
bun add spotify-web-api-ts
# or use fetch directly against the Spotify REST API — no SDK needed
# Spotify's API is simple enough that raw fetch is cleaner than adding a dependency
```

Recommendation: **raw fetch** against `https://api.spotify.com/v1/`. The Spotify API is REST with JSON — no SDK needed. Keeps bundle size down and avoids a dependency that could break with Spotify API changes.

---

## Benefits Over Plain Query

- Authoritative tracklists — no hallucinated track titles for obscure albums
- Personal library browsing — recent albums, saved albums, playlists
- Playlist generation — killer feature, generates tones for your entire practice playlist
- No Haiku API call for intent resolution → faster and cheaper per run
- Power users: one copy from Spotify → one paste to `tnqr`, done

## Not Worth Pursuing

- **YouTube Music** — no official API, unofficial libraries break with Google updates
- **Apple Music** — requires Apple Developer membership ($99/year), MusicKit is browser/Apple-platform only, auth on non-Apple platforms is not viable

---

## `--list-runs` and logging

Add Spotify source to `RunMeta` in the log:

```typescript
spotifySource?: {
  type: 'album' | 'artist' | 'playlist' | 'track'
  id: string
  url: string
  name: string
}
```

`--list-runs` shows a 🎵 indicator on runs that came from Spotify.

---

## Implementation Order

1. Register Spotify app at developer.spotify.com
2. Add `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` to `.env` and GitHub Actions secrets
3. Create `src/spotify.ts` — OAuth flow + token storage first, test auth end-to-end
4. Add `tnqr auth spotify` to `cli.ts` — wire into existing `auth` subcommand handler from v1.4.0
5. Implement `parseSpotifyInput()` and `resolveSpotifyTarget()` — test with album, playlist, artist, track URLs
6. Wire direct URL/URI mode into `cli.ts` — bypass `resolveIntent()`, feed into generation loop
7. Implement TUI browser in `src/spotify-tui.ts` using `@clack/prompts` (already a dep from v1.5.0)
8. Wire TUI mode into `cli.ts`
9. Add `spotifySource` to `RunMeta` in `logger.ts`, update `--list-runs` display
10. Update README and CLAUDE.md
11. Bump to v1.6.0, tag and release
