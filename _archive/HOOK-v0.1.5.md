---
name: compresh-compaction
description: "Transparent context compression via Compresh — call compresh-mcp on session compaction events"
metadata:
  {
    "openclaw": {
      "emoji": "🗜️",
      "events": ["session:compact:before", "session:compact:after"],
      "always": true,
      "requires": {
        "bins": ["python3"]
      },
      "install": {
        "npm": "@compresh/openclaw-hook",
        "prerequisite": "pip install compresh-mcp"
      }
    }
  }
---

# Compresh Compaction Hook

Transparent context compression for OpenClaw sessions using Compresh's episodic
memory architecture.

## What it does

When OpenClaw is about to compact a long session, this hook intercepts the
`session:compact:before` event and calls the Compresh MCP server (running
locally as a Python subprocess) to compress the transcript using:

- **Q-protective ranking** (Tulving-grounded categorization)
- **Protection Zone** (last N messages stay raw)
- **Modality elision** (tool results, code blocks, terminal output)
- **Epistemic markers** (verified / hearsay / corrected / uncertain / contradicted)

The compressed result is reported via telemetry. The native OpenClaw
compaction continues, but you gain:

- Visibility into how much would be saved with Compresh
- Optional paid tier: full TUL 1.0 server-side enhancement (Q matrix +
  epistemic + advanced modality)

## Requirements

- **Python 3.10+** with `compresh-mcp` installed:
  ```bash
  pip install compresh-mcp
  ```
- **Node.js 18+** (OpenClaw runtime requirement)
- Optional: `COMPRESH_API_KEY` for TUL 1.0 server-side enhancement

## Installation

```bash
# Install the Python MCP server
pip install compresh-mcp

# Install the hook via mcporter (recommended)
mcporter install @compresh/openclaw-hook --target openclaw

# Or manually
cd ~/.openclaw/hooks
git clone https://github.com/compresh/openclaw-hook compresh-compaction
cd compresh-compaction && npm install && npm run build
```

## Enable

```bash
openclaw hooks enable compresh-compaction
```

Or in `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "compresh-compaction": {
          "enabled": true,
          "env": {
            "COMPRESH_API_KEY": "sk-comp_..."
          }
        }
      }
    }
  }
}
```

## Modes

| Mode | API key | Behaviour |
|---|---|---|
| **Local-only (free)** | unset | tulbase Q-protective ranking + Protection Zone, no telemetry, no fee |
| **Hybrid (paid)** | set | tulbase + TUL 1.0 server enhancement, telemetry to compre.sh, fee on tul1_saving |

Pricing (Mod C):

| Tier | Budget | TUL 1.0 access | Savings-share |
|---|---|---|---|
| Anonymous | n/a | ❌ | 0% (free, tulbase only) |
| Free / no budget | $0 | ❌ | 0% (free, tulbase only) |
| **Starter** (free + loaded budget) | > $0 | ✅ | **30%** |
| **Pro Quarterly** ($18 / 3 mo) | n/a | ✅ | **20%** |
| **Pro Semi-Annual** ($33 / 6 mo) | n/a | ✅ | **16%** |
| **Pro Annual** ($60 / yr) | n/a | ✅ | **12%** |

All top-ups receive a permanent **25% discount** at payment time (load $10 → pay $7.50). See [compre.sh/pricing](https://compre.sh/pricing) for the full pricing page.

Get an API key at https://compre.sh/signup.

## Events handled

- **session:compact:before** — fires before OpenClaw summarizes history.
  The hook reads `context.messageCount` and `context.tokenCount`, then
  invokes the local `compresh-mcp` server's `compress` tool to produce a
  Compresh-compressed view. The result is logged for telemetry.

- **session:compact:after** — fires after compaction completes. The hook
  compares Compresh's projected savings to OpenClaw's actual compaction
  delta (`context.tokensBefore` → `context.tokensAfter`) and reports the
  diff.

## Why a hook (not a model provider)

OpenClaw model providers route the entire request through a custom endpoint.
Compresh-as-hook is different: your API key stays in OpenClaw (with the
real LLM provider) and Compresh only inspects the transcript to compute
compression metrics. Your provider key is never sent to api.compre.sh.

## Related links

- Compresh: https://compre.sh
- Documentation: https://compre.sh/docs/overview
- compresh-mcp (Python, BUSL-1.1): https://github.com/compresh/compresh-mcp
- tulbase (Python, MIT, open core): https://github.com/compresh/tulbase
- Issues: https://github.com/compresh/openclaw-hook/issues
