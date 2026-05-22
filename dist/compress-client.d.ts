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
    messages: Array<{
        role: string;
        content: string;
    }>;
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
    raw_tail?: Array<{
        role: string;
        content: string;
    }>;
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
/**
 * Call the Compresh /v1/tul1 endpoint. Returns the parsed JSON response or
 * null on any failure (network, non-2xx, parse). Errors are logged but
 * never thrown — compression is best-effort by design.
 */
export declare function compress(opts: CompressOptions): Promise<CompressResult | null>;
//# sourceMappingURL=compress-client.d.ts.map