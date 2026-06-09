/**
 * @compresh/openclaw-hook — v0.3.4
 *
 * Plugin SDK hook for per-turn context compression via Compresh.
 * Transport: stdio MCP to `compresh-mcp` (Python, pipx-installed).
 *
 * Why MCP and not HTTP?
 *   - The Plugin SDK config-resolution path in OpenClaw 2026.x is unreliable
 *     (api.pluginConfig is null in some paths; api.config is the root tree;
 *     plugin worker `process.env` propagation is brittle).
 *   - `compresh-mcp` already handles its own API key (env or pipx config),
 *     so the plugin doesn't need to know secrets.
 *   - The same `compresh-mcp` subprocess works across Claude Desktop,
 *     Cursor, Cline, Continue, Zed — single install, multiple hosts.
 *
 * Hooks:
 *   - before_prompt_build: rewrites history → calls compresh-mcp.compress →
 *     injects compressed view via appendSystemContext
 *   - llm_output: observation only — usage + budget telemetry
 *
 * Prereq:
 *   pip install --user "compresh-mcp>=0.2.5"   # or: pipx install "compresh-mcp>=0.2.5"
 *   export COMPRESH_API_KEY='sk-comp_...'       # picked up by compresh-mcp
 *
 * compresh-mcp >= 0.2.5 recommended: TAGLESS compressed context (no Q: marker
 * lines reach the model) + tier-correct LexRank (free → local @6a; paid →
 * server /v1/tul1 @9). The hook just relays compresh-mcp's `compress` result,
 * so it inherits this automatically; older compresh-mcp works with pre-0.2.5
 * behaviour.
 *
 * @license MIT
 * @author Compresh Ltd <hello@compre.sh>
 */
import { definePluginEntry, } from 'openclaw/plugin-sdk/plugin-entry';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// ─────────────────────────────────────────────────────────────────
// Config resolution — try api.pluginConfig, root config path, then env.
// `compresh-mcp` itself reads COMPRESH_API_KEY; the plugin doesn't.
// ─────────────────────────────────────────────────────────────────
function readConfig(api, ctx) {
    const sources = [
        ctx.pluginConfig,
        api?.pluginConfig,
        api?.config?.plugins?.entries?.compresh?.config,
    ];
    const cfg = sources.find((s) => s && typeof s === 'object' && Object.keys(s).length > 0) ?? {};
    const envMode = process.env.COMPRESH_PROTECTION_MODE;
    const resolvedMode = cfg.protectionMode ??
        (envMode === 'aggressive' || envMode === 'conservative' ? envMode : 'balanced');
    return {
        apiKey: cfg.apiKey ?? process.env.COMPRESH_API_KEY ?? '',
        binPath: cfg.binPath ?? process.env.COMPRESH_BIN ?? 'compresh-mcp',
        binArgs: cfg.binArgs ?? process.env.COMPRESH_BIN_ARGS ?? '',
        protectionMode: resolvedMode,
        providerHint: cfg.providerHint ??
            ctx.modelProviderId ??
            process.env.COMPRESH_PROVIDER_HINT ??
            'anthropic',
        modelHint: cfg.modelHint ?? ctx.modelId ?? process.env.COMPRESH_MODEL_HINT ?? 'claude-sonnet-4-5',
        minMessages: cfg.minMessages ?? 6,
        timeoutMs: cfg.timeoutMs ?? 10000,
    };
}
// ─────────────────────────────────────────────────────────────────
// Message normalization — OpenClaw uses block-array content.
// compresh-mcp.compress expects { role, content: string }.
// ─────────────────────────────────────────────────────────────────
function normalizeContent(content) {
    if (typeof content === 'string')
        return content;
    if (content == null)
        return '';
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (typeof block === 'string') {
                parts.push(block);
                continue;
            }
            if (!block || typeof block !== 'object') {
                parts.push(String(block));
                continue;
            }
            const b = block;
            const btype = typeof b.type === 'string' ? b.type : '';
            if (btype === 'text' && typeof b.text === 'string') {
                parts.push(b.text);
            }
            else if (btype === 'tool_use') {
                const name = typeof b.name === 'string' ? b.name : '?';
                parts.push(`[tool_use ${name}]`);
            }
            else if (btype === 'tool_result') {
                const inner = b.content;
                parts.push(typeof inner === 'string' ? inner : JSON.stringify(inner ?? null));
            }
            else if (btype === 'image') {
                parts.push('[image]');
            }
            else {
                parts.push(JSON.stringify(b));
            }
        }
        return parts.filter((s) => s.length > 0).join('\n');
    }
    return JSON.stringify(content);
}
function flattenMessages(raw) {
    const out = [];
    for (const m of raw) {
        if (!m || typeof m !== 'object')
            continue;
        const r = m;
        if (typeof r.role !== 'string')
            continue;
        const c = normalizeContent(r.content);
        if (c.length > 0)
            out.push({ role: r.role, content: c });
    }
    return out;
}
// ─────────────────────────────────────────────────────────────────
// MCP client lifecycle — single shared client, lazy connect.
// ─────────────────────────────────────────────────────────────────
let mcpClient = null;
let mcpTransport = null;
let mcpConnectPromise = null;
async function ensureMcpClient(binPath, binArgs, apiKey, log) {
    if (mcpClient)
        return mcpClient;
    if (!mcpConnectPromise) {
        mcpConnectPromise = (async () => {
            try {
                const env = { ...process.env };
                // Explicit env injection — plugin worker's process.env does NOT
                // propagate to spawned children reliably. Inject apiKey from
                // plugin config so compresh-mcp finds it.
                if (apiKey)
                    env.COMPRESH_API_KEY = apiKey;
                const args = binArgs.split(' ').filter((s) => s.length > 0);
                mcpTransport = new StdioClientTransport({
                    command: binPath,
                    args,
                    env,
                    // Capture the subprocess stderr instead of inheriting it. The
                    // OpenClaw gateway surfaces inherited child stderr in the chat
                    // TUI, so compresh-mcp's startup banner / warnings / tracebacks
                    // would leak into the user's conversation. Pipe it here and
                    // re-emit through our own logger (which goes to the gateway log).
                    stderr: 'pipe',
                });
                const client = new Client({ name: 'compresh-openclaw-hook', version: '0.3.4' }, { capabilities: {} });
                await client.connect(mcpTransport);
                mcpClient = client;
                log(`[compresh] mcp-connected bin=${binPath}`);
                // Drain compresh-mcp stderr → our logger, line by line.
                const errStream = mcpTransport.stderr;
                if (errStream) {
                    let buf = '';
                    errStream.on('data', (chunk) => {
                        buf += chunk.toString();
                        const lines = buf.split('\n');
                        buf = lines.pop() ?? '';
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed)
                                log(`[compresh-mcp] ${trimmed}`);
                        }
                    });
                }
            }
            catch (err) {
                log(`[compresh] mcp-connect-failed: ${err.message}`);
                mcpConnectPromise = null;
            }
        })();
    }
    await mcpConnectPromise;
    return mcpClient;
}
// ─────────────────────────────────────────────────────────────────
// compresh-mcp.compress call
// ─────────────────────────────────────────────────────────────────
async function callCompress(client, sessionId, messages, protectionMode, providerHint, modelHint) {
    try {
        const result = await client.callTool({
            name: 'compress',
            arguments: {
                session_id: sessionId,
                messages,
                protection_mode: protectionMode,
                provider_hint: providerHint,
                model_hint: modelHint,
            },
        });
        const content = result.content;
        if (!Array.isArray(content) || content.length === 0)
            return null;
        const first = content[0];
        if (first.type !== 'text' || !first.text)
            return null;
        return JSON.parse(first.text);
    }
    catch (err) {
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────
// Plugin entry
// ─────────────────────────────────────────────────────────────────
export default definePluginEntry({
    id: 'compresh',
    name: 'Compresh',
    description: 'Per-turn context compression via compresh-mcp — episodic memory architecture for LLMs',
    register(api) {
        const apiAny = api;
        const logger = apiAny.logger ?? null;
        const log = (msg) => {
            if (logger && typeof logger.info === 'function') {
                logger.info(msg);
            }
            else {
                console.error(msg);
            }
        };
        log(`[compresh] register v0.3.4 transport=mcp logger=${logger ? 'present' : 'console.error'}`);
        // ── before_prompt_build: rewrite history → compressed system context ──
        api.on('before_prompt_build', async (event, ctx) => {
            const cfg = readConfig(api, ctx);
            const rawMessages = event.messages;
            if (!Array.isArray(rawMessages) || rawMessages.length < cfg.minMessages) {
                return undefined;
            }
            const messages = flattenMessages(rawMessages);
            if (messages.length < cfg.minMessages)
                return undefined;
            const sessionId = ctx.sessionKey ?? ctx.sessionId ?? `openclaw-${Date.now()}`;
            if (!cfg.apiKey) {
                log('[compresh] skip: apiKey empty');
                return undefined;
            }
            const client = await ensureMcpClient(cfg.binPath, cfg.binArgs, cfg.apiKey, log);
            if (!client) {
                log('[compresh] skip: mcp client unavailable');
                return undefined;
            }
            const result = await callCompress(client, sessionId, messages, cfg.protectionMode, cfg.providerHint, cfg.modelHint);
            if (!result || !result.ok || !result.applied || !result.compresh_md) {
                return undefined;
            }
            const savingChars = result.saving_chars ?? 0;
            const nCompressed = result.n_compressed_turns ?? 0;
            const nTotal = result.n_total ?? messages.length;
            log(`[compresh] before_prompt_build sid=${sessionId.slice(0, 20)} ` +
                `applied tier=${result.tier ?? '?'} ` +
                `compressed=${nCompressed}/${nTotal} ` +
                `saving=${savingChars}chars`);
            return {
                appendSystemContext: `<compresh:history>\n${result.compresh_md}\n</compresh:history>`,
            };
        }, { priority: 50, timeoutMs: 15000 });
        // ── llm_output: observation-only telemetry ──
        api.on('llm_output', async (event, ctx) => {
            const usage = event.usage;
            const budget = event.contextTokenBudget;
            if (!usage && budget === undefined)
                return;
            const sid = (ctx.sessionKey ?? '?').toString().slice(0, 20);
            const total = usage?.totalTokens ??
                ((usage?.input ?? 0) +
                    (usage?.output ?? 0) +
                    (usage?.cacheRead ?? 0) +
                    (usage?.cacheWrite ?? 0));
            log(`[compresh] llm_output sid=${sid} ` +
                `input=${usage?.input ?? '?'} ` +
                `output=${usage?.output ?? '?'} ` +
                `cacheRead=${usage?.cacheRead ?? 0} ` +
                `cacheWrite=${usage?.cacheWrite ?? 0} ` +
                `total=${total} ` +
                `budget=${budget ?? '?'}`);
        });
        // ── Graceful shutdown — close MCP transport when gateway exits ──
        process.on('beforeExit', () => {
            try {
                void mcpClient?.close();
            }
            catch {
                /* swallow */
            }
            mcpClient = null;
            mcpTransport = null;
            mcpConnectPromise = null;
        });
    },
});
//# sourceMappingURL=index.js.map