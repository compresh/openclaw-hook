# @compresh/openclaw-hook

OpenClaw Plugin SDK hook for **per-turn context compression** via [Compresh](https://compre.sh) — episodic memory architecture for LLM conversations.

## What it does

On every agent turn, the hook intercepts `before_prompt_build`, relays the conversation history to a local [`compresh-mcp`](https://pypi.org/project/compresh-mcp/) process, and appends a compressed view of older turns to the system prompt. The protection-zone tail (last 2 / 4 / 8 turns depending on mode) stays raw and untouched in the message list.

**Works with or without an account:**

- **No Compresh key** → compression runs **locally and free** (open-source `tulbase` core: extractive LexRank summarization — fast, private, lossy). Nothing is sent anywhere.
- **With a Compresh key** → paid models get **TUL 2.0**: query-aware retrieval on Compresh infrastructure. Instead of summarizing, it pulls the full, unedited older turns relevant to the current question — lossless.

Your **provider API key never leaves OpenClaw** in either mode. Only the transcript is sent to `api.compre.sh` — and only when a Compresh key is configured.

## Requirements

- **OpenClaw** v2026.5.0 or later
- **Node.js** 18+
- **`compresh-mcp>=0.3.2`** (`pipx install compresh-mcp` or `pip install --user "compresh-mcp>=0.3.2"`) — the hook relays its `compress` result.

A Compresh API key (`sk-comp_...`) is **optional**. Get one with either:

```bash
compresh-mcp signup you@example.com   # email-only signup, no card
compresh-mcp login --github           # or sign in with GitHub
```

New accounts include a **5-day free TUL 2.0 trial** (no card, no commitment). Verify your email — or sign in with GitHub, which counts as verified — and you get **$30 of free Compresh credit** (we waive our savings-share up to $30). When the trial ends with no credit, the hook falls back to free local tulbase automatically; you never lose compression.

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
          "protectionMode": "balanced"
        }
      }
    }
  }
}
```

Add `"apiKey": "sk-comp_..."` to `config` to unlock TUL 2.0. Without it the plugin still compresses locally (free tulbase) and shows a one-time note about the upgrade path.

**`hooks.allowConversationAccess: true` is required.** Non-bundled plugins cannot read raw conversation hooks (`before_prompt_build`, `llm_input`, `llm_output`, etc.) without this opt-in.

## Config options

| Key | Default | Notes |
|---|---|---|
| `apiKey` | `$COMPRESH_API_KEY` | Optional. Unlocks TUL 2.0 retrieval on paid models; without it compression is local tulbase. |
| `binPath` | `compresh-mcp` | Path to the compresh-mcp executable (`$COMPRESH_BIN`). |
| `binArgs` | — | Extra arguments passed to compresh-mcp (`$COMPRESH_BIN_ARGS`). |
| `protectionMode` | `balanced` | `aggressive` / `balanced` / `conservative` — trailing raw turns (2 / 4 / 8). |
| `providerHint` | `anthropic` | Reported in telemetry for per-provider stats. |
| `modelHint` | `claude-sonnet-4-5` | Reported in telemetry for per-model stats. |
| `minMessages` | `6` | Skip compression below this turn count. |
| `timeoutMs` | `8000` | Timeout for the compress call. |

Env variable fallbacks (`COMPRESH_API_KEY`, `COMPRESH_PROTECTION_MODE`, etc.) work for every option.

## What you see in logs

```
[compresh] before_prompt_build sid=openclaw-abc12345 applied tier=pro_quarterly compressed=14/22 saving=18420chars
[compresh] llm_output sid=openclaw-abc12345 input=4210 output=850 budget=180000
```

## Pricing

| Tier | Budget required | Savings-share |
|---|---|---|
| No key / free / local models | — | 0% (free local tulbase compression) |
| Starter (free + loaded budget) | > $0 | 30% |
| Pro Quarterly ($18 / 3 mo) | — | 20% |
| Pro Semi-Annual ($33 / 6 mo) | — | 16% |
| Pro Annual ($60 / yr) | — | 12% |

Every verified account gets **$30 free credit**. Top-ups receive a permanent **25% discount** at payment time. Full pricing: [compre.sh/pricing](https://compre.sh/pricing).

## Privacy

- **Without a Compresh key, nothing leaves your machine** — compression is fully local.
- With a key, the conversation transcript is sent to `api.compre.sh/v1/tul2` for retrieval. Processing is in-flight; no message content is stored.
- Your **provider** API key (the one you use to call Claude / GPT / etc.) stays inside OpenClaw and is never sent to Compresh, in any mode.
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
