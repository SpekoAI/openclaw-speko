# Speko for OpenClaw

Speko is one API in front of the speech stack. This plugin wires it into OpenClaw at four
seams from a single key: the model provider, the speech provider, audio transcription, and two
tools that make the routing inspectable.

Every request is routed on Speko's own benchmark readings — measured latency, measured
quality, published price, per language — across 50+ models, with failover when a vendor
refuses. Telephony is one thing you can do with that; it is not the point.

## Install

```bash
openclaw plugins install clawhub:openclaw-plugin-speko
export SPEKO_API_KEY=sk_live_...
```

Then pick `speko/auto` as your model, or point speech and transcription at `speko`.

## What it registers

| Seam | What you get |
| --- | --- |
| Model provider `speko` | `speko/auto` routes an LLM turn on benchmarks; every routable model is also pinnable by id. OpenAI-compatible under the hood. |
| Speech provider `speko` | `POST /v1/audio/speech` as WAV, so voice replies and the voice-call plugin's TTS both route through Speko. |
| Media understanding `speko` (audio) | Voice notes and recordings transcribe through `POST /v1/audio/transcriptions`. |
| Tools | `speko_routing_preview` dry-runs a route with no spend; `speko_models` lists routable models with their measured numbers. |

`speko_routing_preview` is the one worth knowing about. It answers "which model will you use,
and why" before anything is spent:

```
TTS route: Inworld inworld-tts-2 (inworld:inworld-tts-2)
reason: best-for-objective | objective: balanced | evidence: measured
language: en (measured)
benchmark window: 2026-07-21..2026-08-05
passed over: Deepgram aura-2 (0.734), Smallest AI lightning_v3.1 (0.708), Speechify simba-3.2 (0.688)
```

## Configure

The API key carries its own routing policy, so the config block is only needed to override it.
Anything you set here is sent as an `X-Speko-*` header, and a request header always beats the
key's policy.

```json
{
  "plugins": {
    "entries": {
      "speko": {
        "config": {
          "language": "en",
          "objective": "quality",
          "maxPrice": 40,
          "deny": ["elevenlabs:eleven_v3"],
          "tts": { "instructions": "Warm, unhurried." }
        }
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `language` | BCP 47, **default `en`**. Drives benchmark selection and the vendor's own language setting. Set `"auto"` to send no language header and defer to the API key's own routing policy. |
| `objective` | `latency`, `cost`, `quality` or `balanced` — which measured axis wins on a tie. |
| `allow` | Candidate allow-list. Must be `provider:model`; bare provider names match nothing. It also replaces the key's chain. |
| `deny` | Candidate deny-list. Does not clear the key's chain. |
| `maxPrice` | Ceiling in the routed stage's unit: STT USD/minute, LLM USD/1M tokens, TTS USD/1M characters. |
| `tts` / `stt` | Per-stage `model` filter, plus `voice`, `instructions` and `speed` for speech. |

Get pin ids from `speko_models` or `GET /v1/models`. Only rows with `routable: true` can be
selected or pinned.

## Notes worth reading before you debug something

- **Speech asks for WAV on purpose.** The router's default body is headerless raw PCM at
  24 kHz, which no player opens, and it refuses encoded formats such as mp3 outright.
- **Speech uses the buffered route, not the streaming one.** `/v1/audio/speech/stream` has no
  empty-body guard: under concurrency it can commit a `200` and then return zero bytes, while
  the buffered route answers `502` with a failover count. The plugin also rejects a `200` that
  carries no audio, so a silent failure surfaces as an error rather than as silence.
- **OpenClaw's cost column is an approximation here.** Speko publishes one blended
  USD/1M-token figure per model rather than separate input and output prices, so both sides
  carry the same number. A model with no published price reports zero and says so in its label.
- **Context windows are conservative defaults.** `/v1/models` does not publish a per-vendor
  window, and the router holds the real one, so this plugin advertises 128k rather than
  guessing higher.
- **The language default is deliberate.** Without a language header the router falls back to
  whatever the API key's policy carries, which is invisible from OpenClaw and is not always
  English — a first run could quietly come back in another language and read as a bug. So the
  plugin sends `en` unless you set `language`. Use `"auto"` to hand the choice back to the key.
- **Trusting the plugin for agent runs needs one line.** OpenClaw will not auto-trust a
  non-bundled plugin's tools until you allow it: `"plugins": { "allow": ["speko"] }`.
- **Telephony is a different host and a different key.** Outbound AI calls live on the
  platform API at `api.speko.dev` with a platform key, not the router key. The companion
  `speko` skill covers that surface.

## Develop

```bash
bun install
bunx tsc -p tsconfig.json
bun run test
```

To load it from source into a throwaway OpenClaw state dir:

```bash
OPENCLAW_HOME=/tmp/oc OPENCLAW_STATE_DIR=/tmp/oc/state OPENCLAW_CONFIG_PATH=/tmp/oc/openclaw.json \
  openclaw plugins install . && openclaw plugins inspect speko --runtime --json
```

## License

MIT
