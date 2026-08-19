---
name: speko
description: Use Speko to transcribe audio, synthesize speech, and pick the model for each leg of a voice pipeline from measured benchmarks instead of a hardcoded vendor. One key covers STT, LLM and TTS across 50+ models, with a dry-run route preview, per-language selection, price ceilings and automatic failover. Also places outbound AI phone calls. Use when asked to transcribe a recording or voice note, read something aloud, choose or justify a speech model, work in a language other than English, cap voice spend, or make a phone call.
metadata:
  openclaw:
    requires:
      bins: [curl, jq]
      env: [SPEKO_API_KEY]
---

# Speko

Speko is one API in front of the speech stack. You send audio or text; Speko picks the vendor
per request from its own benchmark readings — measured latency, measured quality, published
price, per language — and fails over when one refuses.

Base URL `https://api.speko.ai/v1`. Auth `Authorization: Bearer $SPEKO_API_KEY`. The key
carries its own routing policy, so a fully configured key needs none of the headers below.

If the Speko plugin is installed, prefer it: `speko_routing_preview` and `speko_models` are
tools, and Speko appears as a model provider, a speech provider and an audio transcription
provider. Use the curl forms here when the plugin is absent, or when you need a stage the
plugin does not wire.

## Pick and justify a stack before spending anything

`/v1/routing/preview` resolves a route with no upstream traffic and no spend. Use it whenever
someone asks which model will be used, or to check that a language or price ceiling produces
the stack they wanted.

```bash
curl -s "https://api.speko.ai/v1/routing/preview?stage=tts&language=hi&objective=quality" \
  -H "Authorization: Bearer $SPEKO_API_KEY" | jq '{id, provider, reason, evidence, measured}'
```

`stage` is `stt`, `llm` or `tts`. `objective` is `latency`, `cost`, `quality` or `balanced`.
`evidence: "measured"` means the pick rests on benchmark data rather than a fallback, and
`measured` is the date window those readings came from. Quote both when you explain a choice —
they are why the answer is trustworthy.

`GET /v1/models` lists every model with its measured numbers. **Only rows with
`routable: true` can be selected or pinned; that list is the only correct source of pin ids.**

## Synthesize speech

```bash
curl -s https://api.speko.ai/v1/audio/speech \
  -H "Authorization: Bearer $SPEKO_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","input":"Your text here.","response_format":"wav"}' -o out.wav
```

- **Always send `response_format: "wav"`.** The default is headerless raw PCM at 24 kHz, which
  no player opens. Encoded formats such as mp3 are refused before any upstream request.
- Use this buffered route, not `/v1/audio/speech/stream`. The streaming route has no
  empty-body guard: under concurrency it can commit a `200` and then return zero bytes, while
  the buffered route answers `502` with a failover count. **Assert on bytes, not status.**
- `instructions` gives delivery direction — speaking style or accent — without changing the
  transcript. `voice` and `speed` are passed through where the vendor supports them.

## Transcribe audio

```bash
curl -s https://api.speko.ai/v1/audio/transcriptions \
  -H "Authorization: Bearer $SPEKO_API_KEY" \
  -F file=@note.wav -F model=auto -F language=en | jq -r .text
```

- `model` is required; `auto` hands the choice to the benchmark ranking.
- **Let curl set the multipart `Content-Type`.** Overriding it destroys the boundary and the
  router answers `502`.
- The response is normalized to `{"text": "..."}` no matter which vendor answered.
- A pinned model plus an incompatible container is how you get a `502` here — audio
  compatibility narrows the candidate set.

## Steer the routing

Any request accepts these headers, and a request header always beats the key's policy:

| Header | Effect |
| --- | --- |
| `X-Speko-Language` | BCP 47. Drives benchmark selection and the vendor's own language setting. Regional tags (`es-MX`) are fine. |
| `X-Speko-Objective` | `latency`, `cost`, `quality` or `balanced`. Which measured axis wins when candidates tie. |
| `X-Speko-Allow` | CSV of `provider:model`. Restricts candidates **and** replaces the key's chain. Bare provider names match nothing. |
| `X-Speko-Deny` | CSV of `provider:model`. Excludes candidates without clearing the chain. |
| `X-Speko-Max-Price` | Ceiling in the stage's own unit: STT USD/minute, LLM USD/1M tokens, TTS USD/1M characters. Candidates with no published price are excluded once set. |

Read back what actually happened: `x-route` is the vendor and model that answered,
`x-route-reason` is why, `x-speko-failover-count` is how many candidates refused first.
**Read `x-route` rather than assuming a pin won.**

## Route an LLM turn

`/v1/chat/completions` is OpenAI-shaped, so any OpenAI client works unchanged with
`base_url=https://api.speko.ai/v1`. `model: "auto"` routes on benchmarks; a routable id pins.

## Place an outbound AI phone call

Telephony lives on a **different host and needs a different key**: the platform API at
`https://api.speko.dev/v1` with a platform key. It does not share credentials with the router.

```bash
curl -s https://api.speko.dev/v1/sessions/phone \
  -H "Authorization: Bearer $SPEKO_PLATFORM_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","intent":{"language":"en"},"systemPrompt":"You are..."}'
```

Only `to` is required, in E.164. Either `agentId` or `intent` — an ad-hoc call needs no
pre-created agent. `from` must be a number the org owns; `GET /v1/phone-numbers` lists them
(kebab-case — `/v1/phone_numbers` 404s). Poll `GET /v1/calls/{id}` for status and transcript.

**Confirm the number and the purpose with the user before dialing.** A call rings a real
phone and cannot be undone.

## Gotchas

- Two hosts, two keys: `api.speko.ai` is the router (STT/LLM/TTS), `api.speko.dev` is the
  platform (agents, phone numbers, calls). A key for one returns 401 on the other.
- Keys are environment-scoped: a staging key fails against production.
- `X-Speko-Allow` with a bare provider name silently matches nothing. Always `provider:model`.
- A `200` from a streaming TTS route can still be empty. Check the byte count.
- Non-WAV audio posted to the platform's raw-body transcribe endpoint can return `200` with an
  empty transcript and no error. Convert to mono 24 kHz WAV first:
  `ffmpeg -i in.ogg -ac 1 -ar 24000 -f wav out.wav`.
