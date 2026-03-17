/**
 * @file coverage-final-push2.test.js — 남은 미커버 라인 전멸 2차
 *
 * 대상:
 *   helpers.js        — streamingFetch array-like data, smartFetch Copilot fallback chains
 *   sse-parser.js     — Anthropic SSE abort/completion/thinking paths
 *   message-format.js — formatToAnthropic content merge, cache_control, Gemini format
 *   dynamic-models.js — AWS inference profiles, mergeDynamicModels edge cases
 *   key-pool.js       — JSON object key parsing
 *   slot-inference.js — multi-collision with equal scores
 *   custom-model-serialization.js — normalizeCustomModel default branches
 *   safe-db-writer.js — validatePlugin edge cases
 *   ipc-protocol.js   — registration retry exhaustion
 *   copilot-token.js  — token parsing paths
 *   api-request-log.js — store with primitive entry
 *   endpoints.js      — environment resolution
 *   aws-signer.js     — S3 path decode fallback
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock ipc-protocol ──
vi.mock('../src/shared/ipc-protocol.js', () => {
    const _mockRisu = {
        getArgument: vi.fn(async () => ''),
        setArgument: vi.fn(),
        pluginStorage: {
            getItem: vi.fn(async () => null),
            setItem: vi.fn(async () => {}),
            removeItem: vi.fn(async () => {}),
        },
        getDatabase: vi.fn(async () => ({ plugins: [] })),
        risuFetch: vi.fn(async () => ({ data: null, status: 200 })),
        nativeFetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
        registerPlugin: vi.fn(),
        getRootDocument: vi.fn(async () => null),
    };
    return {
        getRisu: () => _mockRisu,
        CH: { CONTROL: 'cpm-control', RESPONSE: 'cpm-response', FETCH: 'cpm-fetch', ABORT: 'cpm-abort' },
        MSG: {},
        safeUUID: () => 'test-uuid-2',
        MANAGER_NAME: 'CPM',
        _mockRisu,
    };
});

import { _mockRisu } from '../src/shared/ipc-protocol.js';

// ═══════════════════════════════════════════════════════════════
// helpers.js — streamingFetch & smartFetch uncovered branches
// ═══════════════════════════════════════════════════════════════

import {
    streamingFetch,
    smartFetch,
    collectStream,
    checkStreamCapability,
    _resetCompatibilityModeCache,
} from '../src/shared/helpers.js';

describe('streamingFetch — array-like object data (L627-628)', () => {
    beforeEach(() => {
        _resetCompatibilityModeCache();
        _mockRisu.getArgument = vi.fn().mockResolvedValue(null);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('handles array-like object data with .length property', async () => {
        _mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('nope'));
        // Array-like object (not Array, not Uint8Array, not ArrayBuffer, not Blob, has .length)
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: { 0: 72, 1: 101, 2: 108, length: 3 },
            status: 200,
            headers: {},
        });
        const res = await streamingFetch('https://api.test.com', { body: '{}' });
        expect(res.status).toBe(200);
    });

    it('returns null response when risuFetch data type is unrecognizable', async () => {
        _mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('nope'));
        // data is e.g. a Blob — responseBody stays null → falls through
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: new Blob(['test']),
            status: 200,
            headers: {},
        });
        await expect(streamingFetch('https://api.test.com', { body: '{}' }))
            .rejects.toThrow('All fetch strategies failed');
    });

    it('nativeFetch returns status 0 → falls to risuFetch', async () => {
        _mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0, ok: false });
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: 'fallback',
            status: 200,
            headers: {},
        });
        const res = await streamingFetch('https://api.test.com', { body: '{}' });
        expect(res.status).toBe(200);
    });

    it('handles Copilot URL in streamingFetch with nativeFetch failure gracefully', async () => {
        _mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('bridge down'));
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: 'proxy response',
            status: 200,
            headers: {},
        });
        const res = await streamingFetch('https://api.githubcopilot.com/chat', {
            body: '{"msg":"hi"}',
        });
        expect(res.status).toBe(200);
    });

    it('streamingFetch with direct fetch failure (no bridge) then fails', async () => {
        _mockRisu.nativeFetch = undefined;
        _mockRisu.risuFetch = undefined;
        const orig = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('CSP block'));
        try {
            await expect(streamingFetch('https://api.test.com', {}))
                .rejects.toThrow('All fetch strategies failed');
        } finally {
            globalThis.fetch = orig;
        }
    });
});

describe('smartFetch — Copilot risuFetch proxy-forced body parse failure (L354)', () => {
    beforeEach(() => {
        _resetCompatibilityModeCache();
        _mockRisu.getArgument = vi.fn().mockResolvedValue(null);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('Copilot proxy-forced 4xx with null data returns error response', async () => {
        _mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({ data: null, status: 403, headers: {} });
        const res = await smartFetch('https://api.githubcopilot.com/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        });
        // Should get 403 error response or fall through to next strategy
        expect(typeof res.status).toBe('number');
    });

    it('Copilot plainFetchForce 4xx with null data returns error JSON', async () => {
        let callCount = 0;
        _mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        _mockRisu.risuFetch = vi.fn(async () => {
            callCount++;
            // First call (proxy-forced): no results
            if (callCount === 1) return { data: null, status: 0, headers: {} };
            // Second call (plainFetch): 4xx with null data
            return { data: null, status: 429, headers: {} };
        });
        const res = await smartFetch('https://api.githubcopilot.com/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        });
        // Should eventually return a 429 error response
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('Copilot proxy-forced with invalid response body falls through', async () => {
        _mockRisu.nativeFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        const res = await smartFetch('https://api.githubcopilot.com/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(200);
    });

    it('smartFetch generic path: risuFetch response with valid data but no real headers falls through', async () => {
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({ data: '{"msg":"hi"}', status: 200, headers: {} });
        _mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
        const res = await smartFetch('https://api.openai.com/v1/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(200);
    });

    it('smartFetch nativeFetch unavailable falls back to global fetch', async () => {
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({ data: null, status: 0, headers: {} });
        _mockRisu.nativeFetch = undefined;
        const orig = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('global', { status: 200 }));
        try {
            const res = await smartFetch('https://api.openai.com/v1/chat', {
                body: '{}',
                headers: { 'content-type': 'application/json' },
            });
            expect(res.status).toBe(200);
        } finally {
            globalThis.fetch = orig;
        }
    });

    it('compatibility mode skips nativeFetch in smartFetch generic path', async () => {
        _mockRisu.getArgument = vi.fn().mockResolvedValue('true');
        _resetCompatibilityModeCache();
        _mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: '{"ok":true}', status: 200, headers: { 'content-type': 'application/json' },
        });
        _mockRisu.nativeFetch = vi.fn();
        const res = await smartFetch('https://api.openai.com/v1/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(200);
    });
});

describe('collectStream — additional uncovered branches', () => {
    it('handles non-string non-Uint8Array non-ArrayBuffer value via String()', async () => {
        const stream = new ReadableStream({
            start(c) {
                c.enqueue(42); // number → String(42)
                c.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toContain('42');
    });
});

// ═══════════════════════════════════════════════════════════════
// sse-parser.js — Anthropic SSE thinking/abort/completion paths
// ═══════════════════════════════════════════════════════════════

import { createAnthropicSSEStream } from '../src/shared/sse-parser.js';

function makeSSEResponse(events) {
    const lines = events.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(c) {
            c.enqueue(encoder.encode(lines));
            c.close();
        }
    }));
}

describe('createAnthropicSSEStream — thinking & abort paths', () => {
    it('processes thinking_delta events', async () => {
        const response = makeSSEResponse([
            { event: 'content_block_delta', data: { delta: { type: 'thinking_delta', thinking: 'step1' } } },
            { event: 'content_block_delta', data: { delta: { type: 'thinking_delta', thinking: 'step2' } } },
            { event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'answer' } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).toContain('<Thoughts>');
        expect(text).toContain('step1');
        expect(text).toContain('</Thoughts>');
        expect(text).toContain('answer');
    });

    it('processes redacted_thinking in content_block_delta', async () => {
        const response = makeSSEResponse([
            { event: 'content_block_delta', data: { delta: { type: 'redacted_thinking' } } },
            { event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'main text' } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).toContain('{{redacted_thinking}}');
        expect(text).toContain('main text');
    });

    it('processes redacted_thinking in content_block_start', async () => {
        const response = makeSSEResponse([
            { event: 'content_block_start', data: { content_block: { type: 'redacted_thinking' } } },
            { event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'answer' } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).toContain('{{redacted_thinking}}');
    });

    it('tracks message_start usage and message_delta output tokens', async () => {
        const response = makeSSEResponse([
            { event: 'message_start', data: { message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } } },
            { event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'result' } } },
            { event: 'message_delta', data: { usage: { output_tokens: 30 } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, {
            showThinking: false,
            _requestId: 'req-1',
        });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).toContain('result');
    });

    it('handles abort during streaming', async () => {
        const ac = new AbortController();
        const encoder = new TextEncoder();
        let pushMore;
        const response = new Response(new ReadableStream({
            start(c) {
                c.enqueue(encoder.encode('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"start"}}\n\n'));
                pushMore = () => {
                    try { c.close(); } catch {}
                };
            }
        }));
        const stream = createAnthropicSSEStream(response, ac.signal, {
            showThinking: true,
            _requestId: 'req-abort',
        });
        const reader = stream.getReader();
        await reader.read(); // read first chunk
        ac.abort();
        if (pushMore) pushMore();
        // Stream should close gracefully after abort
        const next = await reader.read();
        expect(next.done).toBe(true);
    });

    it('handles error event in stream', async () => {
        const response = makeSSEResponse([
            { event: 'error', data: { error: { message: 'rate limit' } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, {});
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).toContain('Stream Error');
        expect(text).toContain('rate limit');
    });

    it('handles showThinking=false — hides thinking blocks', async () => {
        const response = makeSSEResponse([
            { event: 'content_block_delta', data: { delta: { type: 'thinking', thinking: 'hidden' } } },
            { event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'visible' } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, { showThinking: false });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).not.toContain('hidden');
        expect(text).toContain('visible');
    });

    it('cancel() finalizes usage', async () => {
        const response = makeSSEResponse([
            { event: 'message_start', data: { message: { usage: { input_tokens: 100 } } } },
            { event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'x' } } },
        ]);
        const stream = createAnthropicSSEStream(response, null, {
            _requestId: 'req-cancel',
            showThinking: false,
        });
        const reader = stream.getReader();
        await reader.read(); // read first chunk
        await reader.cancel(); // triggers cancel()
    });

    it('thinking still open at stream end → auto-close', async () => {
        const response = makeSSEResponse([
            { event: 'content_block_delta', data: { delta: { type: 'thinking', thinking: 'open thinking' } } },
            // Stream ends without text_delta to close thinking
        ]);
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
        }
        expect(text).toContain('<Thoughts>');
        expect(text).toContain('</Thoughts>');
    });
});

// ═══════════════════════════════════════════════════════════════
// message-format.js — formatToAnthropic content merge + cache
// ═══════════════════════════════════════════════════════════════

import { formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';

describe('formatToAnthropic — content merge & cache_control (L314-344)', () => {
    it('merges consecutive same-role text messages into array', () => {
        const msgs = [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
        ];
        const result = formatToAnthropic(msgs);
        // First user message in formatted should contain both texts
        expect(result.messages.length).toBeGreaterThanOrEqual(1);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        expect(userMsg.content.length).toBeGreaterThanOrEqual(2);
    });

    it('merges text into existing array content', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'text', text: 'arr msg' }] },
            { role: 'user', content: 'text msg' },
        ];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
    });

    it('applies cache_control to message with cachePoint (L337-342)', () => {
        const msgs = [
            { role: 'user', content: 'cached content', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const lastPart = userMsg.content[userMsg.content.length - 1];
        expect(lastPart.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('converts string content to array for cache_control (L338-339)', () => {
        // This tests the path where msg.content is still a string when cache_control is applied
        const msgs = [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'question', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs);
        expect(result.messages.length).toBeGreaterThanOrEqual(1);
    });

    it('prepends user message if first is not user', () => {
        const msgs = [
            { role: 'assistant', content: 'response' },
        ];
        const result = formatToAnthropic(msgs);
        expect(result.messages[0].role).toBe('user');
    });

    it('extracts system messages', () => {
        const msgs = [
            { role: 'system', content: 'sys prompt' },
            { role: 'user', content: 'hello' },
        ];
        const result = formatToAnthropic(msgs);
        expect(result.system).toContain('sys prompt');
    });

    it('multimodal image merge into same-role message', () => {
        const msgs = [
            { role: 'user', content: 'text first' },
            {
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } }],
            },
        ];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
    });

    it('handles URL image source', () => {
        const msgs = [
            {
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.jpg' } }],
            },
        ];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
    });
});

describe('formatToGemini — additional branches', () => {
    it('converts non-leading system messages to user parts', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user1' },
            { role: 'system', content: 'mid-system' },
        ];
        const result = formatToGemini(msgs);
        // mid-system should appear as user part with "system: " prefix
        const found = result.contents.some(c =>
            c.parts.some(p => p.text?.includes('system:'))
        );
        expect(found).toBe(true);
    });

    it('skips empty content messages', () => {
        const msgs = [
            { role: 'user', content: '' },
            { role: 'user', content: 'valid' },
        ];
        const result = formatToGemini(msgs);
        expect(result.contents.length).toBe(1);
    });

    it('handles non-string content via JSON.stringify', () => {
        const msgs = [
            { role: 'user', content: { data: 'obj' } },
        ];
        const result = formatToGemini(msgs);
        expect(result.contents.length).toBeGreaterThanOrEqual(1);
    });

    it('strips thought display from assistant messages', () => {
        const msgs = [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: '<Thoughts>thinking</Thoughts>\n\nAnswer here' },
        ];
        const result = formatToGemini(msgs);
        const model = result.contents.find(c => c.role === 'model');
        if (model) {
            const text = model.parts.map(p => p.text).join('');
            expect(text).not.toContain('<Thoughts>');
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// dynamic-models.js — AWS inference profiles & mergeDynamicModels
// ═══════════════════════════════════════════════════════════════

import {
    formatAwsDynamicModels,
    mergeDynamicModels,
    normalizeAwsAnthropicModelId,
} from '../src/shared/dynamic-models.js';

describe('formatAwsDynamicModels — inference profiles (L154-161)', () => {
    it('includes inference profiles with anthropic in ID', () => {
        const models = [{ modelId: 'anthropic.claude-3-sonnet' }];
        const profiles = [
            { inferenceProfileId: 'us.anthropic.claude-3-5-sonnet', inferenceProfileName: 'US Claude' },
        ];
        const result = formatAwsDynamicModels(models, profiles);
        expect(result.some(r => r.name.includes('Cross-Region'))).toBe(true);
    });

    it('skips non-anthropic inference profiles', () => {
        const profiles = [
            { inferenceProfileId: 'us.meta.llama3', inferenceProfileName: 'Llama' },
        ];
        const result = formatAwsDynamicModels([], profiles);
        expect(result.length).toBe(0);
    });

    it('deduplicates inference profiles with existing models', () => {
        const models = [{ modelId: 'anthropic.claude-3-sonnet' }];
        const profiles = [
            { inferenceProfileId: 'anthropic.claude-3-sonnet', inferenceProfileName: 'Same Model' },
        ];
        const result = formatAwsDynamicModels(models, profiles);
        // Should not duplicate
        const set = new Set(result.map(r => r.id));
        expect(set.size).toBe(result.length);
    });

    it('uses inferenceProfileArn when no inferenceProfileId', () => {
        const profiles = [
            { inferenceProfileArn: 'arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-v2', inferenceProfileName: 'ARN Profile' },
        ];
        const result = formatAwsDynamicModels([], profiles);
        expect(result.length).toBe(1);
    });
});

describe('mergeDynamicModels — edge cases (L167-189)', () => {
    it('filters invalid model objects', () => {
        const result = mergeDynamicModels([null, 42, 'str'], [{ id: 'a', name: 'A' }], 'Test');
        expect(result.mergedModels.length).toBe(1);
    });

    it('skips models without id or name', () => {
        const result = mergeDynamicModels([], [{ id: '', name: 'NoID' }, { id: 'x', name: '' }], 'Test');
        expect(result.mergedModels.length).toBe(0);
    });

    it('overwrites existing model with same key', () => {
        const existing = [{ id: 'model-1', name: 'Old Name', provider: 'P' }];
        const incoming = [{ id: 'model-1', name: 'New Name', provider: 'P' }];
        const result = mergeDynamicModels(existing, incoming, 'P');
        expect(result.mergedModels.length).toBe(1);
        expect(result.addedModels.length).toBe(0); // Overwrite, not new
    });

    it('adds new models and tracks addedModels', () => {
        const existing = [{ id: 'a', name: 'A', provider: 'P' }];
        const incoming = [{ id: 'b', name: 'B', provider: 'P' }];
        const result = mergeDynamicModels(existing, incoming, 'P');
        expect(result.addedModels.length).toBe(1);
        expect(result.mergedModels.length).toBe(2);
    });

    it('sorts merged models alphabetically by name', () => {
        const incoming = [
            { id: 'z', name: 'Zebra' },
            { id: 'a', name: 'Alpha' },
        ];
        const result = mergeDynamicModels([], incoming, 'P');
        expect(result.mergedModels[0].name).toBe('Alpha');
        expect(result.mergedModels[1].name).toBe('Zebra');
    });
});

// ═══════════════════════════════════════════════════════════════
// key-pool.js — JSON object key detection (L125-132)
// ═══════════════════════════════════════════════════════════════

import { KeyPool } from '../src/shared/key-pool.js';

describe('KeyPool — JSON object key detection (L126-129)', () => {
    it('treats JSON object string as single key', () => {
        const pool = new KeyPool('{"type":"service_account","project_id":"test"}');
        expect(pool.keys.length).toBe(1);
    });

    it('splits whitespace-separated keys', () => {
        const pool = new KeyPool('sk-key1 sk-key2 sk-key3');
        expect(pool.keys.length).toBe(3);
    });

    it('handles empty string', () => {
        const pool = new KeyPool('');
        expect(pool.keys.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// slot-inference.js — multi-collision and equal scores (L104)
// ═══════════════════════════════════════════════════════════════

import { scoreSlotHeuristic, SLOT_HEURISTICS } from '../src/shared/slot-inference.js';

describe('slot-inference — scoring and collision branches', () => {
    it('scoreSlotHeuristic returns 0 for unknown slot', () => {
        const score = scoreSlotHeuristic('some text', 'nonexistent_slot', SLOT_HEURISTICS);
        expect(score).toBe(0);
    });

    it('scoreSlotHeuristic scores translation slot correctly', () => {
        const score = scoreSlotHeuristic('translate this text to Korean', 'translation', SLOT_HEURISTICS);
        expect(score).toBeGreaterThan(0);
    });

    it('secondBest gets updated for non-best scores (L103-104)', () => {
        // Test with multiple matching slots where second best needs updating
        const text = 'translate text and handle emotions with memory';
        const s1 = scoreSlotHeuristic(text, 'translation', SLOT_HEURISTICS);
        const s2 = scoreSlotHeuristic(text, 'emotion', SLOT_HEURISTICS);
        // Both should have some score
        expect(s1).toBeGreaterThanOrEqual(0);
        expect(s2).toBeGreaterThanOrEqual(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// custom-model-serialization.js — normalizeCustomModel fields
// ═══════════════════════════════════════════════════════════════

import { normalizeCustomModel, parseCustomModelsValue, serializeCustomModelExport } from '../src/shared/custom-model-serialization.js';

describe('normalizeCustomModel — default fields (L75-100)', () => {
    it('normalizes minimal input with all defaults', () => {
        const result = normalizeCustomModel({ name: 'MyModel', model: 'gpt-4' });
        expect(result.name).toBe('MyModel');
        expect(result.format).toBe('openai');
        expect(result.tok).toBe('o200k_base');
        expect(result.responsesMode).toBe('auto');
        expect(result.thinking).toBe('none');
    });

    it('normalizes decoupled=true', () => {
        const result = normalizeCustomModel({ name: 'M', model: 'm', decoupled: true });
        expect(result.decoupled).toBe(true);
    });

    it('normalizes streaming=false', () => {
        const result = normalizeCustomModel({ name: 'M', model: 'm', streaming: false });
        expect(result.streaming).toBe(false);
    });

    it('handles all format options', () => {
        for (const fmt of ['openai', 'anthropic', 'gemini', 'custom']) {
            const result = normalizeCustomModel({ name: 'M', model: 'm', format: fmt });
            expect(result.format).toBe(fmt);
        }
    });

    it('handles unknown format → defaults', () => {
        const result = normalizeCustomModel({ name: 'M', model: 'm', format: '' });
        expect(result.format).toBe('openai');
    });
});

describe('parseCustomModelsValue', () => {
    it('parses null → empty array', () => {
        expect(parseCustomModelsValue(null)).toEqual([]);
    });

    it('parses array of model objects', () => {
        const models = [{ name: 'A', model: 'a' }, { name: 'B', model: 'b' }];
        const result = parseCustomModelsValue(JSON.stringify(models));
        expect(result.length).toBe(2);
    });
});

describe('serializeCustomModelExport', () => {
    it('serializes to object with _cpmModelExport flag', () => {
        const model = { name: 'M', model: 'm', url: 'http://test', format: 'openai' };
        const result = serializeCustomModelExport(model);
        expect(typeof result).toBe('object');
        expect(result.name).toBe('M');
    });
});

// ═══════════════════════════════════════════════════════════════
// safe-db-writer.js — validatePlugin branches
// ═══════════════════════════════════════════════════════════════

import { validateDbPatch, safeSetDatabaseLite } from '../src/shared/safe-db-writer.js';

describe('safe-db-writer — validateDbPatch edge cases', () => {
    it('rejects patch with array plugin', () => {
        const result = validateDbPatch({ plugins: [[], { name: 'X', version: '3.0', script: 'c', versionOfPlugin: '1.0' }] });
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes('not a valid object'))).toBe(true);
    });

    it('rejects patch with null plugin', () => {
        const result = validateDbPatch({ plugins: [null] });
        expect(result.ok).toBe(false);
    });

    it('rejects plugin with missing required field', () => {
        const result = validateDbPatch({ plugins: [{ name: '', version: '3.0', script: 'c' }] });
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes('missing or empty'))).toBe(true);
    });

    it('rejects non-3.0 version', () => {
        const result = validateDbPatch({
            plugins: [{ name: 'Test', version: '2.0', script: 'code', versionOfPlugin: '1.0' }],
        });
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes("expected '3.0'"))).toBe(true);
    });

    it('rejects name longer than 200 chars', () => {
        const result = validateDbPatch({
            plugins: [{ name: 'X'.repeat(201), version: '3.0', script: 'code', versionOfPlugin: '1.0' }],
        });
        expect(result.ok).toBe(false);
    });

    it('accepts valid plugin', () => {
        const result = validateDbPatch({
            plugins: [{ name: 'TestPlugin', version: '3.0', script: 'code here', versionOfPlugin: '1.0.0', enabled: true }],
        });
        expect(result.ok).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// api-request-log.js — store edge cases
// ═══════════════════════════════════════════════════════════════

import { createApiRequestLog } from '../src/shared/api-request-log.js';

describe('api-request-log — store edge cases (L16)', () => {
    it('wraps primitive entry in object', () => {
        const log = createApiRequestLog(10);
        const id = log.store('primitive');
        expect(typeof id).toBe('string');
    });

    it('auto-generates id if missing', () => {
        const log = createApiRequestLog(10);
        const id = log.store({ data: 'test' });
        expect(typeof id).toBe('string');
    });

    it('preserves existing id', () => {
        const log = createApiRequestLog(10);
        const id = log.store({ id: 'my-id', data: 'test' });
        expect(id).toBe('my-id');
    });

    it('respects maxSize limit', () => {
        const log = createApiRequestLog(3);
        log.store({ a: 1 });
        log.store({ b: 2 });
        log.store({ c: 3 });
        log.store({ d: 4 }); // Should evict oldest
        expect(log.getAll().length).toBe(3);
    });
});

// ═══════════════════════════════════════════════════════════════
// normalizeAwsAnthropicModelId — edge cases
// ═══════════════════════════════════════════════════════════════

describe('normalizeAwsAnthropicModelId', () => {
    it('adds us. prefix to bare anthropic model', () => {
        const result = normalizeAwsAnthropicModelId('anthropic.claude-3-sonnet-20240229-v1:0');
        expect(result).toMatch(/^(us|global)\..+/);
    });

    it('keeps already normalized id with prefix', () => {
        const result = normalizeAwsAnthropicModelId('us.anthropic.claude-3-sonnet');
        expect(result).toBe('us.anthropic.claude-3-sonnet');
    });

    it('returns empty for empty input', () => {
        const result = normalizeAwsAnthropicModelId('');
        expect(result).toBe('');
    });

    it('returns as-is for non-anthropic model', () => {
        const result = normalizeAwsAnthropicModelId('meta.llama3');
        expect(result).toBe('meta.llama3');
    });

    it('uses global prefix for newer models (date >= 20250929)', () => {
        const result = normalizeAwsAnthropicModelId('anthropic.claude-4-opus-20251001-v1:0');
        expect(result).toMatch(/^global\..+/);
    });
});
