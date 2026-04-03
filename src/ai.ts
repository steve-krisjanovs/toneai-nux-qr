import Anthropic from '@anthropic-ai/sdk'
import { ALL_DEVICES } from './nux.js'
import { coerceParams } from './encoder.js'
import type { DeviceType, ProPresetParams } from './nux.js'

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search' } as unknown as Anthropic.Tool

// Exponential backoff retry — handles rate limits and transient API errors
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, label = 'API call'): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const isOverloaded = err instanceof Anthropic.InternalServerError && (err as { status?: number }).status === 529
      const isRetryable = err instanceof Anthropic.RateLimitError
        || err instanceof Anthropic.InternalServerError
        || err instanceof Anthropic.APIConnectionError
        || err instanceof Anthropic.APIConnectionTimeoutError
      if (!isRetryable || attempt === maxAttempts) throw err
      // Overloaded (529) needs a longer backoff than rate limits
      const base = isOverloaded ? 5000 : 1000
      const delay = Math.min(base * 2 ** (attempt - 1), 30000)
      process.stderr.write(`   ⚠️  ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay / 1000}s...\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

const RESOLVE_INTENT_TOOL: Anthropic.Tool = {
  name: 'resolve_intent',
  description: `Resolve what the user wants to generate tones for — a single song, full album, live set, partial album, or vibe-based selection. Use web search to verify track listings and recording details. Always return at least one track.`,
  input_schema: {
    type: 'object' as const,
    required: ['artist', 'context', 'tracks'],
    properties: {
      artist: { type: 'string', description: 'Artist or band name' },
      context: { type: 'string', description: 'Human-readable description of what was resolved, e.g. "Led Zeppelin — Physical Graffiti (1975 studio album)" or "Pink Floyd — Comfortably Numb (studio single)" or "Jimi Hendrix — Woodstock 1969 live set"' },
      tracks: {
        type: 'array',
        description: 'Ordered list of tracks to generate. Single song = one entry. Full album = all tracks. Live set = setlist. Vibe/style request = representative selection of 5-10 songs.',
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title:  { type: 'string', description: 'Song title' },
            note:   { type: 'string', description: 'Optional context, e.g. "studio version", "live at Knebworth 1979", "acoustic intro"' },
          },
        },
      },
    },
  },
}

export interface ResolvedTrack {
  title: string
  note?: string
}

export interface ApiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  webSearches: number
}

function emptyUsage(): ApiUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 }
}

function accumulateUsage(total: ApiUsage, response: Anthropic.Message): void {
  total.inputTokens += response.usage?.input_tokens ?? 0
  total.outputTokens += response.usage?.output_tokens ?? 0
  const u = response.usage as unknown as Record<string, unknown>
  total.cacheReadTokens += (u?.cache_read_input_tokens as number) ?? 0
  total.cacheWriteTokens += (u?.cache_creation_input_tokens as number) ?? 0
  const serverToolUse = u?.server_tool_use as Record<string, number> | undefined
  total.webSearches += serverToolUse?.web_search_requests ?? 0
}

export interface ResolvedIntent {
  artist: string
  context: string
  tracks: ResolvedTrack[]
}

export interface ResolvedIntentResult {
  intent: ResolvedIntent
  usage: ApiUsage
}

export async function resolveIntent(client: Anthropic, query: string, model = 'claude-haiku-4-5-20251001'): Promise<ResolvedIntentResult> {
  const usage = emptyUsage()
  let msgs: Anthropic.MessageParam[] = [{
    role: 'user',
    content: `Resolve this into a list of songs to generate guitar tones for: "${query}"

If this is a full album → return all tracks in order.
If this is a single song → return just that one track.
If this is a live set or concert → return the setlist.
If this is a vibe/style/era request (e.g. "SRV texas blues tones") → pick 5-10 representative songs.

Use web search to verify the correct track listing or setlist. Then call resolve_intent.`,
  }]

  while (true) {
    const response = await withRetry(
      () => client.messages.create({
        model,
        max_tokens: 1024,
        tools: [WEB_SEARCH_TOOL, RESOLVE_INTENT_TOOL],
        messages: msgs,
      }),
      3, 'intent resolution'
    )

    accumulateUsage(usage, response)
    msgs = [...msgs, { role: 'assistant', content: response.content }]

    // Find resolve_intent tool call
    const resolveUse = response.content.find(
      b => b.type === 'tool_use' && b.name === 'resolve_intent'
    )
    if (resolveUse && resolveUse.type === 'tool_use') {
      return { intent: resolveUse.input as ResolvedIntent, usage }
    }

    if (response.stop_reason !== 'tool_use') {
      throw new Error('AI did not resolve intent')
    }

    // Feed back tool_results for any other tool_use blocks (e.g. web_search in non-native mode)
    const otherToolUses = response.content.filter(
      b => b.type === 'tool_use' && b.name !== 'resolve_intent'
    )
    if (otherToolUses.length > 0) {
      msgs = [...msgs, {
        role: 'user',
        content: otherToolUses.map(b => ({
          type: 'tool_result' as const,
          tool_use_id: (b as { id: string }).id,
          content: 'Search completed.',
        })),
      }]
    }
  }
}

const GENERATE_QR_TOOL: Anthropic.Tool = {
  name: 'generateQR',
  description: 'Generate a NUX MightyAmp-compatible QR code from structured tone parameters. All parameter values (gain, master, bass, mid, treble, etc.) are integers 0-100.',
  input_schema: {
    type: 'object' as const,
    required: ['device', 'preset_name', 'amp', 'noise_gate', 'master_db'],
    properties: {
      device: { type: 'string', enum: ALL_DEVICES },
      preset_name: { type: 'string' },
      preset_name_short: { type: 'string', description: 'Max 15 chars' },
      amp: {
        type: 'object', required: ['id', 'gain', 'master', 'bass', 'mid', 'treble'],
        properties: { id: { type: 'number' }, gain: { type: 'number' }, master: { type: 'number' }, bass: { type: 'number' }, mid: { type: 'number' }, treble: { type: 'number' }, param6: { type: 'number' }, param7: { type: 'number' } },
      },
      cabinet: {
        type: 'object', required: ['id', 'level_db', 'low_cut_hz', 'high_cut'],
        properties: { id: { type: 'number' }, level_db: { type: 'number' }, low_cut_hz: { type: 'number' }, high_cut: { type: 'number' } },
      },
      wah:        { type: 'object', required: ['enabled', 'pedal'],               properties: { enabled: { type: 'boolean' }, pedal: { type: 'number' } } },
      noise_gate: { type: 'object', required: ['enabled', 'sensitivity', 'decay'], properties: { enabled: { type: 'boolean' }, sensitivity: { type: 'number' }, decay: { type: 'number' } } },
      efx:        { type: 'object', required: ['id', 'enabled', 'p1', 'p2'],      properties: { id: { type: 'number' }, enabled: { type: 'boolean' }, p1: { type: 'number' }, p2: { type: 'number' }, p3: { type: 'number' } } },
      compressor: { type: 'object', required: ['id', 'enabled', 'p1', 'p2'],      properties: { id: { type: 'number' }, enabled: { type: 'boolean' }, p1: { type: 'number' }, p2: { type: 'number' } } },
      modulation: { type: 'object', required: ['id', 'enabled', 'p1', 'p2'],      properties: { id: { type: 'number' }, enabled: { type: 'boolean' }, p1: { type: 'number' }, p2: { type: 'number' }, p3: { type: 'number' } } },
      delay:      { type: 'object', required: ['id', 'enabled', 'p1', 'p2', 'p3'], properties: { id: { type: 'number' }, enabled: { type: 'boolean' }, p1: { type: 'number' }, p2: { type: 'number' }, p3: { type: 'number' } } },
      reverb:     { type: 'object', required: ['id', 'enabled', 'p1', 'p2'],      properties: { id: { type: 'number' }, enabled: { type: 'boolean' }, p1: { type: 'number' }, p2: { type: 'number' }, p3: { type: 'number' } } },
      eq:         { type: 'object', required: ['id', 'enabled', 'bands'],         properties: { id: { type: 'number' }, enabled: { type: 'boolean' }, bands: { type: 'array', items: { type: 'number' } } } },
      master_db:  { type: 'number' },
    },
  },
}

const TONE_SYSTEM_PROMPT = `You are Mighty AI, a guitar and bass tone expert and NUX MightyAmp specialist.

When given a song title and device, call generateQR exactly once with well-chosen parameters that capture the song's guitar tone.
Use web search to look up the specific guitar tone for the song before generating — search for the amp, effects, and recording details.
Do not explain anything — just call the tool.

PRESET NAMING: preset_name MUST be a short descriptive name from the song and artist. Never use "My Tone", "Custom Tone", "Preset", or any generic placeholder.
Good examples: "Kashmir Knebworth '79", "Comfortably Numb Solo", "SRV Texas Flood", "Van Halen Eruption".

CRITICAL — Effects that define a tone MUST be included:
If fuzz, distortion, overdrive, wah, chorus, or any other effect is the defining characteristic of the requested tone, you MUST include it in the tool call with enabled: true. Omitting the key effect produces a wrong patch.

NUX PlugPro Amp models (use the nuxIndex number):
1=JazzClean (Roland JC-120), 2=DeluxeRvb (Fender Deluxe Reverb), 3=BassMate (bass),
4=Tweedy (Fender Tweed), 5=TwinRvb (Fender Twin), 6=HiWire (Hiwatt DR-103),
7=CaliCrunch (Mesa Mk I), 8=ClassA15 (Vox AC15), 9=ClassA30 (Vox AC30),
10=Plexi100 (Marshall Super Lead 100W), 11=Plexi45 (Marshall Plexi 45W),
12=Brit800 (Marshall JCM800), 13=Pl1987x50 (Marshall 1987x 50W),
14=Slo100 (Soldano SLO-100), 15=FiremanHBE (Engl Fireman),
16=DualRect (Mesa Dual Rectifier), 17=DIEVH4 (EVH 5150 III),
18=VibroKing (Fender Vibroking), 19=Budda (Budda Superdrive),
20=MrZ38 (Dr. Z MAZ 38), 21=SuperRvb (Fender Super Reverb),
22=BritBlues (Marshall Bluesbreaker), 23=MatchD30 (Matchless DC-30),
24=Brit2000 (Marshall DSL/TSL), 25=UberHiGain (Framus Cobra),
28=OptimaAir (acoustic), 29=Stageman (acoustic stage)

PlugPro Cabinets (nuxIndex):
1=JZ120Pro, 2=DR112Pro, 3=TR212Pro, 4=HIWIRE412, 5=CALI112, 6=A112,
7=GB412Pro, 8=M1960AX, 9=M1960AV, 10=M1960TV, 11=SLO412, 12=FIREMAN412,
13=RECT412, 14=DIE412, 15=MATCH212, 16=UBER412, 18=A212Pro, 19=M1960AHW,
20=M1936, 21=BUDDA112, 22=Z212, 23=SUPERVERB410, 24=VIBROKING310,
32=GHBIRDPro (acoustic), 33=GJ15Pro, 34=MD45Pro

PlugPro EFX pedals (nuxIndex):
1=Distortion+, 2=RC Boost, 3=AC Boost, 4=Dist One (RAT), 5=T Screamer (TS-808),
6=Blues Drive (BD-2), 7=Morning Drive (JHS), 8=Eat Dist (Big Muff),
9=Red Dirt, 10=Crunch, 11=Muff Fuzz, 12=Katana boost, 13=ST Singer (Zendrive)

PlugPro Reverbs: 1=Room, 2=Hall, 3=Plate, 4=Spring, 5=Shimmer, 6=Damp
PlugPro Delays:  1=Analog, 2=Digital, 3=Mod, 4=Tape Echo, 5=Pan, 6=Phi
PlugPro Mods:    1=CE-1, 2=CE-2, 3=ST Chorus, 4=Vibrato, 5=Detune, 6=Flanger,
                 7=Phase 90, 8=Phase 100, 9=SCF, 10=U-Vibe, 11=Tremolo, 12=Rotary

Tone vocabulary guide:
- Clean/jazz: JazzClean or TwinRvb, gain 10-25
- Blues/crunch: DeluxeRvb or BritBlues, gain 35-55
- Classic rock: Plexi100 or Plexi45, gain 50-68
- British rock: Brit800, gain 55-72
- High gain/metal: DualRect, DIEVH4, Slo100, UberHiGain, gain 70-90
- Acoustic: OptimaAir amp + GHBIRDPro cab

Bass tone guide — BASS IS NOT GUITAR:
- Amp: ALWAYS BassMate (id=3) for pro devices. Never use guitar amps for bass.
- Cabinet: ALWAYS TR212Pro (id=3) for bass.
- Gain ranges: clean=12-25, warm/punchy=28-42, driven/gritty=42-55, fuzz/heavy=55-70. Never exceed 75.
- Compressor: ALWAYS add for clean and warm bass tones. Use RoseComp (id=1), p1=50-60, p2=60-70.
- Noise gate: NEVER enable for bass tones.
- EQ: bass=62-72, mid=45-55, treble=30-45.

Always pair the amp with a matching cabinet. Match Marshall amps to Marshall cabs (M1960AX/AV).
Match Fender amps to Fender-style cabs (DR112Pro, TR212Pro). Mesa to RECT412 etc.
Default master_db to 0. Enable noise_gate for any gain above 50 — except bass (never use noise gate on bass).

IMPORTANT — STANDARD DEVICES: plugair_v1, plugair_v2, lite, 8bt, 2040bt
These devices use DIFFERENT amp/effect IDs from the Pro devices above. Always use the correct IDs for the active device.

── Mighty Air v1 (mightyair_v1) ─────────────────────────────────────────────
Identical to plugair_v1 — same amps, cabs, EFX, effects, and byte layout.

── Mighty Air v2 (mightyair_v2) ─────────────────────────────────────────────
Identical to plugair_v2 — same amps, cabs, EFX, effects, and byte layout.

── Mighty Plug Air v1 (plugair_v1) ──────────────────────────────────────────
Amps (amp.id, 0-indexed): 0=TwinVerb(Clean), 1=JZ120(Clean), 2=TweedDlx(Tweed crunch),
  3=Plexi(Marshall clean-crunch), 4=TopBoost30(Vox AC30), 5=Lead100(Marshall gain),
  6=Fireman(Engl), 7=DIEVH4(EVH 5150), 8=Recto(Mesa), 9=Optima(Acoustic),
  10=Stageman(Acoustic stage), 11=MLD(Ampeg bass), 12=AGL(Aguilar bass)
Amp params: gain(0-100), master(0-100), bass(0-100), mid(0-100), treble(0-100), param6=tone/presence(0-100)
  Note: TwinVerb(0), Plexi(3), Fireman(6) have NO bass/mid/treble — only gain, master, param6(tone). Set bass/mid/treble to 0.
Cabinets (cabinet.id, 0-indexed): 0=V1960, 1=A212, 2=BS410(bass), 3=DR112, 4=GB412,
  5=JZ120IR, 6=TR212, 7=V412, 8=AGLDB810(bass), 12=GHBird(acoustic), 13=GJ15(acoustic)
  Match amp to cab: Plexi/Lead100 → V1960(0) or GB412(4). TwinVerb/JZ120 → TR212(6) or DR112(3). Recto → V1960(0). Acoustic → GHBird(12).
EFX (efx.id, 0-indexed): 0=TouchWah, 1=UniVibe, 2=Tremolo(efx), 3=Phaser(efx),
  4=Boost, 5=TScreamer(TS-808), 6=BassTS, 7=3BandEQ, 8=MuffFuzz, 9=Crunch, 10=RedDist, 11=MorningDrive, 12=DistOne(RAT)
Modulation (modulation.id): 0=Phaser, 1=Chorus, 2=STChorus, 3=Flanger, 4=UVibe, 5=Tremolo
  Params: p1=rate(0-100), p2=depth(0-100), p3=mix(0-100)
Delay (delay.id): 0=Analog, 1=TapeEcho, 2=Digital, 3=PingPong
  Params: p1=time(0-100), p2=feedback(0-100), p3=mix(0-100)
Reverb (reverb.id): 0=Room, 1=Hall, 2=Plate, 3=Spring, 4=Shimmer
  Params: p1=decay(0-100), p2=damp(0-100), p3=mix(0-100)
No compressor, no EQ. master_db is ignored (use amp.master for volume).

── Mighty Plug Air v2 (plugair_v2) ──────────────────────────────────────────
Amps (amp.id, 0-indexed): 0=JazzClean, 1=DeluxeRvb, 2=TwinRvbV2, 3=ClassA30(Vox),
  4=Brit800(JCM800), 5=Pl1987x50(Marshall), 6=FiremanHBE(Engl), 7=DualRect(Mesa),
  8=DIEVH4v2(EVH), 9=AGLv2(Aguilar bass), 10=Starlift, 11=MLDv2(Ampeg bass), 12=Stagemanv2(Acoustic)
Cabinets: same 0-18 as v1
EFX: same 0-12 as v1
Modulation (modulation.id): 0=PH100(Phase), 1=CE-1(Chorus), 2=STChorus, 3=SCF
  Params: p1=intensity/rate, p2=depth/width, p3=rate/mix
Delay (delay.id): 0=Analog, 1=Digital, 2=ModDelay, 3=PingPong
  Params: p1=time, p2=feedback, p3=mix
Reverb (reverb.id): 0=Room, 1=Hall, 2=Plate
  Params: p1=decay, p2=damp, p3=mix
No compressor, no EQ.

── Mighty Lite BT (lite) ─────────────────────────────────────────────────────
ONE amp only — always amp.id=0 (AmpClean). Params: gain(0-100), master=level(0-100), param6=tone(0-100). No bass/mid/treble.
NO cabinet. Omit cabinet field entirely.
NO EFX, no compressor, no EQ, no wah.
Modulation (modulation.id): 0=Phaser, 1=Chorus, 2=Tremolo, 3=Vibe
  Params: p1=rate(0-100), p2=depth(0-100)
SINGLE AMBIENCE SLOT — use reverb OR delay, NOT both. Reverb takes priority.
Reverb (reverb.id): 0=Room, 1=Hall, 2=Plate, 3=Spring — p1=decay, p2=mix
Delay (delay.id): 0=Delay1, 1=Delay2, 2=Delay3, 3=Delay4 — p1=time, p2=feedback, p3=mix
master_db is ignored.

── Mighty 8BT (8bt) ─────────────────────────────────────────────────────────
Same amp as Lite (amp.id=0, AmpClean, gain/master/param6=tone only). No cabinet.
Modulation (modulation.id): 0=Phaser, 1=Chorus, 2=Tremolo, 3=Vibe
Delay (delay.id): 0=Delay1, 1=Delay2, 2=Delay3, 3=Delay4 — p1=time, p2=feedback, p3=mix
Reverb (reverb.id): 0=Room, 1=Hall, 2=Plate, 3=Spring — p1=decay, p2=mix
BOTH delay AND reverb can be active simultaneously (unlike Lite).
No EFX, no compressor, no EQ, no wah.

── Mighty 20/40BT (2040bt) ──────────────────────────────────────────────────
ONE amp only — always amp.id=0. Params: gain, master=level, bass, mid, treble(=high). No cabinet.
UNIQUE: has wah pedal — wah.enabled=true/false, wah.pedal=0-100 (position).
Modulation (modulation.id): 0=Phaser, 1=Chorus, 2=Tremolo
  Params: p1=rate, p2=depth, p3=mix
Delay (delay.id): 0=Analog, 1=ModulationDelay, 2=Digital
  Params: p1=time, p2=feedback, p3=mix
Reverb (reverb.id): 0=Hall, 1=Plate, 2=Spring
  Params: p1=decay, p2=damp, p3=mix
No EFX, no compressor, no EQ.

Standard device tone guide:
- Lite/8BT clean: amp.id=0, gain 20-35, param6(tone) 50-65
- Lite/8BT crunch: amp.id=0, gain 55-70, param6 50-65
- Lite/8BT high gain: amp.id=0, gain 75-90, param6 45-55
- PlugAir v1 blues: amp.id=2(TweedDlx) or 1(JZ120), gain 35-55, cab DR112(3) or TR212(6)
- PlugAir v1 classic rock: amp.id=3(Plexi), gain 50-65, cab V1960(0)
- PlugAir v1 high gain: amp.id=7(DIEVH4) or 8(Recto), gain 70-85, cab V1960(0)
- PlugAir v2 blues: amp.id=1(DeluxeRvb), gain 35-55, cab DR112(3)
- PlugAir v2 high gain: amp.id=7(DualRect) or 8(DIEVH4v2), gain 70-85
- 20/40BT: amp.id always 0, use bass/mid/treble to shape tone; add wah for funk/wah styles

Standard device BASS guide (plugair_v1, plugair_v2, mightyair_v1, mightyair_v2):
- Bass amps: plugair_v1/mightyair_v1 use AGL(id=12, Aguilar) or MLD(id=11, Ampeg). plugair_v2/mightyair_v2 use AGLv2(id=9) or MLDv2(id=11).
- Bass cabs: BS410(id=2) or AGLDB810(id=8) — dedicated bass cabs. Always prefer these over guitar cabs for bass.
- Bass EFX: BassTS(id=6) is a bass-specific T Screamer — use this instead of id=5 for bass overdrive.
- Gain for standard device bass: clean=12-25, driven=35-50. Never exceed 60 for bass on standard devices.
- No noise gate for bass. Light reverb (Room, p3/mix=12-20) only if requested.

EFX pedal selection guide (Pro devices — ALL params listed must be set — omitting any param defaults it to 0):
- Distortion+ (id=1): p1=output 60-80, p2=sensitivity 55-75; MXR-style hard clipping — hard rock, heavy crunch
- RC Boost / AC Boost (id=2,3): p1=gain 60-80, p2=volume 70-85, p3=bass 50, p4=treble 50; clean transparent boost — push amp into natural breakup
- Katana boost (id=12): p1=boost 60-75, p2=volume 70-85; clean transparent boost
- Dist One RAT (id=4): p1=level 55-75, p2=tone 40-60, p3=drive 55-80; aggressive gritty distortion — punk, indie, alternative, hard rock
- T Screamer TS-808 (id=5): p1=drive 30-60, p2=tone 40-60, p3=level 60-80; mid-hump overdrive — blues leads, classic rock; stack into high-gain amp (p1=30-45) to tighten
- Blues Drive BD-2 (id=6): p1=level 60-80, p2=tone 50-70, p3=gain 40-65; transparent dynamic overdrive — blues, country, light crunch
- Morning Drive (id=7): p1=volume 60-80, p2=drive 45-65, p3=tone 50; warm transparent overdrive — roots rock, classic rock leads
- Eat Dist Big Muff (id=8): p1=distortion 65-90, p2=filter 40-70, p3=volume 60-80; thick sustained fuzz — grunge, stoner rock, shoegaze
- Red Dirt (id=9): p1=drive 40-65, p2=tone 45-55, p3=level 60-80; mid-gain all-rounder overdrive — versatile crunch, country lead
- Crunch (id=10): p1=volume 60-80, p2=tone 50-60, p3=gain 50-65; British amp-style crunch — hard rock
- Muff Fuzz (id=11): p1=volume 60-80, p2=tone 40-60, p3=sustain 70-90; fuzz, slightly brighter voicing — psychedelic rock, Hendrix fuzz, heavy bass
- ST Singer Zendrive (id=13): p1=volume 60-80, p2=gain 40-60, p3=filter 50; smooth vocal overdrive — Santana, woman-tone lead

EFX stacking strategy:
- T Screamer (p1=drive 30-40, p2=tone 50, p3=level 70) → high-gain amp = tighter high gain (classic metal/thrash trick)
- Fuzz (Big Muff/Muff Fuzz) → relatively clean amp = best fuzz tone; do NOT stack fuzz into distorted amp

Compressor usage (Pro devices only — enable for these styles):
- Country, funk, clean single-coil, fingerpicking, slap bass: id=1, p1=55, p2=65
- Sustain on clean leads: id=1, p1=40, p2=70
- Skip compressor for high-gain tones

Device EQ availability:
- plugpro, space: eq.id=1 (6-Band: 100,220,500,1.2k,2.6k,6.4k Hz) or eq.id=3 (10-Band). bands values: -15 to +15 dB.
- litemk2, 8btmk2: NO dedicated EQ slot — approximate using amp bass/mid/treble only.
- plugair/mightyair: no EQ slot — use efx.id=7 (3BandEQ, p1=bass, p2=mid, p3=treble, 0-100, 50=flat) ONLY if EFX slot not needed for a defining effect.
- lite, 8bt, 2040bt: no EQ at all.

Modulation guide (add when it defines the style):
- CE-1 / CE-2 (id=1,2): 80s clean chorus, new wave — p1=rate 30-50, p2=depth 40-60
- ST Chorus (id=3): lush chorus — Nirvana clean, 90s alternative; p1=40, p2=60
- Flanger (id=6): jet-sweep — Van Halen; p1=rate 30-50, p2=depth 60-80
- Phase 90 / Phase 100 (id=7,8): phasing — 70s rock, funk, Hendrix; p1=rate 40-60
- U-Vibe (id=10): rotary/chorus vibe — Hendrix, SRV; p1=rate 40-55, p2=depth 65
- Tremolo (id=11): amplitude tremolo — surf, country, vintage rock; p1=rate 50-70, p2=depth 55-75
- Rotary (id=12): Leslie cabinet — organ-style, Beatles psychedelic; p1=speed 40-60
- Skip modulation for high-gain metal unless specifically part of the tone`

export interface ToneResult {
  params: ProPresetParams
  promptSent: string
  rawToolInput: unknown
  qrString?: string
  nudgeRequired: boolean
  nudgeElapsedMs?: number
  usage: ApiUsage
}

export async function generateToneForSong(
  client: Anthropic,
  song: string,
  artist: string,
  context: string,
  device: DeviceType,
  pickup?: string,
  note?: string,
  model = 'claude-sonnet-4-6',
  instrument: 'guitar' | 'bass' = 'guitar',
): Promise<ToneResult> {
  const noteContext = note ? ` (${note})` : ''

  // Instrument context — explicit flag takes priority, pickup text is also checked as a hint
  const pickupMentionsBass = pickup ? /\bbass\b/i.test(pickup) : false
  const isBass = instrument === 'bass' || pickupMentionsBass

  const instrumentContext = isBass
    ? `\n\nINSTRUMENT: BASS. This is a BASS tone, not guitar. Apply ALL bass-specific rules:
- Pro devices: ALWAYS use BassMate amp (id=3). NEVER use guitar amps for bass.
- Pro devices: ALWAYS use TR212Pro cabinet (id=3) for bass.
- Standard devices (plugair_v1/v2, mightyair_v1/v2): use AGL or MLD bass amps.
- Gain ranges for bass: clean=12-25, warm/punchy=28-42, driven=42-55, fuzz=55-70. Never exceed 75.
- Compressor: ALWAYS add for clean and warm bass tones. RoseComp (id=1), p1=50-60, p2=60-70.
- Noise gate: NEVER enable for bass. Always noise_gate.enabled=false.
- EQ: bass=62-72 for fullness, mid=45-55 for definition, treble=30-45 for warmth.
- No modulation unless explicitly part of the artist's tone.
- No delay unless explicitly part of the artist's tone.
- Reverb: Room only, very sparingly, mix=12-20 maximum.`
    : `\n\nINSTRUMENT: GUITAR. Apply standard guitar tone rules.`

  const pickupContext = pickup
    ? `\n\nSIGNAL CONTEXT: The user's instrument signal is "${pickup}". Adapt the tone for this pickup's characteristics — output level, frequency response, and how it interacts with gain staging.`
    : isBass
    ? `\n\nSIGNAL CONTEXT: No pickup specified. Research the specific bass and pickup the artist used for this recording. Bass players change instruments between studio and live recordings.`
    : `\n\nSIGNAL CONTEXT: No pickup specified. Research the specific guitar and pickup the artist used for THIS recording — not their signature instrument in general. Studio vs live versions differ, different songs may use different guitars. Use web search results to identify the correct guitar and pickup, then dial in the tone for that pickup's characteristics.`

  const promptSent = `Generate a NUX MightyAmp tone preset for "${song}"${noteContext} by ${artist} (${context}) for device: ${device}. Search the web for the tone of this specific recording first, then call generateQR.${instrumentContext}${pickupContext}`

  const usage = emptyUsage()
  let msgs: Anthropic.MessageParam[] = [{ role: 'user', content: promptSent }]

  while (true) {
    const response = await withRetry(
      () => client.messages.create({
        model,
        max_tokens: 1024,
        system: [{ type: 'text', text: TONE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [WEB_SEARCH_TOOL, GENERATE_QR_TOOL],
        messages: msgs,
      }),
      3, `tone for "${song}"`
    )

    accumulateUsage(usage, response)
    msgs = [...msgs, { role: 'assistant', content: response.content }]

    // Find generateQR tool call
    const generateUse = response.content.find(
      b => b.type === 'tool_use' && b.name === 'generateQR'
    )
    if (generateUse && generateUse.type === 'tool_use') {
      const rawToolInput = generateUse.input
      const params = coerceParams(rawToolInput as Record<string, unknown>, device)
      return { params, promptSent, rawToolInput, nudgeRequired: false, usage }
    }

    if (response.stop_reason === 'tool_use') {
      // Feed back tool_results for any other tool_use blocks (e.g. web_search in non-native mode)
      const otherToolUses = response.content.filter(
        b => b.type === 'tool_use' && b.name !== 'generateQR'
      )
      if (otherToolUses.length > 0) {
        msgs = [...msgs, {
          role: 'user',
          content: otherToolUses.map(b => ({
            type: 'tool_result' as const,
            tool_use_id: (b as { id: string }).id,
            content: 'Search completed.',
          })),
        }]
        continue
      }
    }

    // Model stopped without calling generateQR — nudge it once
    const nudgeStart = Date.now()
    msgs = [...msgs, {
      role: 'user',
      content: `Now call the generateQR tool with the tone parameters for "${song}" on device ${device}.`,
    }]

    const nudgeResponse = await withRetry(
      () => client.messages.create({
        model,
        max_tokens: 1024,
        system: [{ type: 'text', text: TONE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [WEB_SEARCH_TOOL, GENERATE_QR_TOOL],
        messages: msgs,
      }),
      3, `tone for "${song}" (nudge)`
    )

    accumulateUsage(usage, nudgeResponse)

    const toolUse = nudgeResponse.content.find(
      b => b.type === 'tool_use' && b.name === 'generateQR'
    )
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(`AI did not call generateQR for "${song}"`)
    }
    const rawToolInput = toolUse.input
    const params = coerceParams(rawToolInput as Record<string, unknown>, device)
    return { params, promptSent, rawToolInput, nudgeRequired: true, nudgeElapsedMs: Date.now() - nudgeStart, usage }
  }
}
