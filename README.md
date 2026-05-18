# @compresh/openclaw-hook

OpenClaw hook for transparent context compression via Compresh — episodic memory architecture for LLMs.

## What this is

A small OpenClaw internal hook (~250 LoC) that fires on `session:compact:before` and `session:compact:after` events. It calls the local `compresh-mcp` Python server (over stdio MCP) to compute a Compresh-compressed view of the transcript.

You keep your provider API key. Compresh only inspects the transcript locally and (optionally, with an API key) sends a sanitised request to `api.compre.sh` for the TUL 1.0 advanced layer.

## How it differs from a proxy

| Layer | Drop-in proxy (Mod A) | This hook (Mod B) |
|---|---|---|
| Provider API key | sent to api.compre.sh | stays in OpenClaw |
| LLM call route | agent → api.compre.sh → provider | agent → provider (direct) |
| Compresh runs | server-side | local Python (`compresh-mcp`) |
| TUL 1.0 advanced layer | always server-side | optional, server-side only when `COMPRESH_API_KEY` is set |
| Privacy | medium | high |

## Requirements

- **OpenClaw** gateway
- **Python 3.10+** with `compresh-mcp` installed
- **Node.js 18+** (OpenClaw runtime)

## Install

```bash
# 1. Install the Python MCP server (local-only, free tier)
#    macOS recommends pipx (system Python is PEP 668 protected):
brew install pipx && pipx ensurepath
pipx install compresh-mcp
#    Linux / managed Python:
#    pip install compresh-mcp

# 2. Install the hook into OpenClaw
openclaw plugins install @compresh/openclaw-hook

# 3. Enable
openclaw hooks enable compresh-compaction
```

For paid tier (TUL 1.0 server enhancement), set `COMPRESH_API_KEY`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "compresh-compaction": {
          "enabled": true,
          "env": { "COMPRESH_API_KEY": "sk-comp_xxx" }
        }
      }
    }
  }
}
```

Get an API key at https://compre.sh/signup.

## Pricing

| Tier | Budget | TUL 1.0 access | Savings-share |
|---|---|---|---|
| Anonymous / no key | n/a | ❌ | 0% (free, tulbase only) |
| Free / no budget | $0 | ❌ | 0% (free, tulbase only) |
| **Starter** (free + loaded budget) | > $0 | ✅ | **30%** |
| **Pro Quarterly** ($18 / 3 mo) | n/a | ✅ | **20%** |
| **Pro Semi-Annual** ($33 / 6 mo) | n/a | ✅ | **16%** |
| **Pro Annual** ($60 / yr) | n/a | ✅ | **12%** |

All top-ups receive a permanent **25% discount** at payment time (load $10 → pay $7.50). See [compre.sh/pricing](https://compre.sh/pricing) for the full pricing page.

You only pay for the savings the TUL 1.0 server layer adds on top of what `tulbase` (local, MIT) already gave you for free.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `COMPRESH_API_KEY` | unset | Enables TUL 1.0 server enhancement. Leave unset for free local-only mode |
| `COMPRESH_PYTHON_BIN` | `python3` | Path to Python interpreter that has `compresh-mcp` installed |
| `COMPRESH_PROTECTION_MODE` | `balanced` | `agresif` / `balanced` / `muhafazakar` — last N raw messages |
| `COMPRESH_PROVIDER_HINT` | `anthropic` | Reported in telemetry for per-provider stats |
| `COMPRESH_MODEL_HINT` | `claude-sonnet-4-5` | Reported in telemetry for per-model stats |

## What you see in logs

```
[compresh-hook] session:compact:before session-abc-123 — applied=true, tier=free, messages=42 (87432 chars), saving=21105 chars (24.1%), protection=balanced
[compresh-hook] session:compact:after session-abc-123 | native: 18450 → 4210 tok (Δ14240) | compresh: 21105 chars saved | tier=free
```

This visibility is the main short-term value: you see what Compresh would save vs what OpenClaw's native compaction does. From there you can decide whether to switch to a drop-in proxy (Mod A) or stay on hook-mode.

## Privacy

- Transcript is processed locally by `compresh-mcp` (Python) using the bundled open-source `tulbase` core (LexRank + Protection Zone + modality elision). Your provider key never leaves OpenClaw.
- If `COMPRESH_API_KEY` is set, the transcript is also sent to `api.compre.sh/v1/tul1` for the TUL 1.0 server-side enhancement (Q-protective ranking, epistemic markers). The local result is used as a fallback if the server is unreachable. Your provider key is never sent.
- Telemetry: per-call savings totals are reported (no message content) to `api.compre.sh/v1/usage/report` to compute Mod C fees.

## Architecture

```
OpenClaw gateway
   │
   ├─ session:compact:before fires
   │     │
   │     └─→ this hook
   │             │
   │             ├─→ Python subprocess: compresh-mcp (stdio MCP)
   │             │       │
   │             │       ├─→ tulbase compress (local, MIT, free)
   │             │       │
   │             │       └─→ (if COMPRESH_API_KEY) → api.compre.sh/v1/tul1
   │             │             ├─ tier/budget check
   │             │             └─ TUL 1.0 enhance (Q matrix + epistemic + modality)
   │             │
   │             └─→ telemetry → api.compre.sh/v1/usage/report
   │
   └─ OpenClaw runs its own compaction + sends to your LLM provider with your key
```

## License

MIT — Compresh Ltd, 2026.

## Related

- Compresh: https://compre.sh
- Documentation: https://compre.sh/docs/overview
- compresh-mcp (Python, BUSL-1.1): https://github.com/compresh/compresh-mcp
- tulbase (Python, MIT, open core): https://github.com/compresh/tulbase
- Issues: https://github.com/compresh/openclaw-hook/issues
- Support: hello@compre.sh
