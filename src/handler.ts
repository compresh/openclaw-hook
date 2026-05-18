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
const PYTHON_BIN = process.env.COMPRESH_PYTHON_BIN ?? 'python3';
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
        command: PYTHON_BIN,
        args: ['-m', 'compresh_mcp.server'],
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
// ─────────────────────────────────────────────────────────────────

function extractTranscript(event: OpenClawEvent): AnyMessage[] | null {
  const ctx = event.context ?? {};

  // Most likely paths, in order
  if (Array.isArray(ctx.transcript) && ctx.transcript.length > 0) {
    return ctx.transcript as AnyMessage[];
  }

  const messages = (ctx as Record<string, unknown>).messages;
  if (Array.isArray(messages) && messages.length > 0) {
    return messages as AnyMessage[];
  }

  const history = (ctx as Record<string, unknown>).history;
  if (Array.isArray(history) && history.length > 0) {
    return history as AnyMessage[];
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
    const transcript = extractTranscript(event);
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
