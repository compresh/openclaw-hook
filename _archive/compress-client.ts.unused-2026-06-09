/**
 * HTTP client for Compresh /v1/tul1 endpoint.
 *
 * Single-purpose helper kept separate from the plugin entry so it can be
 * unit-tested without booting an OpenClaw runtime.
 *
 * @license MIT
 * @author Compresh Ltd <hello@compre.sh>
 */

export interface CompressOptions {
  apiKey: string;
  endpoint?: string;
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  protectionMode?: 'aggressive' | 'balanced' | 'conservative';
  providerHint?: string;
  modelHint?: string;
  timeoutMs?: number;
}

export interface CompressResult {
  ok: boolean;
  applied: boolean;
  reason?: string;
  compresh_md?: string;
  raw_tail?: Array<{ role: string; content: string }>;
  n_compressed_turns?: number;
  n_total?: number;
  saving_chars?: number;
  saving_tokens?: number;
  session_id?: string;
  protection_mode?: string;
  tier?: string;
  fee_cents?: number;
  tier_label?: string;
  version?: string;
}

const DEFAULT_ENDPOINT = 'https://api.compre.sh/v1/tul1';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Call the Compresh /v1/tul1 endpoint. Returns the parsed JSON response or
 * null on any failure (network, non-2xx, parse). Errors are logged but
 * never thrown — compression is best-effort by design.
 */
export async function compress(opts: CompressOptions): Promise<CompressResult | null> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': '@compresh/openclaw-hook',
      },
      body: JSON.stringify({
        session_id: opts.sessionId,
        messages: opts.messages,
        protection_mode: opts.protectionMode ?? 'balanced',
        provider_hint: opts.providerHint ?? 'anthropic',
        model_hint: opts.modelHint ?? 'claude-sonnet-4-5',
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(
        `[compresh] /v1/tul1 ${res.status}: ${txt.slice(0, 200)}`
      );
      return null;
    }

    return (await res.json()) as CompressResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[compresh] /v1/tul1 failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
