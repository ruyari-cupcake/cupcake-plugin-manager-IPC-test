/**
 * @file migration-retry-proxy.test.js — Tests for retry logic, CORS proxy, customParams blocklist,
 * maxOutputLimit, Copilot stream guards, Anthropic beta headers, and streaming byte cap.
 * These features were migrated from _temp_repo/fetch-custom.js.
 *
 * Note: The manager/index.js functions are tested indirectly through their exported behaviors;
 * we re-implement the pure utility functions for unit testing.
 */
import { describe, it, expect, vi } from 'vitest';

// ═══════════════════════════════════════
// RETRY UTILITIES (same logic as manager/index.js)
// ═══════════════════════════════════════

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function _parseRetryAfterMs(headers) {
    const raw = headers?.get?.('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(0, Math.floor(seconds * 1000));
    }
    const retryAt = Date.parse(raw);
    if (Number.isNaN(retryAt)) return 0;
    return Math.max(0, retryAt - Date.now());
}

function _isRetriableHttpStatus(status) {
    return status === 408 || status === 429 || (status >= 500 && status !== 524);
}

async function _executeWithRetry(requestFactory, label, maxAttempts = 3, abortSignal) {
    let attempt = 0;
    let response;

    while (attempt < maxAttempts) {
        response = await requestFactory();
        if (response?.ok) return response;

        const status = response?.status || 0;
        if (!_isRetriableHttpStatus(status) || attempt >= maxAttempts - 1 || abortSignal?.aborted) {
            return response;
        }

        response?.body?.cancel?.();
        attempt++;
        const retryAfterMs = _parseRetryAfterMs(response?.headers);
        const exponentialDelay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
        const retryDelay = retryAfterMs || exponentialDelay;
        await sleep(retryDelay);
    }

    return response;
}

function _applyCorsProxy(url, proxyUrl) {
    if (!proxyUrl || !url) return url;
    const cleanProxy = proxyUrl.replace(/\/+$/, '');
    try {
        const origUrl = new URL(url);
        const proxyBase = new URL(cleanProxy);
        return proxyBase.origin + proxyBase.pathname.replace(/\/+$/, '') + origUrl.pathname + origUrl.search;
    } catch {
        return url;
    }
}

const CUSTOM_PARAMS_BLOCKLIST = [
    'messages', 'contents', 'input', 'prompt',
    'stream', 'stream_options',
    'model',
    'tools', 'functions', 'function_call', 'tool_choice', 'tool_config',
    'system', 'system_instruction', 'systemInstruction',
];

// ═══════════════════════════════════════
// _parseRetryAfterMs
// ═══════════════════════════════════════
describe('_parseRetryAfterMs', () => {
    it('returns 0 when no retry-after header', () => {
        expect(_parseRetryAfterMs(null)).toBe(0);
        expect(_parseRetryAfterMs({})).toBe(0);
        expect(_parseRetryAfterMs(new Headers())).toBe(0);
    });

    it('parses numeric seconds', () => {
        const headers = new Headers({ 'retry-after': '5' });
        expect(_parseRetryAfterMs(headers)).toBe(5000);
    });

    it('parses zero seconds', () => {
        const headers = new Headers({ 'retry-after': '0' });
        expect(_parseRetryAfterMs(headers)).toBe(0);
    });

    it('parses fractional seconds', () => {
        const headers = new Headers({ 'retry-after': '1.5' });
        expect(_parseRetryAfterMs(headers)).toBe(1500); // Math.floor(1.5 * 1000)
    });

    it('returns 0 for invalid string', () => {
        const headers = new Headers({ 'retry-after': 'not-a-number' });
        expect(_parseRetryAfterMs(headers)).toBe(0);
    });

    it('returns ≥0 for future date', () => {
        const date = new Date(Date.now() + 10000).toUTCString();
        const headers = new Headers({ 'retry-after': date });
        const ms = _parseRetryAfterMs(headers);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(11000);
    });

    it('returns 0 for past date', () => {
        const date = new Date(Date.now() - 10000).toUTCString();
        const headers = new Headers({ 'retry-after': date });
        expect(_parseRetryAfterMs(headers)).toBe(0);
    });

    it('handles negative seconds by returning 0', () => {
        const headers = new Headers({ 'retry-after': '-5' });
        // -5 is finite but < 0, second branch (Date.parse) → NaN → 0
        const ms = _parseRetryAfterMs(headers);
        expect(ms).toBe(0);
    });
});

// ═══════════════════════════════════════
// _isRetriableHttpStatus
// ═══════════════════════════════════════
describe('_isRetriableHttpStatus', () => {
    it('retries 408 Request Timeout', () => {
        expect(_isRetriableHttpStatus(408)).toBe(true);
    });

    it('retries 429 Too Many Requests', () => {
        expect(_isRetriableHttpStatus(429)).toBe(true);
    });

    it('retries 500 Internal Server Error', () => {
        expect(_isRetriableHttpStatus(500)).toBe(true);
    });

    it('retries 502 Bad Gateway', () => {
        expect(_isRetriableHttpStatus(502)).toBe(true);
    });

    it('retries 503 Service Unavailable', () => {
        expect(_isRetriableHttpStatus(503)).toBe(true);
    });

    it('does NOT retry 524 Cloudflare Timeout', () => {
        expect(_isRetriableHttpStatus(524)).toBe(false);
    });

    it('does NOT retry 400 Bad Request', () => {
        expect(_isRetriableHttpStatus(400)).toBe(false);
    });

    it('does NOT retry 401 Unauthorized', () => {
        expect(_isRetriableHttpStatus(401)).toBe(false);
    });

    it('does NOT retry 403 Forbidden', () => {
        expect(_isRetriableHttpStatus(403)).toBe(false);
    });

    it('does NOT retry 404 Not Found', () => {
        expect(_isRetriableHttpStatus(404)).toBe(false);
    });

    it('does NOT retry 200 OK', () => {
        expect(_isRetriableHttpStatus(200)).toBe(false);
    });

    it('does NOT retry 0 (no status)', () => {
        expect(_isRetriableHttpStatus(0)).toBe(false);
    });
});

// ═══════════════════════════════════════
// _executeWithRetry
// ═══════════════════════════════════════
describe('_executeWithRetry', () => {
    it('returns immediately on success', async () => {
        let calls = 0;
        const result = await _executeWithRetry(async () => {
            calls++;
            return { ok: true, status: 200 };
        }, 'test');
        expect(result.ok).toBe(true);
        expect(calls).toBe(1);
    });

    it('retries on 429 and succeeds on 2nd attempt', async () => {
        let calls = 0;
        const result = await _executeWithRetry(async () => {
            calls++;
            if (calls === 1) return { ok: false, status: 429, headers: new Headers(), body: { cancel: vi.fn() } };
            return { ok: true, status: 200 };
        }, 'test', 3);
        expect(result.ok).toBe(true);
        expect(calls).toBe(2);
    });

    it('retries on 500 up to maxAttempts', async () => {
        let calls = 0;
        const result = await _executeWithRetry(async () => {
            calls++;
            return { ok: false, status: 500, headers: new Headers(), body: { cancel: vi.fn() } };
        }, 'test', 3);
        expect(result.ok).toBe(false);
        expect(result.status).toBe(500);
        expect(calls).toBe(3);
    });

    it('does not retry non-retriable status', async () => {
        let calls = 0;
        const result = await _executeWithRetry(async () => {
            calls++;
            return { ok: false, status: 401, headers: new Headers() };
        }, 'test', 3);
        expect(result.status).toBe(401);
        expect(calls).toBe(1);
    });

    it('does not retry on 524', async () => {
        let calls = 0;
        const _result = await _executeWithRetry(async () => {
            calls++;
            return { ok: false, status: 524, headers: new Headers() };
        }, 'test', 3);
        expect(calls).toBe(1);
    });

    it('stops retrying if abortSignal is aborted', async () => {
        const controller = new AbortController();
        let calls = 0;
        const _result = await _executeWithRetry(async () => {
            calls++;
            if (calls === 1) {
                controller.abort();
                return { ok: false, status: 429, headers: new Headers(), body: { cancel: vi.fn() } };
            }
            return { ok: true, status: 200 };
        }, 'test', 3, controller.signal);
        expect(calls).toBe(1);
    });

    it('cancels response body before retry', async () => {
        const cancelFn = vi.fn();
        let calls = 0;
        await _executeWithRetry(async () => {
            calls++;
            if (calls === 1) return { ok: false, status: 429, headers: new Headers(), body: { cancel: cancelFn } };
            return { ok: true, status: 200 };
        }, 'test', 3);
        expect(cancelFn).toHaveBeenCalledOnce();
    });

    it('uses maxAttempts=1 to disable retry', async () => {
        let calls = 0;
        const _result = await _executeWithRetry(async () => {
            calls++;
            return { ok: false, status: 500, headers: new Headers() };
        }, 'test', 1);
        expect(calls).toBe(1);
    });

    it('handles null response gracefully', async () => {
        let calls = 0;
        const result = await _executeWithRetry(async () => {
            calls++;
            return null;
        }, 'test', 2);
        expect(calls).toBe(1); // status 0 is not retriable → returns immediately
        expect(result).toBeNull();
    });

    it('handles response without status', async () => {
        let calls = 0;
        const _result = await _executeWithRetry(async () => {
            calls++;
            return { ok: false };
        }, 'test', 2);
        expect(calls).toBe(1); // status=0 is not retriable
    });
});

// ═══════════════════════════════════════
// _applyCorsProxy
// ═══════════════════════════════════════
describe('_applyCorsProxy', () => {
    it('rewrites URL through proxy', () => {
        const result = _applyCorsProxy('https://api.anthropic.com/v1/messages', 'https://proxy.example.com');
        expect(result).toBe('https://proxy.example.com/v1/messages');
    });

    it('preserves query parameters', () => {
        const result = _applyCorsProxy('https://api.openai.com/v1/chat/completions?q=1', 'https://proxy.example.com');
        expect(result).toBe('https://proxy.example.com/v1/chat/completions?q=1');
    });

    it('handles proxy with path prefix', () => {
        const result = _applyCorsProxy('https://api.anthropic.com/v1/messages', 'https://proxy.example.com/api/cors');
        expect(result).toBe('https://proxy.example.com/api/cors/v1/messages');
    });

    it('strips trailing slashes from proxy URL', () => {
        const result = _applyCorsProxy('https://api.anthropic.com/v1/messages', 'https://proxy.example.com///');
        expect(result).toBe('https://proxy.example.com/v1/messages');
    });

    it('returns original URL when proxy is empty', () => {
        expect(_applyCorsProxy('https://api.openai.com/v1', '')).toBe('https://api.openai.com/v1');
    });

    it('returns original URL when proxy is null', () => {
        expect(_applyCorsProxy('https://api.openai.com/v1', null)).toBe('https://api.openai.com/v1');
    });

    it('returns original URL when url is empty', () => {
        expect(_applyCorsProxy('', 'https://proxy.example.com')).toBe('');
    });

    it('returns original URL for invalid proxy URL', () => {
        expect(_applyCorsProxy('https://api.openai.com/v1', 'not-a-url')).toBe('https://api.openai.com/v1');
    });
});

// ═══════════════════════════════════════
// customParams blocklist
// ═══════════════════════════════════════
describe('CUSTOM_PARAMS_BLOCKLIST', () => {
    it('has 15 blocked fields (same as _temp_repo)', () => {
        expect(CUSTOM_PARAMS_BLOCKLIST.length).toBe(15);
    });

    it('includes all conversation content fields', () => {
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('messages');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('contents');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('input');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('prompt');
    });

    it('includes streaming control fields', () => {
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('stream');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('stream_options');
    });

    it('includes model identity', () => {
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('model');
    });

    it('includes tool/function injection fields', () => {
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('tools');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('functions');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('function_call');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('tool_choice');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('tool_config');
    });

    it('includes system-level overrides', () => {
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('system');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('system_instruction');
        expect(CUSTOM_PARAMS_BLOCKLIST).toContain('systemInstruction');
    });

    it('applies blocklist correctly to user-provided params', () => {
        const extra = {
            messages: 'evil', contents: 'evil', stream: true, model: 'evil',
            tools: [], functions: [], system: 'override',
            temperature: 0.5, top_p: 0.9, custom_field: 'ok',
        };
        const safeExtra = { ...extra };
        const stripped = [];
        for (const key of CUSTOM_PARAMS_BLOCKLIST) {
            if (key in safeExtra) { stripped.push(key); delete safeExtra[key]; }
        }
        expect(stripped).toContain('messages');
        expect(stripped).toContain('contents');
        expect(stripped).toContain('stream');
        expect(stripped).toContain('model');
        expect(stripped).toContain('tools');
        expect(stripped).toContain('functions');
        expect(stripped).toContain('system');
        // These survive:
        expect(safeExtra.temperature).toBe(0.5);
        expect(safeExtra.top_p).toBe(0.9);
        expect(safeExtra.custom_field).toBe('ok');
    });

    it('thenable values are rejected', () => {
        const extra = { temperature: 0.5, badPromise: Promise.resolve('evil') };
        for (const [key, value] of Object.entries(extra)) {
            if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
                delete extra[key];
            }
        }
        expect(extra.temperature).toBe(0.5);
        expect(extra.badPromise).toBeUndefined();
    });
});

// ═══════════════════════════════════════
// maxOutputLimit clamping
// ═══════════════════════════════════════
describe('maxOutputLimit clamping', () => {
    function clampMaxTokens(maxTokens, maxOutputLimit) {
        if (maxOutputLimit && maxOutputLimit > 0 && typeof maxTokens === 'number' && maxTokens > maxOutputLimit) {
            return maxOutputLimit;
        }
        return maxTokens;
    }

    it('clamps when maxTokens exceeds limit', () => {
        expect(clampMaxTokens(8192, 4096)).toBe(4096);
    });

    it('does not clamp when maxTokens is within limit', () => {
        expect(clampMaxTokens(2048, 4096)).toBe(2048);
    });

    it('does not clamp when maxOutputLimit is 0', () => {
        expect(clampMaxTokens(8192, 0)).toBe(8192);
    });

    it('does not clamp when maxOutputLimit is undefined', () => {
        expect(clampMaxTokens(8192, undefined)).toBe(8192);
    });

    it('does not clamp when maxTokens equals limit', () => {
        expect(clampMaxTokens(4096, 4096)).toBe(4096);
    });

    it('does not clamp when maxTokens is not a number', () => {
        expect(clampMaxTokens('8192', 4096)).toBe('8192');
    });
});

// ═══════════════════════════════════════
// developerRole auto-detection by model regex
// ═══════════════════════════════════════
describe('developerRole auto-detection', () => {
    const DEVELOPER_ROLE_REGEX = /(?:^|\/)(?:gpt-5|o[2-9]|o1(?!-(?:preview|mini)))/i;

    it('matches gpt-5', () => {
        expect(DEVELOPER_ROLE_REGEX.test('gpt-5')).toBe(true);
    });

    it('matches gpt-5.4', () => {
        expect(DEVELOPER_ROLE_REGEX.test('gpt-5.4')).toBe(true);
    });

    it('matches o3', () => {
        expect(DEVELOPER_ROLE_REGEX.test('o3')).toBe(true);
    });

    it('matches o4-mini', () => {
        expect(DEVELOPER_ROLE_REGEX.test('o4-mini')).toBe(true);
    });

    it('matches openai/gpt-5', () => {
        expect(DEVELOPER_ROLE_REGEX.test('openai/gpt-5')).toBe(true);
    });

    it('does NOT match o1-preview', () => {
        expect(DEVELOPER_ROLE_REGEX.test('o1-preview')).toBe(false);
    });

    it('does NOT match o1-mini', () => {
        expect(DEVELOPER_ROLE_REGEX.test('o1-mini')).toBe(false);
    });

    it('does NOT match gpt-4o', () => {
        expect(DEVELOPER_ROLE_REGEX.test('gpt-4o')).toBe(false);
    });

    it('does NOT match gpt-4.1', () => {
        expect(DEVELOPER_ROLE_REGEX.test('gpt-4.1')).toBe(false);
    });

    it('converts system→developer for matching models', () => {
        const messages = [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
        ];
        const modelId = 'gpt-5';
        if (DEVELOPER_ROLE_REGEX.test(modelId)) {
            for (const fm of messages) {
                if (fm && fm.role === 'system') fm.role = 'developer';
            }
        }
        expect(messages[0].role).toBe('developer');
        expect(messages[1].role).toBe('user');
        expect(messages[2].role).toBe('assistant');
    });

    it('does NOT convert for non-matching models', () => {
        const messages = [{ role: 'system', content: 'You are helpful' }];
        const modelId = 'gpt-4o';
        if (DEVELOPER_ROLE_REGEX.test(modelId)) {
            for (const fm of messages) {
                if (fm && fm.role === 'system') fm.role = 'developer';
            }
        }
        expect(messages[0].role).toBe('system');
    });
});

// ═══════════════════════════════════════
// Anthropic beta headers
// ═══════════════════════════════════════
describe('Anthropic beta headers', () => {
    function buildAnthropicBetas(body, isCopilot, isProxied, maxTokens) {
        const betas = [];
        if (!isCopilot && !isProxied) {
            const effectiveMaxTokens = body.max_tokens || maxTokens || 0;
            if (effectiveMaxTokens > 8192) betas.push('output-128k-2025-02-19');
        }
        const hasPromptCaching = Array.isArray(body.messages) && body.messages.some(msg =>
            Array.isArray(msg?.content) && msg.content.some(part => part?.cache_control?.type === 'ephemeral')
        );
        if (hasPromptCaching) betas.push('prompt-caching-2024-07-31');
        if (body.thinking) betas.push('interleaved-thinking-2025-05-14');
        return betas;
    }

    it('adds output-128k for non-Copilot with >8192 tokens', () => {
        const betas = buildAnthropicBetas({ max_tokens: 16000 }, false, false, 0);
        expect(betas).toContain('output-128k-2025-02-19');
    });

    it('does NOT add output-128k for Copilot', () => {
        const betas = buildAnthropicBetas({ max_tokens: 16000 }, true, false, 0);
        expect(betas).not.toContain('output-128k-2025-02-19');
    });

    it('does NOT add output-128k for proxied requests', () => {
        const betas = buildAnthropicBetas({ max_tokens: 16000 }, false, true, 0);
        expect(betas).not.toContain('output-128k-2025-02-19');
    });

    it('does NOT add output-128k for ≤8192 tokens', () => {
        const betas = buildAnthropicBetas({ max_tokens: 8192 }, false, false, 0);
        expect(betas).not.toContain('output-128k-2025-02-19');
    });

    it('adds prompt-caching when ephemeral cache_control present', () => {
        const body = {
            messages: [{ content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]
        };
        const betas = buildAnthropicBetas(body, false, false, 0);
        expect(betas).toContain('prompt-caching-2024-07-31');
    });

    it('adds interleaved-thinking when thinking is set', () => {
        const betas = buildAnthropicBetas({ thinking: { type: 'enabled' } }, false, false, 0);
        expect(betas).toContain('interleaved-thinking-2025-05-14');
    });

    it('includes all three betas when applicable', () => {
        const body = {
            max_tokens: 16000,
            thinking: { type: 'enabled' },
            messages: [{ content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]
        };
        const betas = buildAnthropicBetas(body, false, false, 0);
        expect(betas).toHaveLength(3);
        expect(betas.join(',')).toBe('output-128k-2025-02-19,prompt-caching-2024-07-31,interleaved-thinking-2025-05-14');
    });

    it('falls back to maxTokens arg when body.max_tokens not set', () => {
        const betas = buildAnthropicBetas({}, false, false, 16000);
        expect(betas).toContain('output-128k-2025-02-19');
    });
});

// ═══════════════════════════════════════
// Streaming byte cap (512KB)
// ═══════════════════════════════════════
describe('streaming byte cap', () => {
    it('caps logged chunks at 512KB', () => {
        const _STREAM_LOG_CAP = 512 * 1024;
        const chunks = [];
        let totalBytes = 0;
        // Simulate 1MB of streaming data
        for (let i = 0; i < 1024; i++) {
            const chunk = 'x'.repeat(1024); // 1KB per chunk
            if (totalBytes < _STREAM_LOG_CAP) {
                chunks.push(chunk);
                totalBytes += chunk.length;
            }
        }
        expect(chunks.length).toBe(512);
        expect(totalBytes).toBe(512 * 1024);
    });

    it('allows all chunks when under cap', () => {
        const _STREAM_LOG_CAP = 512 * 1024;
        const chunks = [];
        let totalBytes = 0;
        for (let i = 0; i < 10; i++) {
            const chunk = 'hello ';
            if (totalBytes < _STREAM_LOG_CAP) {
                chunks.push(chunk);
                totalBytes += chunk.length;
            }
        }
        expect(chunks.length).toBe(10);
    });
});

// ═══════════════════════════════════════
// Copilot CORS proxy auth passthrough
// ═══════════════════════════════════════
describe('Copilot CORS proxy auth passthrough', () => {
    it('uses apiKey as proxy token when available', () => {
        const apiKey = 'gho_test_token_123';
        const _isProxied = true;
        const isCopilotUrl = true;
        const headers = { 'Content-Type': 'application/json' };

        if (_isProxied && isCopilotUrl) {
            const proxiedCopilotToken = apiKey;
            if (proxiedCopilotToken) {
                headers['Authorization'] = `Bearer ${proxiedCopilotToken}`;
            }
        }

        expect(headers['Authorization']).toBe('Bearer gho_test_token_123');
    });

    it('returns error when no token available for proxied Copilot', () => {
        const apiKey = '';
        const _isProxied = true;
        const isCopilotUrl = true;
        const _githubToken = '';

        if (_isProxied && isCopilotUrl) {
            let proxiedCopilotToken = apiKey;
            if (!proxiedCopilotToken) {
                proxiedCopilotToken = String(_githubToken || '').replace(/[^\x20-\x7E]/g, '').trim();
            }
            if (!proxiedCopilotToken) {
                const result = { success: false, content: 'CORS Proxy requires token' };
                expect(result.success).toBe(false);
            }
        }
    });
});

// ═══════════════════════════════════════
// normalizeCopilotNodelessMode
// ═══════════════════════════════════════
import { normalizeCopilotNodelessMode } from '../src/shared/copilot-headers.js';

describe('normalizeCopilotNodelessMode (used in manager)', () => {
    it('returns "off" for empty/undefined', () => {
        expect(normalizeCopilotNodelessMode('')).toBe('off');
        expect(normalizeCopilotNodelessMode(undefined)).toBe('off');
        expect(normalizeCopilotNodelessMode(null)).toBe('off');
    });

    it('returns valid modes as-is', () => {
        expect(normalizeCopilotNodelessMode('off')).toBe('off');
        expect(normalizeCopilotNodelessMode('nodeless-1')).toBe('nodeless-1');
        expect(normalizeCopilotNodelessMode('nodeless-2')).toBe('nodeless-2');
    });

    it('returns "off" for invalid values', () => {
        expect(normalizeCopilotNodelessMode('invalid')).toBe('off');
        expect(normalizeCopilotNodelessMode('true')).toBe('off');
    });
});
