/**
 * Compresh OpenClaw Hook — transparent context compression
 *
 * Listens for session:compact events from the OpenClaw gateway and calls
 * the local compresh-mcp Python server (over stdio MCP) to compute a
 * Compresh-compressed view of the transcript.
 *
 * Modes:
 *   - Local-only: tulbase Q-protective ranking + Protection Zone (free)
 *   - Hybrid: + TUL 1.0 server enhancement when COMPRESH_API_KEY is set
 *
 * Telemetry is handled by compresh-mcp itself (POST /v1/usage/report).
 * This hook is a thin glue layer.
 *
 * @license MIT
 * @author Compresh Ltd <hello@compre.sh>
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ─────────────────────────────────────────────────────────────────
// Types — kept loose because OpenClaw event shape varies across builds
// ─────────────────────────────────────────────────────────────────

type AnyMessage = { role: string; content: unknown };

interface OpenClawEvent {
  type: string;
  action?: string;
  sessionKey?: string;
  timestamp?: number;
  messages?: unknown[];
  context?: Record<string, unknown> & {
    messageCount?: number;
    tokenCount?: number;
    tokensBefore?: number;
    tokensAfter?: number;
    compactedCount?: number;
    summaryLength?: number;
    transcript?: AnyMessage[];
    cfg?: Record<string, unknown>;
  };
}

interface CompressResult {
  ok: boolean;
  applied: boolean;
  reason?: string;
  optimized_messages?: AnyMessage[];
  compresh_md?: string;
  raw_tail?: AnyMessage[];
  n_compressed_turns?: number;
  n_total?: number;
  saving_chars?: number;
  session_id?: string;
  protection_mode?: string;
  tier?: string;
}

// ─────────────────────────────────────────────────────────────────
// Configuration — read once at module load
// ─────────────────────────────────────────────────────────────────

const COMPRESH_API_KEY = process.env.COMPRESH_API_KEY ?? '';

// Default: launch the standalone `compresh-mcp` binary that pipx /
// pip install puts on PATH. Override via COMPRESH_BIN_OVERRIDE for
// custom Python interpreters (e.g. legacy `python3 -m compresh_mcp.server`).
//
// Why not `python3 -m compresh_mcp.server`? When `compresh-mcp` is
// installed via pipx (recommended on macOS), the package lives in
// an isolated venv. The system `python3` cannot import
// `compresh_mcp.server` — the subprocess exits immediately.
// The `compresh-mcp` shim script is the only entry point that
// reliably resolves the right Python interpreter on all platforms.
const COMPRESH_BIN = process.env.COMPRESH_BIN ?? 'compresh-mcp';
const COMPRESH_BIN_ARGS = (process.env.COMPRESH_BIN_ARGS ?? '')
  .split(' ')
  .filter((s) => s.length > 0);
const PROTECTION_MODE =
  (process.env.COMPRESH_PROTECTION_MODE as 'agresif' | 'balanced' | 'muhafazakar') ?? 'balanced';
const PROVIDER_HINT = process.env.COMPRESH_PROVIDER_HINT ?? 'anthropic';
const MODEL_HINT = process.env.COMPRESH_MODEL_HINT ?? 'claude-sonnet-4-5';

// Cached MCP client — start once, reuse across events
let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let mcpConnectPromise: Promise<void> | null = null;

// ─────────────────────────────────────────────────────────────────
// MCP client lifecycle
// ─────────────────────────────────────────────────────────────────

async function ensureMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  if (!mcpConnectPromise) {
    mcpConnectPromise = (async () => {
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (COMPRESH_API_KEY) env.COMPRESH_API_KEY = COMPRESH_API_KEY;

      mcpTransport = new StdioClientTransport({
        command: COMPRESH_BIN,
        args: COMPRESH_BIN_ARGS,
        env,
      });

      const client = new Client(
        { name: 'compresh-openclaw-hook', version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(mcpTransport);
      mcpClient = client;
    })();
  }

  await mcpConnectPromise;
  if (!mcpClient) {
    throw new Error('[compresh-hook] MCP client failed to initialise');
  }
  return mcpClient;
}

async function shutdownMcpClient(): Promise<void> {
  try {
    await mcpClient?.close();
  } catch {
    /* swallow */
  }
  mcpClient = null;
  mcpTransport = null;
  mcpConnectPromise = null;
}

// ─────────────────────────────────────────────────────────────────
// Transcript extraction — try several plausible event shapes
//
// OpenClaw (>= 2026.05) does NOT put the transcript directly in
// event.context. Instead, context carries pointers to the session
// JSONL file:
//
//   event.context.previousSessionEntry.sessionFile
//   event.context.sessionEntry.sessionFile
//
// The JSONL is line-delimited; entries with type === "message" hold
// the actual chat messages (role + content). This is the same shape
// the bundled session-memory hook reads.
// ─────────────────────────────────────────────────────────────────

function normalizeContent(content: unknown): string {
  // compresh-mcp's `compress` tool expects `content: string` per message.
  // OpenClaw session JSONLs (and Anthropic SDK output in general) often
  // carry block arrays: [{type: "text", text: "..."}, {type: "tool_use", ...}].
  // Flatten to a single string so downstream compression treats the turn
  // as one unit.
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== 'object') {
        parts.push(String(block));
        continue;
      }
      const b = block as Record<string, unknown>;
      const btype = typeof b.type === 'string' ? (b.type as string) : '';
      if (btype === 'text' && typeof b.text === 'string') {
        parts.push(b.text as string);
      } else if (btype === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : '?';
        parts.push(`[tool_use ${name}]`);
      } else if (btype === 'tool_result') {
        const inner = b.content;
        parts.push(
          typeof inner === 'string' ? inner : JSON.stringify(inner ?? null)
        );
      } else if (btype === 'image') {
        parts.push('[image]');
      } else {
        parts.push(JSON.stringify(b));
      }
    }
    return parts.filter((s) => s.length > 0).join('\n');
  }
  return JSON.stringify(content);
}

async function readJsonlMessages(filePath: string): Promise<AnyMessage[] | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const messages: AnyMessage[] = [];
    for (const line of content.trim().split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type === 'message' && entry.message) {
          const m = entry.message;
          if (
            (m.role === 'user' || m.role === 'assistant') &&
            m.content !== undefined &&
            m.content !== null
          ) {
            const normalizedContent = normalizeContent(m.content);
            if (normalizedContent.length > 0) {
              messages.push({ role: m.role, content: normalizedContent });
            }
          }
        }
      } catch {
        // skip malformed line
      }
    }
    return messages.length > 0 ? messages : null;
  } catch {
    return null;
  }
}

async function findRecentSessionJsonl(): Promise<string | null> {
  // OpenClaw stores session JSONLs under one of these locations:
  //   ~/.openclaw/workspace/sessions/<sessionId>.jsonl
  //   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
  // Without a direct context pointer we pick the most recently
  // modified .jsonl across both candidates.
  const home = process.env.HOME || os.homedir();
  const candidates = [
    process.env.OPENCLAW_WORKSPACE_DIR
      ? path.join(process.env.OPENCLAW_WORKSPACE_DIR, 'sessions')
      : null,
    path.join(home, '.openclaw', 'workspace', 'sessions'),
    path.join(home, '.openclaw', 'agents', 'main', 'sessions'),
  ].filter((p): p is string => Boolean(p));

  let best: { file: string; mtime: number } | null = null;
  for (const dir of candidates) {
    try {
      const entries = await fs.readdir(dir);
      for (const name of entries) {
        if (!name.endsWith('.jsonl') || name.includes('.reset.')) continue;
        const fp = path.join(dir, name);
        try {
          const stat = await fs.stat(fp);
          if (!best || stat.mtimeMs > best.mtime) {
            best = { file: fp, mtime: stat.mtimeMs };
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* dir does not exist */
    }
  }
  return best?.file ?? null;
}

async function extractTranscript(event: OpenClawEvent): Promise<AnyMessage[] | null> {
  const ctx = event.context ?? {};

  // ── Debug: log what's actually in the event so we can see what
  //    fields OpenClaw populates for compaction events. Strip down to
  //    key names to avoid leaking content into logs.
  try {
    const ctxKeys = Object.keys(ctx).sort().join(', ');
    const sessionKey = (event as { sessionKey?: unknown }).sessionKey;
    console.log(
      `[compresh-hook] event.context keys: [${ctxKeys}] | event.sessionKey: ${
        typeof sessionKey === 'string' ? sessionKey : 'n/a'
      }`
    );
  } catch {
    /* swallow logging errors */
  }

  // 1) Defensive — earlier OpenClaw versions or other gateways may
  //    embed messages directly.
  if (Array.isArray(ctx.transcript) && ctx.transcript.length > 0) {
    return ctx.transcript as AnyMessage[];
  }
  const inlineMessages = (ctx as Record<string, unknown>).messages;
  if (Array.isArray(inlineMessages) && inlineMessages.length > 0) {
    return inlineMessages as AnyMessage[];
  }
  const inlineHistory = (ctx as Record<string, unknown>).history;
  if (Array.isArray(inlineHistory) && inlineHistory.length > 0) {
    return inlineHistory as AnyMessage[];
  }

  // 2) OpenClaw bundled-hook pattern — context may carry a sessionEntry
  //    object with a `sessionFile` JSONL pointer. Read & parse.
  const sessionEntry = ((ctx as Record<string, unknown>).previousSessionEntry
    ?? (ctx as Record<string, unknown>).sessionEntry
    ?? {}) as Record<string, unknown>;
  const sessionFile = sessionEntry.sessionFile;
  if (typeof sessionFile === 'string' && sessionFile.length > 0) {
    console.log(`[compresh-hook] using sessionEntry.sessionFile: ${sessionFile}`);
    return await readJsonlMessages(sessionFile);
  }

  // 3) Last-resort fallback — scan default session directories for the
  //    most recently modified JSONL. Works for compaction events where
  //    context only carries metadata (messageCount/tokensBefore/etc).
  const recent = await findRecentSessionJsonl();
  if (recent) {
    console.log(`[compresh-hook] fallback: scanning most recent session jsonl: ${recent}`);
    return await readJsonlMessages(recent);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// Compress call
// ─────────────────────────────────────────────────────────────────

async function callCompress(
  sessionId: string,
  messages: AnyMessage[]
): Promise<CompressResult | null> {
  try {
    const client = await ensureMcpClient();

    const result = await client.callTool({
      name: 'compress',
      arguments: {
        session_id: sessionId,
        messages,
        protection_mode: PROTECTION_MODE,
        provider_hint: PROVIDER_HINT,
        model_hint: MODEL_HINT,
      },
    });

    // MCP wraps the response in `content` array; the actual payload is the
    // first text item parsed as JSON.
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(content) || content.length === 0) {
      return null;
    }

    const first = content[0];
    if (first.type !== 'text' || !first.text) {
      return null;
    }

    return JSON.parse(first.text) as CompressResult;
  } catch (err) {
    console.error('[compresh-hook] callCompress failed:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Pretty-print helpers
// ─────────────────────────────────────────────────────────────────

function pctSaving(savedChars: number, totalChars: number): string {
  if (totalChars <= 0) return '0%';
  return `${((savedChars / totalChars) * 100).toFixed(1)}%`;
}

function approxChars(messages: AnyMessage[]): number {
  return messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
}

// ─────────────────────────────────────────────────────────────────
// Event handler — the function OpenClaw imports
// ─────────────────────────────────────────────────────────────────

export default async function handler(event: OpenClawEvent): Promise<void> {
  if (event.type !== 'session') return;

  const action = event.action ?? '';
  if (action !== 'compact:before' && action !== 'compact:after') return;

  const sessionId = event.sessionKey ?? `openclaw-${Date.now()}`;

  // ── session:compact:before ──────────────────────────────────────
  if (action === 'compact:before') {
    const transcript = await extractTranscript(event);
    if (!transcript) {
      console.log(
        `[compresh-hook] session:compact:before for ${sessionId} — no transcript in event.context; skipping`
      );
      return;
    }

    const totalChars = approxChars(transcript);
    const result = await callCompress(sessionId, transcript);

    if (!result || !result.ok) {
      console.log(
        `[compresh-hook] compress failed for ${sessionId}; messages=${transcript.length}, chars=${totalChars}`
      );
      return;
    }

    const saving = result.saving_chars ?? 0;
    const tier = result.tier ?? 'unknown';
    const applied = result.applied ?? false;

    console.log(
      `[compresh-hook] session:compact:before ${sessionId} — applied=${applied}, ` +
        `tier=${tier}, messages=${transcript.length} (${totalChars} chars), ` +
        `saving=${saving} chars (${pctSaving(saving, totalChars)}), ` +
        `protection=${result.protection_mode ?? PROTECTION_MODE}`
    );

    // Stash result on the event context so the :after handler can compare,
    // and so any downstream listener can read it.
    if (event.context) {
      (event.context as Record<string, unknown>).compreshResult = result;
    }

    // OpenClaw internal hooks can push user-visible messages via event.messages.
    // We stay silent here to avoid noise during compaction; the after-hook
    // emits a single compact summary line.
    return;
  }

  // ── session:compact:after ───────────────────────────────────────
  if (action === 'compact:after') {
    const ctx = event.context ?? {};
    const tokensBefore = (ctx.tokensBefore as number | undefined) ?? null;
    const tokensAfter = (ctx.tokensAfter as number | undefined) ?? null;
    const compreshResult = (ctx as Record<string, unknown>).compreshResult as
      | CompressResult
      | undefined;

    const nativeDelta =
      tokensBefore !== null && tokensAfter !== null ? tokensBefore - tokensAfter : null;

    const compreshSavingChars = compreshResult?.saving_chars ?? null;

    const parts = [`[compresh-hook] session:compact:after ${sessionId}`];
    if (nativeDelta !== null) {
      parts.push(`native: ${tokensBefore} → ${tokensAfter} tok (Δ${nativeDelta})`);
    }
    if (compreshSavingChars !== null) {
      parts.push(`compresh: ${compreshSavingChars} chars saved`);
    }
    if (compreshResult?.tier) {
      parts.push(`tier=${compreshResult.tier}`);
    }
    console.log(parts.join(' | '));

    // Optional: push a user-visible summary if you want, e.g.:
    //   event.messages?.push(`Compresh saved ${compreshSavingChars} chars`);
    return;
  }
}

// ─────────────────────────────────────────────────────────────────
// Graceful shutdown — close MCP transport when gateway exits
// ─────────────────────────────────────────────────────────────────

process.on('beforeExit', () => {
  void shutdownMcpClient();
});
