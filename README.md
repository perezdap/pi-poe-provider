# pi-poe-provider

A [pi](https://github.com/earendil-works/pi-mono) extension that registers
**[Poe](https://poe.com)** as a model provider, backed by Poe's
OpenAI-compatible Chat Completions API (`https://api.poe.com/v1`). One Poe API
key unlocks hundreds of models and bots — Claude, GPT, Gemini, Grok, Kimi,
DeepSeek, and more — billed against your existing Poe subscription points.

## Features

- **Correct per-model context windows and capabilities.** The full model
  catalog — context window, max output tokens, pricing, input modalities
  (text/image), and reasoning support — is discovered at startup from Poe's
  public `/v1/models` endpoint, so every model's context window matches what
  Poe actually advertises.
- **`/login poe` support.** Prompts for and stores your Poe API key (get one at
  <https://poe.com/api/keys>), with `POE_API_KEY` as an automatic fallback.
- **Per-model thinking control, using the knob each bot actually declares:**
  - `reasoning_effort` (GPT-5.x, Kimi, Grok, Seed, ...) — sent inside Poe's
    documented `extra_body` object (the top-level Chat Completions field is
    ignored by Poe).
  - `thinking_level` (Gemini 3.x), `output_effort` (Claude 4.5+), and `effort`
    — pi's effort value is moved into `extra_body` under the bot's declared
    parameter name.
  - `thinking_budget` (Claude budget models, Gemini 2.5, DeepSeek, ...) — a
    per-level token budget, clamped to the bot's declared range.
  - Boolean toggles such as `enable_thinking`, `enable_reasoning`,
    `reasoning_enabled`, and `deep_thinking` — pi's built-in `qwen` thinking
    format supplies the on/off value, renamed to the bot's declared parameter.
  - Pi's thinking levels map to exact enum matches; unsupported levels are
    hidden from the thinking selector. `off` maps to `"none"` when the bot
    offers it, otherwise to the lowest effort the bot accepts (e.g. Gemini 3
    cannot disable thinking).
- **Requests sent exactly as Poe expects:**
  - `Authorization: Bearer <key>`
  - `system` role (Poe proxies to heterogeneous backends; `system` is the one
    role they all accept)
  - `max_completion_tokens`
  - `stream_options.include_usage` for streamed token usage
  - Streamed `reasoning_content` deltas are parsed into pi thinking blocks by
    the built-in `openai-completions` API
  - Function-tool `strict` mode is disabled because Poe currently ignores it

## Install

### As a pi package (recommended)

```sh
pi install git:github.com/perezdap/pi-poe-provider
```

This clones the repo and registers the extension from the `pi` manifest in
`package.json`. Run `pi update --extensions` to pick up new versions.

### Global (all projects), manual

Clone straight into pi's global extensions folder:

```sh
# Windows (PowerShell)
git clone https://github.com/perezdap/pi-poe-provider "$env:USERPROFILE\.pi\agent\extensions\poe"

# macOS / Linux
git clone https://github.com/perezdap/pi-poe-provider ~/.pi/agent/extensions/poe
```

Then start (or `/reload`) pi. The extension auto-loads from
`~/.pi/agent/extensions/poe/index.ts`.

### Project-local

Clone into `<project>/.pi/extensions/poe/` instead. Project-local extensions
load only after the project is trusted.

### Quick test (no install)

```sh
pi -e ./index.ts
```

## Use

```
/login poe           # enter your Poe API key (or export POE_API_KEY first)
/model poe/<id>      # pick a model, e.g. poe/Claude-Sonnet-4.6
```

Set pi's default model in `settings.json` if desired:

```jsonc
{ "defaultProvider": "poe", "defaultModel": "Claude-Sonnet-4.6" }
```

To pick up newly added Poe models, run `/reload` (the factory re-fetches
`/v1/models`).

## How it works

- **Streaming/API:** uses pi's built-in `openai-completions` API. Poe is
  OpenAI-compatible, so no custom streaming code is needed; pi already parses
  `reasoning_content`, tool calls, usage, and `stop` reasons.
- **Auth:** `envApiKeyAuth("Poe API key", ["POE_API_KEY"])` — stored
  credential wins, then `POE_API_KEY` env var.
- **Model discovery:** `GET https://api.poe.com/v1/models` (no auth required),
  filtered to text-output bots that support Chat Completions (bots with an
  empty `supported_endpoints` list use Poe's default chat interface and are
  included). The App-Creator and Script-Bot-Creator bots are excluded —
  [documented](https://creator.poe.com/docs/external-applications/openai-compatible-api)
  as unavailable through this API.
- **Thinking parameters:** model-specific controls are moved into Poe's
  `extra_body` object; parameter renaming and `thinking_budget` injection happen
  in a `before_provider_request` handler scoped to `provider === "poe"`.

## Notes

- Poe's `/v1/models` endpoint requires no auth, so models load even before you
  run `/login`. Requests, however, need a key.
- This extension only wires up text (chat-completion) models. Poe's image,
  video, and audio generation bots are excluded.
- Poe also supports `/v1/responses`, including hosted web search and structured
  outputs. This extension intentionally uses Chat Completions because pi needs
  portable function tools and full local conversation replay; Poe's Chat
  Completions endpoint supports both.
- Poe also offers an
  [Anthropic-compatible endpoint](https://creator.poe.com/docs/external-applications/anthropic-compatible-api)
  (`https://api.poe.com`, Claude models only). It isn't needed here — Claude
  models are reachable through the Chat Completions API like everything else —
  but it's the right choice for Anthropic-SDK-only tools such as Claude Code.
- Context windows come from Poe's structured `context_window` field first.
  For bots where Poe reports nothing, the bot description is parsed for a
  stated window (e.g. "Context Window: 256k"), then a curated table covers
  the remaining well-known chat models (GLM, Kimi, DeepSeek, MiniMax, Qwen,
  GPT-OSS, MiMo, Gemma, Muse, Mistral, Nova, Hunyuan — sourced from the
  vendors' models.dev entries). Only genuinely undocumented utility bots
  (search, transcription, media tools) fall back to a 128k window. Models
  with no reported output limit get a 16k max output default.
- Poe charges subscription points rather than per-token USD; the `pricing`
  fields in `/v1/models` are the per-token USD equivalents and are surfaced as
  per-million-token costs in pi.
