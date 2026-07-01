# @compresh/openclaw-hook

OpenClaw Plugin SDK hook for **per-turn context compression** via [Compresh](https://compre.sh) — episodic memory architecture for LLM conversations.

> **v0.2.0 — breaking change.** This release migrates from the OpenClaw *internal* hook surface (`session:compact:before` / `session:compact:after`) to the **Plugin SDK** (`before_prompt_build` + `llm_output`). The plugin now fires on every model call, not just on native compaction. v0.1.x is deprecated.

## What it does

On every agent turn, the hook intercepts `before_prompt_build`, sends the conversation history to `https://api.compre.sh/v1/tul2`, and appends a Compresh-compressed view of older turns to the system prompt. The protection-zone tail (last 2 / 4 / 8 turns depending on mode) stays raw and untouched in the message list.

Your **provider API key never leaves OpenClaw**. Only the transcript is sent to Compresh, and only when a Compresh API key is configured. Without a key the plugin stays passive.

## Requirements

- **OpenClaw** v2026.5.0 or later
- **Node.js** 18+
- **`compresh-mcp>=0.2.5`** (`pip install --user "compresh-mcp>=0.2.5"`) — the hook
  relays its `compress` result. 0.2.5+ gives tagless compressed context and
  tier-correct LexRank placement (free → local; paid → server `/v1/tul2`).
- A Compresh API key (`sk-comp_...`) — sign up at [compre.sh/signup](https://compre.sh/signup?source=openclaw-hook)

## Install

```bash
openclaw plugins install npm:@compresh/openclaw-hook
```

## Configure

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "compresh": {
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "apiKey": "sk-comp_...",
          "protectionMode": "balanced"
        }
      }
    }
  }
}
```

**`hooks.allowConversationAccess: true` is required.** Non-bundled plugins cannot read raw conversation hooks (`before_prompt_build`, `llm_input`, `llm_output`, etc.) without this opt-in.

## Config options

| Key | Default | Notes |
|---|---|---|
| `apiKey` | `$COMPRESH_API_KEY` | Compresh API key. Required for compression. |
| `endpoint` | `https://api.compre.sh/v1/tul2` | Override for self-hosted Compresh. |
| `protectionMode` | `balanced` | `aggressive` / `balanced` / `conservative` — trailing raw turns (2 / 4 / 8). |
| `providerHint` | `anthropic` | Reported in telemetry for per-provider stats. |
| `modelHint` | `claude-sonnet-4-5` | Reported in telemetry for per-model stats. |
| `minMessages` | `6` | Skip compression below this turn count. |
| `timeoutMs` | `8000` | HTTP timeout for the /v1/tul2 call. |

Env variable fallbacks (`COMPRESH_API_KEY`, `COMPRESH_PROTECTION_MODE`, etc.) work for every option except `endpoint`.

## What you see in logs

```
[compresh] before_prompt_build sid=openclaw-abc12345 applied tier=pro_quarterly compressed=14/22 saving=18420chars
[compresh] llm_output sid=openclaw-abc12345 input=4210 output=850 budget=180000
```

## Pricing

| Tier | Budget required | Savings-share |
|---|---|---|
| Free / no budget | — | 0% (plugin stays passive) |
| Starter (free + loaded budget) | > $0 | 30% |
| Pro Quarterly ($18 / 3 mo) | — | 20% |
| Pro Semi-Annual ($33 / 6 mo) | — | 16% |
| Pro Annual ($60 / yr) | — | 12% |

Top-ups receive a permanent **25% discount** at payment time. Full pricing: [compre.sh/pricing](https://compre.sh/pricing).

## Privacy

- The conversation transcript is sent to `api.compre.sh/v1/tul2` when an API key is set. No transcript leaves your machine without a key.
- Your **provider** API key (the one you use to call Claude / GPT / etc.) stays inside OpenClaw and is never sent to Compresh.
- Per-call savings totals are logged to `/v1/usage/report` for the dashboard. No message content is sent in telemetry.

## Why a hook, not a proxy?

A drop-in proxy means routing your provider key through Compresh — fewer privacy boundaries. A hook keeps the key inside OpenClaw and only inspects the transcript. For users who do not want their provider key to leave their machine, the hook path is the safer integration.

## Related

- Compresh: <https://compre.sh>
- Compresh docs: <https://compre.sh/docs/overview>
- Issues: <https://github.com/compresh/openclaw-hook/issues>
- OpenClaw Plugin SDK: <https://docs.openclaw.ai/plugins/sdk-overview>
- OpenClaw hook catalog: <https://docs.openclaw.ai/plugins/hooks>

## License

MIT
