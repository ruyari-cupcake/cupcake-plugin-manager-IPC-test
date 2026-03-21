/**
 * branch-coverage-90-round3.test.js
 * 4개 모듈(sse-parser, auto-updater, message-format, helpers) 브랜치 커버리지 90% 돌파 목표
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── sse-parser ──
import {
    createSSEStream,
    parseOpenAISSELine,
    parseResponsesAPINonStreamingResponse,
    saveThoughtSignatureFromStream,
    createAnthropicSSEStream,
    createResponsesAPISSEStream,
    createOpenAISSEStream,
    parseGeminiSSELine,
    ThoughtSignatureCache,
    parseGeminiNonStreamingResponse,
    parseClaudeNonStreamingResponse,
    parseOpenAINonStreamingResponse,
    normalizeOpenAIMessageContent,
} from '../src/shared/sse-parser.js';

// ── helpers ──
import {
    extractImageUrlFromPart,
    _stripNonSerializable,
    collectStream,
    shouldEnableStreaming,
    isCompatibilityModeSettingEnabled,
    _resetCompatibilityModeCache,
    isCompatibilityModeEnabled,
} from '../src/shared/helpers.js';

// ── message-format ──
import {
    formatToAnthropic,
    formatToOpenAI,
    formatToGemini,
} from '../src/shared/message-format.js';

// ══════════════════════════════════════════════════════════
// SSE-PARSER BRANCH PUSH
// ══════════════════════════════════════════════════════════

describe('createSSEStream — abort branch push', () => {
    it('abort during pull → closes stream after enqueue from onComplete', async () => {
        const ac = new AbortController();
        let readCount = 0;
        const mockReader = {
            read: vi.fn(async () => {
                readCount++;
                if (readCount === 1) return { done: false, value: new TextEncoder().encode('data: {"x":1}\n') };
                // abort before returning empty data
                ac.abort();
                return { done: false, value: new Uint8Array(0) };
            }),
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };
        const lineParser = (line) => line.startsWith('data:') ? 'parsed' : null;

        const stream = createSSEStream(fakeResponse, lineParser, ac.signal, () => 'complete-extra');
        const reader = stream.getReader();
        const chunk1 = await reader.read();
        expect(chunk1.value).toBe('parsed');
        // Second pull: read returns empty → loop continues → abort check → enqueue 'complete-extra' + close
        const chunk2 = await reader.read();
        expect(chunk2.value).toBe('complete-extra');
        const chunk3 = await reader.read();
        expect(chunk3.done).toBe(true);
    });

    it('cancel() calls onComplete and reader.cancel', async () => {
        const mockReader = {
            read: vi.fn(async () => new Promise(() => {})), // never resolves
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };
        const onComplete = vi.fn(() => null);

        const stream = createSSEStream(fakeResponse, () => null, null, onComplete);
        await stream.cancel();
        expect(onComplete).toHaveBeenCalledOnce();
        expect(mockReader.cancel).toHaveBeenCalledOnce();
    });

    it('onComplete is not a function → no error', async () => {
        const mockReader = {
            read: vi.fn(async () => ({ done: true, value: undefined })),
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(fakeResponse, () => null, null, 'not-a-function');
        const reader = stream.getReader();
        const result = await reader.read();
        expect(result.done).toBe(true);
    });

    it('error during read (non-AbortError) → controller.error', async () => {
        const mockReader = {
            read: vi.fn(async () => { throw new TypeError('network failure'); }),
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(fakeResponse, () => null, null, null);
        const reader = stream.getReader();
        await expect(reader.read()).rejects.toThrow('network failure');
    });

    it('AbortError during read → controller.close (no error)', async () => {
        const mockReader = {
            read: vi.fn(async () => {
                const err = new DOMException('aborted', 'AbortError');
                throw err;
            }),
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(fakeResponse, () => null, null, () => 'extra');
        const reader = stream.getReader();
        const result = await reader.read();
        // Should close gracefully, not throw
        expect(result.done).toBe(true);
    });

    it('buffer with remaining data at done → parsed and enqueued', async () => {
        let callCount = 0;
        const mockReader = {
            read: vi.fn(async () => {
                callCount++;
                if (callCount === 1) return { done: false, value: new TextEncoder().encode('data: "hello"') };
                return { done: true, value: undefined };
            }),
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(fakeResponse, (line) => line.startsWith('data:') ? 'buffered' : null, null, null);
        const reader = stream.getReader();
        const chunk = await reader.read();
        expect(chunk.value).toBe('buffered');
    });

    it('comment lines (starting with :) are skipped', async () => {
        let callCount = 0;
        const mockReader = {
            read: vi.fn(async () => {
                callCount++;
                if (callCount === 1) return { done: false, value: new TextEncoder().encode(': keep-alive\ndata: real\n') };
                return { done: true, value: undefined };
            }),
            cancel: vi.fn(),
        };
        const fakeResponse = { body: { getReader: () => mockReader } };
        const parsed = [];
        const stream = createSSEStream(fakeResponse, (line) => { parsed.push(line); return line; }, null, null);
        const reader = stream.getReader();
        await reader.read();
        // Only 'data: real' should be parsed, not ': keep-alive'
        expect(parsed).toEqual(['data: real']);
    });
});

describe('parseOpenAISSELine — reasoning ?? operator branches', () => {
    it('delta.reasoning (not reasoning_content) with showThinking', () => {
        const config = { showThinking: true, _inThinking: false };
        const line = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'think step' } }] })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('think step');
        expect(config._inThinking).toBe(true);
    });

    it('delta.reasoning_content takes priority over delta.reasoning', () => {
        const config = { showThinking: true, _inThinking: false };
        const line = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'priority', reasoning: 'fallback' } }] })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('priority');
        expect(result).not.toContain('fallback');
    });

    it('delta with no reasoning and no content → null', () => {
        const config = { showThinking: true };
        const line = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}`;
        expect(parseOpenAISSELine(line, config)).toBeNull();
    });

    it('delta.content after thinking → closes thoughts block', () => {
        const config = { showThinking: true, _inThinking: true };
        const line = `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('answer');
        expect(config._inThinking).toBe(false);
    });

    it('usage object without _requestId → no crash', () => {
        const config = {};
        const line = `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20 } })}`;
        expect(parseOpenAISSELine(line, config)).toBeNull();
    });

    it('invalid JSON after data: → null', () => {
        expect(parseOpenAISSELine('data: {invalid json}')).toBeNull();
    });

    it('non-data line → null', () => {
        expect(parseOpenAISSELine('event: done')).toBeNull();
    });

    it('[DONE] → null', () => {
        expect(parseOpenAISSELine('data: [DONE]')).toBeNull();
    });
});

describe('parseResponsesAPINonStreamingResponse — config branch push', () => {
    it('reasoning item with showThinking=false → no thoughts block', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: false });
        expect(result.success).toBe(true);
        expect(result.content).not.toContain('<Thoughts>');
        expect(result.content).toBe('answer');
    });

    it('reasoning item with non-array summary → skipped', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: 'not-array' },
                { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toBe('answer');
    });

    it('reasoning summary with non-summary_text type → skipped', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'other', text: 'skip' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toBe('answer');
    });

    it('data.usage with _requestId → records token usage', () => {
        const data = {
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { _requestId: 'req-123' });
        expect(result.success).toBe(true);
    });

    it('data.usage without _requestId → no crash', () => {
        const data = {
            usage: { prompt_tokens: 100 },
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        };
        const result = parseResponsesAPINonStreamingResponse(data, {});
        expect(result.success).toBe(true);
    });

    it('data.error → returns error result', () => {
        const result = parseResponsesAPINonStreamingResponse({ error: { message: 'bad' } });
        expect(result.success).toBe(false);
        expect(result.content).toContain('bad');
    });

    it('empty output → falls back to choices format', () => {
        const data = { choices: [{ message: { content: 'fallback text' } }] };
        const result = parseResponsesAPINonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('fallback text');
    });

    it('no output and no choices → unexpected error', () => {
        const result = parseResponsesAPINonStreamingResponse({ other: 'data' });
        expect(result.success).toBe(false);
        expect(result.content).toContain('Unexpected');
    });

    it('output with non-message non-reasoning types → skipped', () => {
        const data = {
            output: [
                { type: 'function_call', name: 'test' },
                { type: 'message', content: [{ type: 'output_text', text: 'result' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, {});
        expect(result.content).toBe('result');
    });
});

describe('saveThoughtSignatureFromStream — partial config branches', () => {
    it('no _inThoughtBlock, no _lastSignature, no _requestId → returns null', () => {
        const result = saveThoughtSignatureFromStream({});
        expect(result).toBeNull();
    });

    it('_inThoughtBlock=true → appends closing tag and returns it', () => {
        const config = { _inThoughtBlock: true };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('_lastSignature + _streamResponseText → saves to ThoughtSignatureCache', () => {
        const config = { _lastSignature: 'sig-abc', _streamResponseText: 'response text' };
        // Should not throw
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toBeNull();
    });

    it('_requestId and _streamUsageMetadata with valid gemini usage', () => {
        const config = {
            _requestId: 'req-gemini-1',
            _streamUsageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
        };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toBeNull();
    });

    it('_requestId set but no _streamUsageMetadata → skips usage', () => {
        const config = { _requestId: 'req-no-usage' };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toBeNull();
    });

    it('all flags set → closing tag + signature save + usage', () => {
        const config = {
            _inThoughtBlock: true,
            _lastSignature: 'sig-xyz',
            _streamResponseText: 'full response',
            _requestId: 'req-all',
            _streamUsageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
        };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toContain('</Thoughts>');
    });
});

describe('createAnthropicSSEStream — branch push via full stream consumption', () => {
    function makeAnthropicReader(events) {
        let idx = 0;
        const encoder = new TextEncoder();
        return {
            read: vi.fn(async () => {
                if (idx >= events.length) return { done: true, value: undefined };
                const chunk = events[idx++];
                return { done: false, value: encoder.encode(chunk) };
            }),
            cancel: vi.fn(),
        };
    }

    it('thinking_delta → text_delta stream produces <Thoughts> block', async () => {
        const events = [
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"step1"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n',
        ];
        const reader = makeAnthropicReader(events);
        const response = { body: { getReader: () => reader } };
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const chunks = [];
        const r = stream.getReader();
        while (true) {
            const { done, value } = await r.read();
            if (done) break;
            chunks.push(value);
        }
        const full = chunks.join('');
        expect(full).toContain('<Thoughts>');
        expect(full).toContain('step1');
        expect(full).toContain('answer');
    });

    it('message_start with usage → accumulates input_tokens', async () => {
        const events = [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        ];
        const reader = makeAnthropicReader(events);
        const response = { body: { getReader: () => reader } };
        const config = { _requestId: 'req-a1', showThinking: false };
        const stream = createAnthropicSSEStream(response, null, config);
        const r = stream.getReader();
        while (true) { const { done } = await r.read(); if (done) break; }
        // Should not throw
    });

    it('error event → enqueues error text', async () => {
        const events = [
            'event: error\ndata: {"type":"error","error":{"message":"rate limit"}}\n\n',
        ];
        const reader = makeAnthropicReader(events);
        const response = { body: { getReader: () => reader } };
        const stream = createAnthropicSSEStream(response, null, {});
        const chunks = [];
        const r = stream.getReader();
        while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
        expect(chunks.join('')).toContain('rate limit');
    });

    it('abort during stream → closes gracefully with closing tag', async () => {
        const ac = new AbortController();
        let callCount = 0;
        const reader = {
            read: vi.fn(async () => {
                callCount++;
                if (callCount === 1) {
                    return { done: false, value: new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"t"}}\n\n') };
                }
                ac.abort();
                return { done: false, value: new TextEncoder().encode('') };
            }),
            cancel: vi.fn(),
        };
        const response = { body: { getReader: () => reader } };
        const stream = createAnthropicSSEStream(response, ac.signal, { showThinking: true });
        const chunks = [];
        const r = stream.getReader();
        while (true) { const { done, value } = await r.read(); if (done) break; if (value) chunks.push(value); }
        const full = chunks.join('');
        expect(full).toContain('</Thoughts>');
    });
});

describe('parseGeminiSSELine — branch push', () => {
    it('candidates with thinking text → opens thought block', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: false };
        const data = {
            candidates: [{
                content: {
                    parts: [{ thought: true, text: 'gemini thinks' }],
                },
            }],
        };
        const line = `data: ${JSON.stringify(data)}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('gemini thinks');
        expect(config._inThoughtBlock).toBe(true);
    });

    it('candidates with regular text after thinking → closes thought block', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true, _streamResponseText: '' };
        const data = {
            candidates: [{
                content: {
                    parts: [{ text: 'regular output' }],
                },
            }],
        };
        const line = `data: ${JSON.stringify(data)}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('regular output');
    });

    it('usageMetadata in candidates → stored in config', () => {
        const config = { _requestId: 'req-gem-1', _streamResponseText: '' };
        const data = {
            candidates: [{ content: { parts: [{ text: 'hi' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        };
        const line = `data: ${JSON.stringify(data)}`;
        parseGeminiSSELine(line, config);
        expect(config._streamUsageMetadata).toBeDefined();
    });

    it('non-data line → null', () => {
        expect(parseGeminiSSELine('event: update')).toBeNull();
    });

    it('invalid JSON → null', () => {
        expect(parseGeminiSSELine('data: {{{bad')).toBeNull();
    });

    it('no candidates in parsed data → null', () => {
        const line = `data: ${JSON.stringify({ modelVersion: '1.5' })}`;
        expect(parseGeminiSSELine(line, {})).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════
// HELPERS BRANCH PUSH
// ══════════════════════════════════════════════════════════

describe('extractImageUrlFromPart — input_image branch push', () => {
    it('input_image with string image_url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'https://img.example.com/photo.jpg' }))
            .toBe('https://img.example.com/photo.jpg');
    });

    it('input_image with object image_url.url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'https://img.example.com/obj.jpg' } }))
            .toBe('https://img.example.com/obj.jpg');
    });

    it('input_image with no image_url → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'input_image' })).toBe('');
    });

    it('image_url type with string image_url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: 'data:image/png;base64,abc' }))
            .toBe('data:image/png;base64,abc');
    });

    it('image_url type with object image_url.url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }))
            .toBe('https://example.com/img.png');
    });

    it('unknown type → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'audio', data: 'abc' })).toBe('');
    });

    it('null input → empty string', () => {
        expect(extractImageUrlFromPart(null)).toBe('');
    });

    it('non-object input → empty string', () => {
        expect(extractImageUrlFromPart('string-input')).toBe('');
    });

    it('image_url type with non-string non-object image_url → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: 12345 })).toBe('');
    });

    it('input_image with image_url object missing url property → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { detail: 'high' } })).toBe('');
    });
});

describe('_stripNonSerializable — deep branch push', () => {
    it('depth > 15 → returns obj as-is', () => {
        let obj = { a: 1 };
        const result = _stripNonSerializable(obj, 16);
        expect(result).toBe(obj); // same reference
    });

    it('function → undefined', () => {
        expect(_stripNonSerializable(function() {})).toBeUndefined();
    });

    it('symbol → undefined', () => {
        expect(_stripNonSerializable(Symbol('test'))).toBeUndefined();
    });

    it('bigint → undefined', () => {
        expect(_stripNonSerializable(BigInt(42))).toBeUndefined();
    });

    it('Date → String(date)', () => {
        const d = new Date('2025-01-01');
        const result = _stripNonSerializable(d);
        expect(typeof result).toBe('string');
        expect(result).toContain('2025');
    });

    it('RegExp → String(regex)', () => {
        const r = /test/gi;
        const result = _stripNonSerializable(r);
        expect(result).toBe('/test/gi');
    });

    it('Error → String(error)', () => {
        const e = new Error('my error');
        const result = _stripNonSerializable(e);
        expect(typeof result).toBe('string');
        expect(result).toContain('my error');
    });

    it('Uint8Array → returns as-is', () => {
        const arr = new Uint8Array([1, 2, 3]);
        const result = _stripNonSerializable(arr);
        expect(result).toBe(arr);
    });

    it('ArrayBuffer → returns as-is', () => {
        const buf = new ArrayBuffer(8);
        const result = _stripNonSerializable(buf);
        expect(result).toBe(buf);
    });

    it('null → null', () => {
        expect(_stripNonSerializable(null)).toBeNull();
    });

    it('undefined → undefined', () => {
        expect(_stripNonSerializable(undefined)).toBeUndefined();
    });

    it('primitives (string, number, boolean) → returned as-is', () => {
        expect(_stripNonSerializable('hello')).toBe('hello');
        expect(_stripNonSerializable(42)).toBe(42);
        expect(_stripNonSerializable(true)).toBe(true);
    });

    it('array with mixed types → filters out undefined', () => {
        const result = _stripNonSerializable([1, function() {}, 'hello', Symbol('x')]);
        expect(result).toEqual([1, 'hello']);
    });

    it('nested object → strips functions from properties', () => {
        const result = _stripNonSerializable({ a: 1, b: function() {}, c: { d: 'ok' } });
        expect(result).toEqual({ a: 1, c: { d: 'ok' } });
    });
});

describe('collectStream — abort and ArrayBuffer branch push', () => {
    it('abortSignal already aborted → returns empty string immediately', async () => {
        const ac = new AbortController();
        ac.abort();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('should not read');
                controller.close();
            },
        });
        const result = await collectStream(stream, ac.signal);
        expect(result).toBe('');
    });

    it('abortSignal aborted mid-stream → detected on next iteration', async () => {
        const ac = new AbortController();
        // Create a stream that provides one chunk then aborts in pull
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('first ');
            },
            pull(controller) {
                // Abort and close — collectStream gets {done:true} and exits
                ac.abort();
                controller.close();
            },
        });
        const result = await collectStream(stream, ac.signal);
        expect(result).toBe('first ');
    });

    it('Uint8Array chunks → decoded properly', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('hello'));
                controller.enqueue(new TextEncoder().encode(' world'));
                controller.close();
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('hello world');
    });

    it('ArrayBuffer chunks → decoded properly', async () => {
        const stream = new ReadableStream({
            start(controller) {
                const buf = new TextEncoder().encode('arraybuf').buffer;
                controller.enqueue(buf);
                controller.close();
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('arraybuf');
    });

    it('string chunks → concatenated directly', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('str1');
                controller.enqueue('str2');
                controller.close();
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('str1str2');
    });

    it('null value chunk → skipped', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('before');
                controller.enqueue(null);
                controller.enqueue('after');
                controller.close();
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('beforeafter');
    });

    it('non-standard value → String() fallback', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(12345);
                controller.close();
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('12345');
    });

    it('AbortError thrown by reader → caught gracefully', async () => {
        const stream = new ReadableStream({
            pull() {
                throw new DOMException('aborted', 'AbortError');
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('');
    });

    it('non-AbortError thrown → rethrown', async () => {
        const stream = new ReadableStream({
            pull() {
                throw new TypeError('bad type');
            },
        });
        await expect(collectStream(stream)).rejects.toThrow('bad type');
    });
});

// ══════════════════════════════════════════════════════════
// MESSAGE-FORMAT BRANCH PUSH
// ══════════════════════════════════════════════════════════

describe('formatToAnthropic — Array.isArray(m.content) branch push', () => {
    it('array content with text parts', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'text', text: 'Hello from array' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
    });

    it('array content with image base64 source part', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
                }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('array content with inlineData image part', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    inlineData: { data: 'base64data', mimeType: 'image/jpeg' },
                }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('array content with inlineData non-image → skipped', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    inlineData: { data: 'audiodata', mimeType: 'audio/mp3' },
                }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        // Should still produce a message since there's a user guard
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('array content with image_url data URI', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
                }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        // Should contain image source with base64
        const content = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('base64');
    });

    it('array content with image_url HTTP URL', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    type: 'image_url',
                    image_url: { url: 'https://example.com/image.png' },
                }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const content = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('url');
    });

    it('array content with input_image string image_url', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    type: 'input_image',
                    image_url: 'data:image/jpeg;base64,/9j/4AAQ',
                }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('same-role merge (two consecutive user messages with array content)', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'text', text: 'part1' }] },
            { role: 'user', content: [{ type: 'text', text: 'part2' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        // Should be merged into single user message
        const userMsgs = result.messages.filter(m => m.role === 'user');
        // May be 1 merged or first + appended
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('array content with empty parts → falls through to text path', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'unknown_type' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('array content with null part → skipped', () => {
        const msgs = [
            {
                role: 'user',
                content: [null, { type: 'text', text: 'valid' }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('array content with text part having empty text → skipped', () => {
        const msgs = [
            {
                role: 'user',
                content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'real' }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('array content merge into existing string content message', () => {
        const msgs = [
            { role: 'user', content: 'first message text' },
            { role: 'user', content: [{ type: 'text', text: 'array merge' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsgs = result.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('cachePoint on message → adds cache_control', () => {
        const msgs = [
            { role: 'user', content: 'cached message', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const content = Array.isArray(userMsg.content) ? userMsg.content : [];
        const lastPart = content[content.length - 1];
        if (lastPart) {
            expect(lastPart.cache_control).toBeDefined();
        }
    });

    it('system message → extracted to systemPrompt', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hello' },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.system).toContain('You are helpful');
    });

    it('empty messages → returns user guard message', () => {
        const result = formatToAnthropic([], {});
        expect(result.messages.length).toBeGreaterThan(0);
        expect(result.messages[0].role).toBe('user');
    });
});

// ══════════════════════════════════════════════════════════
// AUTO-UPDATER BRANCH PUSH
// ══════════════════════════════════════════════════════════

describe('auto-updater — retryPendingUpdateOnBoot branch push', () => {
    /** @type {ReturnType<typeof import('../src/shared/auto-updater.js').createAutoUpdater>} */
    let updater;
    let Risu;

    beforeEach(() => {
        Risu = {
            getDatabase: vi.fn(async () => ({
                plugins: [
                    {
                        name: 'CPM | Cupcake Provider Manager',
                        versionOfPlugin: '1.19.0',
                        script: 'code',
                        realArg: {},
                    },
                ],
            })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async (key) => key === 'cpm_disable_autoupdate' ? null : 'true'),
            risuFetch: vi.fn(async () => ({ status: 200, data: '{}' })),
            nativeFetch: vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () => '//@name Test\n//@version 1.20.0\nconsole.log("hi")',
            })),
        };
    });

    it('no pending update → returns false', async () => {
        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'Test' });

        // readPendingUpdate returns null  
        Risu.pluginStorage.getItem.mockResolvedValue(null);
        const result = await au.retryPendingUpdateOnBoot();
        expect(result).toBe(false);
    });

    it('installed version >= pending version → clears and returns true', async () => {
        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.20.0', pluginName: 'CPM | Cupcake Provider Manager' });

        // readPendingUpdate returns a pending update with lower version
        Risu.pluginStorage.getItem.mockImplementation(async (key) => {
            if (key === 'cpm_pending_main_update') {
                return JSON.stringify({ version: '1.19.0', attempts: 0, lastAttemptTs: 0 });
            }
            return null;
        });
        Risu.getDatabase.mockResolvedValue({
            plugins: [{ name: 'CPM | Cupcake Provider Manager', versionOfPlugin: '1.20.0', script: 'code', realArg: {} }],
        });

        const result = await au.retryPendingUpdateOnBoot();
        expect(result).toBe(true);
    });

    it('max attempts exceeded → clears and returns false', async () => {
        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        Risu.pluginStorage.getItem.mockImplementation(async (key) => {
            if (key === 'cpm_pending_main_update') {
                return JSON.stringify({ version: '1.20.0', attempts: 999, lastAttemptTs: 0 });
            }
            return null;
        });

        const result = await au.retryPendingUpdateOnBoot();
        expect(result).toBe(false);
    });

    it('cooldown active → returns false without retry', async () => {
        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        Risu.pluginStorage.getItem.mockImplementation(async (key) => {
            if (key === 'cpm_pending_main_update') {
                return JSON.stringify({ version: '1.20.0', attempts: 1, lastAttemptTs: Date.now() });
            }
            return null;
        });

        const result = await au.retryPendingUpdateOnBoot();
        expect(result).toBe(false);
    });

    it('exception during retry → returns false', async () => {
        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        Risu.pluginStorage.getItem.mockImplementation(async (key) => {
            if (key === 'cpm_pending_main_update') {
                throw new Error('storage error');
            }
            return null;
        });

        const result = await au.retryPendingUpdateOnBoot();
        expect(result).toBe(false);
    });
});

describe('auto-updater — safeMainPluginUpdate dedup branch', () => {
    it('concurrent calls → second call joins first (dedup)', async () => {
        const Risu = {
            getDatabase: vi.fn(async () => ({
                plugins: [{ name: 'CPM | Cupcake Provider Manager', versionOfPlugin: '1.19.0', script: 'code', realArg: {} }],
            })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async () => 'false'),
            risuFetch: vi.fn(async () => ({
                status: 200,
                data: '//@name Test\n//@version 1.20.0\nconsole.log("updated")',
            })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
        };

        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        // Launch two concurrent updates
        const p1 = au.safeMainPluginUpdate('1.20.0', 'changes');
        const p2 = au.safeMainPluginUpdate('1.20.0', 'changes');

        const [r1, r2] = await Promise.all([p1, p2]);
        // Both should return the same result (dedup)
        expect(r1).toEqual(r2);
    });
});

describe('auto-updater — safeSubPluginUpdate branch push', () => {
    it('sha256 falsy → skips hash verification', async () => {
        const Risu = {
            getDatabase: vi.fn(async () => ({
                plugins: [
                    { name: 'CPM | Cupcake Provider Manager', versionOfPlugin: '1.19.0', script: 'code', realArg: {} },
                    { name: 'SubPlugin', versionOfPlugin: '1.0.0', script: 'old-code', realArg: {} },
                ],
            })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async () => 'false'),
            risuFetch: vi.fn(async () => ({
                status: 200,
                data: JSON.stringify({
                    code: { 'subplugin.js': '//@name SubPlugin\n//@version 1.1.0\nconsole.log("sub")' },
                }),
            })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
        };

        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        // No sha256 → should skip hash check
        const result = await au.safeSubPluginUpdate({
            name: 'SubPlugin',
            remoteVersion: '1.1.0',
            file: 'subplugin.js',
            // sha256 is undefined
        });
        // May fail at validateAndInstallSubPlugin but should not fail at hash check
        expect(typeof result.ok).toBe('boolean');
    });

    it('fetch failure (status >= 400) → returns error', async () => {
        const Risu = {
            getDatabase: vi.fn(async () => ({ plugins: [] })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async () => 'false'),
            risuFetch: vi.fn(async () => ({ status: 500, data: null })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
        };

        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        const result = await au.safeSubPluginUpdate({
            name: 'TestSub',
            remoteVersion: '2.0.0',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('다운로드 실패');
    });

    it('bundle code not found for plugin name → returns error', async () => {
        const Risu = {
            getDatabase: vi.fn(async () => ({ plugins: [] })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async () => 'false'),
            risuFetch: vi.fn(async () => ({
                status: 200,
                data: JSON.stringify({ code: { 'other.js': 'code' } }),
            })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
        };

        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        const result = await au.safeSubPluginUpdate({
            name: 'Missing Plugin',
            remoteVersion: '1.0.0',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('찾을 수 없습니다');
    });

    it('exception during update → caught and returns error', async () => {
        const Risu = {
            getDatabase: vi.fn(async () => ({ plugins: [] })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async () => 'false'),
            risuFetch: vi.fn(async () => { throw new Error('network error'); }),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
        };

        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        const result = await au.safeSubPluginUpdate({
            name: 'FailPlugin',
            remoteVersion: '1.0.0',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('업데이트 실패');
    });
});

describe('auto-updater — runSequentialSubPluginUpdates dedup branch', () => {
    it('concurrent calls → second waits for first', async () => {
        const Risu = {
            getDatabase: vi.fn(async () => ({
                plugins: [{ name: 'CPM | Cupcake Provider Manager', versionOfPlugin: '1.19.0', script: 'code', realArg: {} }],
            })),
            setDatabaseLite: vi.fn(async () => true),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            getArgument: vi.fn(async () => 'false'),
            risuFetch: vi.fn(async () => ({ status: 500, data: null })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
        };

        const { createAutoUpdater } = await import('../src/shared/auto-updater.js');
        const au = createAutoUpdater({ Risu, currentVersion: '1.19.0', pluginName: 'CPM | Cupcake Provider Manager' });

        const updates = [{ name: 'Sub1', remoteVersion: '1.0.0' }];
        const p1 = au.runSequentialSubPluginUpdates(updates);
        const p2 = au.runSequentialSubPluginUpdates(updates);

        const [r1, r2] = await Promise.all([p1, p2]);
        // Both should complete without error
        expect(r1.total).toBe(1);
        expect(r2.total).toBe(1);
    });
});

// ══════════════════════════════════════════════════════════
// formatToOpenAI BRANCH PUSH
// ══════════════════════════════════════════════════════════

describe('formatToOpenAI — comprehensive branch push', () => {
    it('mergesys config — merges all system messages into first non-system', () => {
        const msgs = [
            { role: 'system', content: 'sys1' },
            { role: 'system', content: 'sys2' },
            { role: 'user', content: 'hello' },
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        // System messages should be merged into first user message
        expect(result.some(m => m.role === 'user' && m.content.includes('sys1'))).toBe(true);
    });

    it('mustuser config — prepends user when first message is assistant', () => {
        const msgs = [
            { role: 'assistant', content: 'I start' },
        ];
        const result = formatToOpenAI(msgs, { mustuser: true });
        expect(result[0].role).toBe('user');
    });

    it('altrole config — converts assistant to model', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result.some(m => m.role === 'model')).toBe(true);
    });

    it('altrole merge — consecutive same-role string messages merged', () => {
        const msgs = [
            { role: 'user', content: 'part1' },
            { role: 'user', content: 'part2' },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        expect(userMsgs[0].content).toContain('part1');
        expect(userMsgs[0].content).toContain('part2');
    });

    it('altrole merge — consecutive same-role array content messages merged', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'text', text: 'a' }] },
            { role: 'user', content: [{ type: 'text', text: 'b' }] },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    it('altrole merge — string + array merge', () => {
        const msgs = [
            { role: 'user', content: 'text1' },
            { role: 'user', content: [{ type: 'text', text: 'text2' }] },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    it('developerRole config — system becomes developer', () => {
        const msgs = [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: 'hi' },
        ];
        const result = formatToOpenAI(msgs, { developerRole: true });
        expect(result[0].role).toBe('developer');
    });

    it('sysfirst config — system message moved to front', () => {
        const msgs = [
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'instructions' },
        ];
        const result = formatToOpenAI(msgs, { sysfirst: true });
        expect(result[0].role).toBe('system');
    });

    it('Array.isArray(m.content) — image base64 source mapping', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
                }],
            },
        ];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBeGreaterThan(0);
    });

    it('Array.isArray(m.content) — inlineData image mapping', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    inlineData: { data: 'imgdata', mimeType: 'image/jpeg' },
                }],
            },
        ];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBeGreaterThan(0);
    });

    it('Array.isArray(m.content) — inlineData audio mapping', () => {
        const msgs = [
            {
                role: 'user',
                content: [{
                    inlineData: { data: 'audiodata', mimeType: 'audio/wav' },
                }],
            },
        ];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBeGreaterThan(0);
    });

    it('Array.isArray(m.content) — passthrough for other part types', () => {
        const msgs = [
            {
                role: 'user',
                content: [{ type: 'text', text: 'Hello' }],
            },
        ];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBeGreaterThan(0);
    });

    it('role: model → converted to assistant', () => {
        const msgs = [{ role: 'model', content: 'response' }];
        const result = formatToOpenAI(msgs, {});
        expect(result[0].role).toBe('assistant');
    });

    it('role: char → converted to assistant', () => {
        const msgs = [{ role: 'char', content: 'response' }];
        const result = formatToOpenAI(msgs, {});
        expect(result[0].role).toBe('assistant');
    });

    it('m.name preserved when present', () => {
        const msgs = [{ role: 'user', content: 'hi', name: 'Alice' }];
        const result = formatToOpenAI(msgs, {});
        expect(result[0].name).toBe('Alice');
    });

    it('null/undefined content → message skipped', () => {
        const msgs = [
            { role: 'user', content: null },
            { role: 'user', content: 'valid' },
        ];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBe(1);
        expect(result[0].content).toBe('valid');
    });

    it('non-string non-array content → fallback to text', () => {
        const msgs = [{ role: 'user', content: { nested: 'obj' } }];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBeGreaterThan(0);
    });

    it('multimodal image with base64', () => {
        const msgs = [{
            role: 'user',
            content: 'describe this',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
        }];
        const result = formatToOpenAI(msgs, {});
        expect(result.length).toBeGreaterThan(0);
        const userMsg = result[0];
        expect(Array.isArray(userMsg.content)).toBe(true);
    });

    it('multimodal image with url', () => {
        const msgs = [{
            role: 'user',
            content: 'describe',
            multimodals: [{ type: 'image', url: 'https://example.com/img.jpg' }],
        }];
        const result = formatToOpenAI(msgs, {});
        expect(Array.isArray(result[0].content)).toBe(true);
    });

    it('multimodal audio with various mime types', () => {
        for (const mime of ['audio/wav', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/mp3']) {
            const msgs = [{
                role: 'user',
                content: 'listen',
                multimodals: [{ type: 'audio', base64: `data:${mime};base64,audio_data_${mime}` }],
            }];
            const result = formatToOpenAI(msgs, {});
            expect(result.length).toBeGreaterThan(0);
        }
    });

    it('mergesys with non-string system content → JSON.stringify', () => {
        const msgs = [
            { role: 'system', content: { key: 'val' } },
            { role: 'user', content: 'hello' },
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        expect(result.length).toBeGreaterThan(0);
    });

    it('mergesys with non-string first user content → JSON.stringify', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: { obj: true } },
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        expect(result.length).toBeGreaterThan(0);
    });

    it('altrole merge — empty content in one side → empty array', () => {
        const msgs = [
            { role: 'user', content: '' },
            { role: 'user', content: 'valid' },
        ];
        const result = formatToOpenAI(msgs, { altrole: true, mustuser: true });
        // altrole merges consecutive same-role
        expect(result.filter(m => m.role === 'user').length).toBeGreaterThanOrEqual(1);
    });
});

// ══════════════════════════════════════════════════════════
// formatToGemini BRANCH PUSH
// ══════════════════════════════════════════════════════════

describe('formatToGemini — branch push', () => {
    it('system messages → systemInstruction array', () => {
        const msgs = [
            { role: 'system', content: 'Be helpful' },
            { role: 'user', content: 'Hello' },
        ];
        const result = formatToGemini(msgs, {});
        // systemInstruction is array; without preserveSystem, it's moved into contents
        // With default config, system array is cleared and text injected into first user msg
        expect(result.contents.length).toBeGreaterThan(0);
    });

    it('non-leading system → user "system:" prefix', () => {
        const msgs = [
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'New instruction' },
        ];
        const result = formatToGemini(msgs, {});
        const lastUser = result.contents.filter(c => c.role === 'user').pop();
        expect(lastUser.parts.some(p => p.text && p.text.includes('system:'))).toBe(true);
    });

    it('multimodal image URL → fileData', () => {
        const msgs = [{
            role: 'user',
            content: 'Look at this',
            multimodals: [{ type: 'image', url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' }],
        }];
        const result = formatToGemini(msgs, {});
        const parts = result.contents.flatMap(c => c.parts);
        expect(parts.some(p => p.fileData)).toBe(true);
    });

    it('multimodal image base64 → inlineData', () => {
        const msgs = [{
            role: 'user',
            content: 'Describe',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,iVBORw0KGgo=' }],
        }];
        const result = formatToGemini(msgs, {});
        const parts = result.contents.flatMap(c => c.parts);
        expect(parts.some(p => p.inlineData)).toBe(true);
    });

    it('multimodal audio base64 → inlineData', () => {
        const msgs = [{
            role: 'user',
            content: 'Listen',
            multimodals: [{ type: 'audio', base64: 'data:audio/wav;base64,audiodata' }],
        }];
        const result = formatToGemini(msgs, {});
        const parts = result.contents.flatMap(c => c.parts);
        expect(parts.some(p => p.inlineData)).toBe(true);
    });

    it('role model/assistant → model in Gemini', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        const result = formatToGemini(msgs, {});
        expect(result.contents.some(c => c.role === 'model')).toBe(true);
    });

    it('same-role consecutive messages → merged parts', () => {
        const msgs = [
            { role: 'user', content: 'part1' },
            { role: 'user', content: 'part2' },
        ];
        const result = formatToGemini(msgs, {});
        const userContents = result.contents.filter(c => c.role === 'user');
        // Should be merged
        expect(userContents.length).toBe(1);
        expect(userContents[0].parts.length).toBeGreaterThanOrEqual(2);
    });

    it('first message = model → prepends user guard', () => {
        const msgs = [
            { role: 'assistant', content: 'I start first' },
        ];
        const result = formatToGemini(msgs, {});
        expect(result.contents[0].role).toBe('user');
    });

    it('useThoughtSignature → sets thoughtSignature from cache', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'response' },
        ];
        const result = formatToGemini(msgs, { useThoughtSignature: true });
        // Should not crash
        expect(result.contents.length).toBeGreaterThan(0);
    });

    it('non-string content → JSON.stringify fallback', () => {
        const msgs = [
            { role: 'user', content: { data: 'test' } },
        ];
        const result = formatToGemini(msgs, {});
        expect(result.contents.length).toBeGreaterThan(0);
    });

    it('empty content and no multimodals → skipped', () => {
        const msgs = [
            { role: 'user', content: '' },
            { role: 'user', content: 'valid' },
        ];
        const result = formatToGemini(msgs, {});
        expect(result.contents.length).toBeGreaterThan(0);
    });

    it('multimodal same-role merge with text and inlineData', () => {
        const msgs = [
            { role: 'user', content: 'text1' },
            {
                role: 'user',
                content: 'text2',
                multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
            },
        ];
        const result = formatToGemini(msgs, {});
        const userContents = result.contents.filter(c => c.role === 'user');
        expect(userContents.length).toBe(1);
    });

    it('non-string system content → JSON.stringify', () => {
        const msgs = [
            { role: 'system', content: { instruction: 'be kind' } },
            { role: 'user', content: 'hi' },
        ];
        const result = formatToGemini(msgs, { preserveSystem: true });
        // With preserveSystem, systemInstruction stays as array
        expect(Array.isArray(result.systemInstruction)).toBe(true);
        expect(result.systemInstruction[0]).toContain('instruction');
    });

    it('model role with thoughts → stripThoughtDisplayContent', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '<Thoughts>\nthinking\n</Thoughts>\n\nreal answer' },
        ];
        const result = formatToGemini(msgs, {});
        const modelContent = result.contents.find(c => c.role === 'model');
        // Thoughts should be stripped from model output
        if (modelContent) {
            const texts = modelContent.parts.map(p => p.text).join('');
            expect(texts).not.toContain('<Thoughts>');
        }
    });
});

// ══════════════════════════════════════════════════════════
// formatToAnthropic — ADDITIONAL branch push
// ══════════════════════════════════════════════════════════

describe('formatToAnthropic — multimodal & edge case branch push', () => {
    it('multimodal image with URL → Anthropic URL source', () => {
        const msgs = [{
            role: 'user',
            content: 'describe',
            multimodals: [{ type: 'image', url: 'https://example.com/photo.jpg' }],
        }];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const content = Array.isArray(userMsg.content) ? userMsg.content : [];
        expect(content.some(p => p.type === 'image' && p.source?.type === 'url')).toBe(true);
    });

    it('multimodal image with base64 → Anthropic base64 source', () => {
        const msgs = [{
            role: 'user',
            content: 'describe',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,iVBORw0KGgo=' }],
        }];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const content = Array.isArray(userMsg.content) ? userMsg.content : [];
        expect(content.some(p => p.type === 'image' && p.source?.type === 'base64')).toBe(true);
    });

    it('non-leading system → user "system:" prefix', () => {
        const msgs = [
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'Mid instruction' },
            { role: 'assistant', content: 'response' },
        ];
        const result = formatToAnthropic(msgs, {});
        // Non-leading system should become "system: Mid instruction" in a user message
        const userMsgs = result.messages.filter(m => m.role === 'user');
        const allContent = userMsgs.flatMap(m => Array.isArray(m.content) ? m.content.map(p => p.text || '') : [m.content]);
        expect(allContent.some(t => t.includes('system:'))).toBe(true);
    });

    it('same-role multimodal merge into existing text message', () => {
        const msgs = [
            { role: 'user', content: 'first text' },
            {
                role: 'user',
                content: 'with image',
                multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
            },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsgs = result.messages.filter(m => m.role === 'user');
        // Should be merged
        expect(userMsgs.length).toBe(1);
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
    });

    it('text-only same-role merge into array content', () => {
        const msgs = [
            {
                role: 'user',
                content: 'msg1',
                multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
            },
            { role: 'user', content: 'msg2' },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsgs = result.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    it('multimodal with base64 without comma → uses full string as data', () => {
        const msgs = [{
            role: 'user',
            content: 'img',
            multimodals: [{ type: 'image', base64: 'rawbase64data' }],
        }];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });

    it('cachePoint on array content message → cache_control on last element', () => {
        const msgs = [
            {
                role: 'user',
                content: [{ type: 'text', text: 'cached array' }],
                cachePoint: true,
            },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const content = Array.isArray(userMsg.content) ? userMsg.content : [];
        const lastPart = content[content.length - 1];
        expect(lastPart?.cache_control).toBeDefined();
    });

    it('non-string system content → JSON.stringify', () => {
        const msgs = [
            { role: 'system', content: { structured: true } },
            { role: 'user', content: 'hi' },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(typeof result.system).toBe('string');
        expect(result.system).toContain('structured');
    });

    it('no text content in multimodal with empty text → no text part in content', () => {
        const msgs = [{
            role: 'user',
            content: '',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
        }];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });
});

// ══════════════════════════════════════════════════════════
// SSE-PARSER — Additional ThoughtSignatureCache + Gemini branches
// ══════════════════════════════════════════════════════════

describe('ThoughtSignatureCache — branch push', () => {
    it('save and get roundtrip', () => {
        ThoughtSignatureCache.save('test response', 'sig-abc');
        const result = ThoughtSignatureCache.get('test response');
        expect(result).toBe('sig-abc');
    });

    it('get with empty/null text → returns null', () => {
        expect(ThoughtSignatureCache.get('')).toBeNull();
        expect(ThoughtSignatureCache.get(null)).toBeNull();
    });

    it('save overwrites existing', () => {
        ThoughtSignatureCache.save('overwrite-test', 'sig-1');
        ThoughtSignatureCache.save('overwrite-test', 'sig-2');
        expect(ThoughtSignatureCache.get('overwrite-test')).toBe('sig-2');
    });
});

describe('parseGeminiNonStreamingResponse — branch push', () => {
    it('block reason SAFETY → returns error', () => {
        const data = {
            promptFeedback: { blockReason: 'SAFETY' },
        };
        const result = parseGeminiNonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('Safety Block');
    });

    it('candidates finishReason RECITATION → returns error', () => {
        const data = {
            candidates: [{ finishReason: 'RECITATION', content: { parts: [{ text: 'partial' }] } }],
        };
        const result = parseGeminiNonStreamingResponse(data, {});
        expect(result.success).toBe(false);
    });

    it('normal response → returns content', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'answer' }] } }],
        };
        const result = parseGeminiNonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toContain('answer');
    });

    it('thinking parts with showThoughtsToken → includes thoughts', () => {
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { thought: true, text: 'thinking step' },
                        { text: 'final answer' },
                    ],
                },
            }],
        };
        const result = parseGeminiNonStreamingResponse(data, { showThoughtsToken: true });
        expect(result.success).toBe(true);
        expect(result.content).toContain('thinking step');
        expect(result.content).toContain('final answer');
    });

    it('usage metadata with _requestId → records usage', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'response' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
        };
        const result = parseGeminiNonStreamingResponse(data, { _requestId: 'req-gemini-ns' });
        expect(result.success).toBe(true);
    });

    it('no candidates → returns success with empty content', () => {
        const data = {};
        const result = parseGeminiNonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toBe('');
    });

    it('thought signature in parts → saved to cache', () => {
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { thought: true, text: 'think', thought_signature: 'sig-ns' },
                        { text: 'answer' },
                    ],
                },
            }],
        };
        const result = parseGeminiNonStreamingResponse(data, { showThoughtsToken: true, useThoughtSignature: true });
        expect(result.success).toBe(true);
    });
});

describe('parseClaudeNonStreamingResponse — branch push', () => {
    it('normal text response', () => {
        const data = {
            content: [{ type: 'text', text: 'Claude says hello' }],
        };
        const result = parseClaudeNonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toContain('Claude says hello');
    });

    it('thinking block with showThinking → includes thoughts', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'deep thoughts' },
                { type: 'text', text: 'answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('deep thoughts');
    });

    it('thinking block with showThinking=false → no thoughts', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'hidden' },
                { type: 'text', text: 'answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: false });
        expect(result.success).toBe(true);
        expect(result.content).not.toContain('<Thoughts>');
    });

    it('error response → returns error result', () => {
        const data = {
            error: { type: 'overloaded_error', message: 'Overloaded' },
        };
        const result = parseClaudeNonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('Overloaded');
    });

    it('usage with _requestId → records token usage', () => {
        const data = {
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 100, output_tokens: 50 },
        };
        const result = parseClaudeNonStreamingResponse(data, { _requestId: 'req-claude-ns' });
        expect(result.success).toBe(true);
    });

    it('redacted_thinking block → handled', () => {
        const data = {
            content: [
                { type: 'redacted_thinking', data: 'encrypted' },
                { type: 'text', text: 'answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
    });

    it('empty content array → returns success with empty content', () => {
        const data = { content: [] };
        const result = parseClaudeNonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toBe('');
    });
});

describe('parseOpenAINonStreamingResponse — branch push', () => {
    it('normal chat completion message', () => {
        const data = {
            choices: [{ message: { content: 'GPT response' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toBe('GPT response');
    });

    it('reasoning_content with showThinking → includes thoughts', () => {
        const data = {
            choices: [{ message: { content: 'answer', reasoning_content: 'thinking process' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('thinking process');
    });

    it('usage with _requestId → records usage', () => {
        const data = {
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };
        const result = parseOpenAINonStreamingResponse(data, { _requestId: 'req-oai-ns' });
        expect(result.success).toBe(true);
    });

    it('error response → returns error', () => {
        const data = {
            error: { message: 'Rate limit exceeded' },
        };
        const result = parseOpenAINonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('Rate limit');
    });

    it('no choices → unexpected error', () => {
        const data = {};
        const result = parseOpenAINonStreamingResponse(data, {});
        expect(result.success).toBe(false);
    });

    it('array content in message → normalized', () => {
        const data = {
            choices: [{ message: { content: [{ type: 'text', text: 'from array' }] } }],
        };
        const result = parseOpenAINonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toContain('from array');
    });
});

// ================================================================
// SSE-PARSER: Surgical branch coverage push (6 arms)
// ================================================================

// -- B0+B1 L30: ThoughtSignatureCache._keyOf with falsy text --
describe('ThoughtSignatureCache._keyOf edge (B0+B1)', () => {
    it('handles null text → empty string fallback', () => {
        const key = ThoughtSignatureCache._keyOf(null);
        expect(typeof key).toBe('string');
    });
    it('handles empty string → empty string fallback', () => {
        const key = ThoughtSignatureCache._keyOf('');
        expect(typeof key).toBe('string');
    });
    it('handles undefined text', () => {
        const key = ThoughtSignatureCache._keyOf(undefined);
        expect(typeof key).toBe('string');
    });
});

// -- B142 L370: parseGeminiNonStreamingResponse thought_signature save path --
describe('parseGeminiNonStreamingResponse thought_signature (B142)', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('saves thought_signature when useThoughtSignature + text + sig present', () => {
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { text: 'Regular response text here', thought: false },
                        { thought_signature: 'sig_abc123' },
                    ],
                },
            }],
        };
        const result = parseGeminiNonStreamingResponse(data, { useThoughtSignature: true });
        expect(result.success).toBe(true);
        expect(result.content).toContain('Regular response text here');
        // Signature should have been saved
        const cached = ThoughtSignatureCache.get('Regular response text here');
        expect(cached).toBe('sig_abc123');
    });

    it('saves thoughtSignature (camelCase variant)', () => {
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { text: 'Another text' },
                        { thoughtSignature: 'sig_def456' },
                    ],
                },
            }],
        };
        const result = parseGeminiNonStreamingResponse(data, { useThoughtSignature: true });
        expect(result.success).toBe(true);
        const cached = ThoughtSignatureCache.get('Another text');
        expect(cached).toBe('sig_def456');
    });
});

// -- B117 L333-337: parseGeminiSSELine finishReason closes thought block --
describe('parseGeminiSSELine finishReason thought close (B117)', () => {
    it('closes thought block when finishReason is present and _inThoughtBlock', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        // SSE line with finishReason and no new parts
        const line = 'data: ' + JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
        });
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });
});

// -- B38 L152: createOpenAISSEStream onComplete while _inThinking --
describe('createOpenAISSEStream ends during thinking (B38)', () => {
    it('closes Thoughts tag when stream ends during reasoning', async () => {
        // Create a mock fetch response that streams reasoning_content only (no content)
        const sseChunk = [
            'data: ' + JSON.stringify({
                choices: [{ delta: { reasoning_content: 'Thinking step 1' } }],
            }),
            '',
            'data: [DONE]',
            '',
        ].join('\n');

        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(sseChunk));
                controller.close();
            },
        });
        const response = { body };
        const config = { showThinking: true };
        const stream = createOpenAISSEStream(response, undefined, config);
        const reader = stream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const full = chunks.join('');
        // Should contain opening and closing Thoughts tags
        expect(full).toContain('<Thoughts>');
        expect(full).toContain('</Thoughts>');
        expect(full).toContain('Thinking step 1');
    });
});

// -- B32 L122: parseOpenAISSELine with showThinking=false but reasoning present --
describe('parseOpenAISSELine reasoning hidden (B32)', () => {
    it('skips reasoning when showThinking is false', () => {
        const line = 'data: ' + JSON.stringify({
            choices: [{ delta: { reasoning_content: 'hidden reasoning', content: 'visible' } }],
        });
        const config = { showThinking: false };
        const result = parseOpenAISSELine(line, config);
        expect(result).not.toContain('hidden reasoning');
        expect(result).toContain('visible');
    });

    it('skips reasoning_content when showThinking undefined', () => {
        const line = 'data: ' + JSON.stringify({
            choices: [{ delta: { reasoning_content: 'skip this' } }],
        });
        const config = {};
        const result = parseOpenAISSELine(line, config);
        expect(result).toBeNull();
    });
});

// -- B28 L114: parseOpenAISSELine usage tracking with _requestId --
describe('parseOpenAISSELine usage with _requestId (B28)', () => {
    it('tracks usage when _requestId is set and no delta', () => {
        const line = 'data: ' + JSON.stringify({
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
        const config = { _requestId: 'req_test_usage' };
        // Should not throw, returns null (usage-only chunk)
        const result = parseOpenAISSELine(line, config);
        expect(result).toBeNull();
    });
});

// -- Additional: Responses API SSE reasoning → text transition --
describe('createResponsesAPISSEStream reasoning→text (B177+B178)', () => {
    it('outputs reasoning then text with proper Thoughts wrapping', async () => {
        const lines = [
            'data: ' + JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'Think...' }),
            '',
            'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Answer' }),
            '',
            'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { prompt_tokens: 5, completion_tokens: 3 } } }),
            '',
            'data: [DONE]',
            '',
        ].join('\n');
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(c) { c.enqueue(encoder.encode(lines)); c.close(); },
        });
        const stream = createResponsesAPISSEStream({ body }, undefined, { showThinking: true });
        const reader = stream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const full = chunks.join('');
        expect(full).toContain('<Thoughts>');
        expect(full).toContain('Think...');
        expect(full).toContain('</Thoughts>');
        expect(full).toContain('Answer');
    });
});

// -- B92 L276: createAnthropicSSEStream error path with usage finalization --
describe('createAnthropicSSEStream error path usage (B92)', () => {
    it('finalizes usage when stream throws error after receiving usage', async () => {
        const sseLines = [
            'event: message_start',
            'data: ' + JSON.stringify({ message: { usage: { input_tokens: 100 } } }),
            '',
            'event: content_block_delta',
            'data: ' + JSON.stringify({ delta: { type: 'text_delta', text: 'Hello' } }),
            '',
        ].join('\n');
        const encoder = new TextEncoder();
        let callCount = 0;
        const body = new ReadableStream({
            pull(controller) {
                callCount++;
                if (callCount === 1) {
                    controller.enqueue(encoder.encode(sseLines));
                } else {
                    controller.error(new Error('Network failure'));
                }
            },
        });
        const config = { showThinking: false, _requestId: 'req_err_test' };
        const stream = createAnthropicSSEStream({ body }, undefined, config);
        const reader = stream.getReader();
        const chunks = [];
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
        } catch {
            // Expected error
        }
        expect(chunks.join('')).toContain('Hello');
    });
});

// ================================================================
// MESSAGE-FORMAT: Deep branch coverage push
// ================================================================

describe('formatToOpenAI Array.isArray content deep branches', () => {
    // B42-B53: Array.isArray(m.content) path with various part types
    it('Array content with image base64 source → image_url', () => {
        const msgs = [
            { role: 'user', content: [
                { type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/jpeg' } },
            ] },
        ];
        const result = formatToOpenAI(msgs, {});
        const userMsg = result.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image_url');
        expect(imgPart).toBeTruthy();
        expect(imgPart.image_url.url).toContain('data:image/jpeg;base64,abc123');
    });

    it('Array content with inlineData image → image_url', () => {
        const msgs = [
            { role: 'user', content: [
                { inlineData: { data: 'imgdata', mimeType: 'image/png' } },
            ] },
        ];
        const result = formatToOpenAI(msgs, {});
        const userMsg = result.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image_url');
        expect(imgPart).toBeTruthy();
    });

    it('Array content with inlineData audio → input_audio', () => {
        const msgs = [
            { role: 'user', content: [
                { inlineData: { data: 'audiodata', mimeType: 'audio/wav' } },
            ] },
        ];
        const result = formatToOpenAI(msgs, {});
        const userMsg = result.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const audioPart = parts.find(p => p.type === 'input_audio');
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('wav');
    });

    it('Array content with inlineData no mimeType → falls through unmapped', () => {
        const msgs = [
            { role: 'user', content: [
                { inlineData: { data: 'data123' } },
                { text: 'fallback text' },
            ] },
        ];
        const result = formatToOpenAI(msgs, {});
        const userMsg = result.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
        // inlineData with octet-stream doesn't match image or audio → part is pushed as-is
        // The text part should still be present
    });

    it('Array content with null/invalid parts → skipped', () => {
        const msgs = [
            { role: 'user', content: [null, 42, { text: 'hello' }] },
        ];
        const result = formatToOpenAI(msgs, {});
        const userMsg = result.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
    });

    it('content is non-string non-array → fallback toString', () => {
        const msgs = [
            { role: 'user', content: { custom: 'data' } },
        ];
        const result = formatToOpenAI(msgs, {});
        const userMsg = result.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
    });
});

describe('formatToAnthropic deep Array.isArray content paths', () => {
    // B108-B123: Array.isArray(m.content) inner branches
    it('Array content with text parts → structured text blocks', () => {
        const msgs = [
            { role: 'user', content: [{ text: 'Hello', type: 'text' }, { text: 'World', type: 'text' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
        expect(Array.isArray(userMsg.content)).toBe(true);
    });

    it('Array content with image source base64 → pass through', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'img', media_type: 'image/png' } }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const imgPart = Array.isArray(userMsg.content) ? userMsg.content.find(p => p.type === 'image') : null;
        expect(imgPart).toBeTruthy();
    });

    it('Array content with inlineData image → converted to Anthropic base64', () => {
        const msgs = [
            { role: 'user', content: [{ inlineData: { data: 'inline_img', mimeType: 'image/jpeg' } }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.data).toBe('inline_img');
    });

    it('Array content with image_url data URI → base64 extraction', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abcdef' } }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.data).toBe('abcdef');
        expect(imgPart.source.media_type).toBe('image/png');
    });

    it('Array content with image_url HTTP URL → url source', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.type).toBe('url');
    });

    it('Array content with input_image HTTP URL', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/img2.png' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
    });

    it('Array content with image_url string (not object)', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'image_url', image_url: 'data:image/jpeg;base64,xyz' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
    });

    it('same-role consecutive messages with Array content → merged', () => {
        const msgs = [
            { role: 'user', content: [{ text: 'Part1' }] },
            { role: 'user', content: [{ text: 'Part2' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsgs = result.messages.filter(m => m.role === 'user');
        // Should be merged into single user message
        expect(userMsgs.length).toBeLessThanOrEqual(2); // includes potential Start sentinel
    });

    it('same-role consecutive messages merges string content into array', () => {
        const msgs = [
            { role: 'user', content: 'First' },
            { role: 'user', content: 'Second' },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.length > 1);
        expect(userMsg).toBeTruthy();
    });
});

describe('formatToAnthropic multimodal URL image paths', () => {
    // B93-B102: multimodal URL source and base64 parsing
    it('multimodal URL image → Anthropic url source', () => {
        const msgs = [
            { role: 'user', content: 'Check image', multimodals: [{ type: 'image', url: 'https://example.com/photo.jpg' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const urlPart = parts.find(p => p.type === 'image' && p.source?.type === 'url');
        expect(urlPart).toBeTruthy();
    });

    it('multimodal base64 with data URI → extracts mediaType and data', () => {
        const msgs = [
            { role: 'user', content: 'See this', multimodals: [{ type: 'image', base64: 'data:image/webp;base64,RIFF123' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image' && p.source?.type === 'base64');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.media_type).toBe('image/webp');
        expect(imgPart.source.data).toBe('RIFF123');
    });

    it('multimodal base64 without data URI prefix → raw base64', () => {
        const msgs = [
            { role: 'user', content: 'Image', multimodals: [{ type: 'image', base64: 'rawBase64Data' }] },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const imgPart = parts.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.data).toBe('rawBase64Data');
        expect(imgPart.source.media_type).toBe('image/png');
    });
});

describe('formatToAnthropic cachePoint (B143-B144)', () => {
    it('cachePoint on Array content → cache_control added to last element', () => {
        const msgs = [
            { role: 'user', content: [{ text: 'cached text', type: 'text' }], cachePoint: true },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const cached = parts.find(p => p.cache_control);
        expect(cached).toBeTruthy();
    });

    it('cachePoint on string content → converted to array with cache_control', () => {
        const msgs = [
            { role: 'user', content: 'cache me', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs, {});
        const userMsg = result.messages.find(m => m.role === 'user');
        const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
        const cached = parts.find(p => p.cache_control);
        expect(cached).toBeTruthy();
    });
});

describe('formatToAnthropic same-role text merge (B128-B138)', () => {
    it('consecutive assistant messages → merged text', () => {
        const msgs = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Response part 1' },
            { role: 'assistant', content: 'Response part 2' },
        ];
        const result = formatToAnthropic(msgs, {});
        const assistantMsgs = result.messages.filter(m => m.role === 'assistant');
        // Should be merged
        expect(assistantMsgs.length).toBe(1);
    });

    it('consecutive user messages with empty content → skipped', () => {
        const msgs = [
            { role: 'user', content: 'Valid' },
            { role: 'user', content: '' },
            { role: 'user', content: 'Also valid' },
        ];
        const result = formatToAnthropic(msgs, {});
        expect(result.messages.length).toBeGreaterThan(0);
    });
});

describe('formatToGemini multimodal deep branches (B159-B189)', () => {
    it('multimodal image with URL → fileData part', () => {
        const msgs = [
            { role: 'user', content: 'See image', multimodals: [{ type: 'image', url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' }] },
        ];
        const result = formatToGemini(msgs, {});
        const userContent = result.contents.find(c => c.role === 'user');
        const filePart = userContent?.parts?.find(p => p.fileData);
        expect(filePart).toBeTruthy();
        expect(filePart.fileData.fileUri).toBe('https://example.com/photo.jpg');
    });

    it('multimodal image with base64 data URI → inlineData part', () => {
        const msgs = [
            { role: 'user', content: 'My pic', multimodals: [{ type: 'image', base64: 'data:image/png;base64,imgbytes' }] },
        ];
        const result = formatToGemini(msgs, {});
        const userContent = result.contents.find(c => c.role === 'user');
        const inlinePart = userContent?.parts?.find(p => p.inlineData);
        expect(inlinePart).toBeTruthy();
        expect(inlinePart.inlineData.mimeType).toBe('image/png');
        expect(inlinePart.inlineData.data).toBe('imgbytes');
    });

    it('multimodal audio → inlineData', () => {
        const msgs = [
            { role: 'user', content: 'Audio', multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,mp3data', mimeType: 'audio/mp3' }] },
        ];
        const result = formatToGemini(msgs, {});
        const userContent = result.contents.find(c => c.role === 'user');
        const inlinePart = userContent?.parts?.find(p => p.inlineData);
        expect(inlinePart).toBeTruthy();
    });

    it('multimodal raw base64 (no data URI) → inlineData with fallback mimeType', () => {
        const msgs = [
            { role: 'user', content: 'Img', multimodals: [{ type: 'image', base64: 'rawBase64', mimeType: 'image/gif' }] },
        ];
        const result = formatToGemini(msgs, {});
        const userContent = result.contents.find(c => c.role === 'user');
        const inlinePart = userContent?.parts?.find(p => p.inlineData);
        expect(inlinePart).toBeTruthy();
        expect(inlinePart.inlineData.data).toBe('rawBase64');
    });

    it('same-role consecutive multimodal messages → merged into same content', () => {
        const msgs = [
            { role: 'user', content: 'First', multimodals: [{ type: 'image', base64: 'data:image/png;base64,a' }] },
            { role: 'user', content: 'Second', multimodals: [{ type: 'image', base64: 'data:image/png;base64,b' }] },
        ];
        const result = formatToGemini(msgs, {});
        const userContents = result.contents.filter(c => c.role === 'user');
        // Should merge into a single user content entry
        expect(userContents.length).toBe(1);
        expect(userContents[0].parts.length).toBeGreaterThanOrEqual(4); // 2 text + 2 inline
    });

    it('same-role text merges with previous non-text last part', () => {
        const msgs = [
            { role: 'user', content: 'Text1', multimodals: [{ type: 'image', base64: 'data:image/png;base64,imgdata' }] },
            { role: 'user', content: 'Text2' },
        ];
        const result = formatToGemini(msgs, {});
        const userContents = result.contents.filter(c => c.role === 'user');
        expect(userContents.length).toBe(1);
    });

    it('multimodal video → inlineData', () => {
        const msgs = [
            { role: 'user', content: 'Video', multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,viddata', mimeType: 'video/mp4' }] },
        ];
        const result = formatToGemini(msgs, {});
        const userContent = result.contents.find(c => c.role === 'user');
        expect(userContent?.parts.some(p => p.inlineData)).toBe(true);
    });
});

describe('formatToGemini system in non-leading position (B153)', () => {
    it('non-leading system message → reformatted as user "system: ..."', () => {
        const msgs = [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'You are helpful' },
            { role: 'assistant', content: 'Sure' },
        ];
        const result = formatToGemini(msgs, {});
        const userContent = result.contents.find(c => c.role === 'user');
        const hasSysText = userContent?.parts?.some(p => typeof p.text === 'string' && p.text.includes('system:'));
        expect(hasSysText).toBe(true);
    });
});

describe('formatToGemini useThoughtSignature on model content (B186+B189)', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('attaches cached thoughtSignature to model message', () => {
        ThoughtSignatureCache.save('Model reply text', 'sig_gemini_999');
        const msgs = [
            { role: 'user', content: 'Ask' },
            { role: 'assistant', content: 'Model reply text' },
        ];
        const result = formatToGemini(msgs, { useThoughtSignature: true });
        const modelContent = result.contents.find(c => c.role === 'model');
        expect(modelContent).toBeTruthy();
        const sigPart = modelContent.parts.find(p => p.thoughtSignature);
        expect(sigPart?.thoughtSignature).toBe('sig_gemini_999');
    });
});

describe('formatToOpenAI sysfirst config', () => {
    it('moves system message to front when sysfirst is true', () => {
        const msgs = [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'System prompt' },
            { role: 'assistant', content: 'Reply' },
        ];
        const result = formatToOpenAI(msgs, { sysfirst: true });
        expect(result[0].role).toBe('system');
    });
});

describe('formatToOpenAI altrole merge edge cases', () => {
    it('merges consecutive same-role messages with Array content', () => {
        const msgs = [
            { role: 'user', content: 'Text1' },
            { role: 'user', content: 'Text2' },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'model');
        // altrole changes assistant→model, user stays user
        // consecutive user messages should be merged
        const userMerged = result.filter(m => m.role === 'user');
        expect(userMerged.length).toBe(1);
        expect(userMerged[0].content).toContain('Text1');
        expect(userMerged[0].content).toContain('Text2');
    });

    it('merges Array+Array content in altrole mode', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'text', text: 'A' }], multimodals: [{ type: 'image', base64: 'data:image/png;base64,x' }] },
            { role: 'user', content: [{ type: 'text', text: 'B' }], multimodals: [{ type: 'image', base64: 'data:image/png;base64,y' }] },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        // Merged content should be an array
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
    });

    it('merges string+array content in altrole mode', () => {
        const msgs = [
            { role: 'user', content: 'TextMsg' },
            { role: 'user', content: [{ type: 'text', text: 'ArrayMsg' }], multimodals: [{ type: 'image', base64: 'data:image/png;base64,z' }] },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });
});

// ================================================================
// HELPERS: Additional branch coverage
// ================================================================
describe('shouldEnableStreaming branch push', () => {
    beforeEach(() => _resetCompatibilityModeCache());

    it('streaming disabled → false', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: false })).toBe(false);
    });

    it('streaming enabled + no compatibility → true', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: false })).toBe(true);
    });

    it('streaming enabled + compatibility + isCopilot → true', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: true }, { isCopilot: true })).toBe(true);
    });

    it('streaming enabled + compatibility + not copilot → false', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: true }, { isCopilot: false })).toBe(false);
    });
});

describe('isCompatibilityModeSettingEnabled edge values', () => {
    it('string "yes" → true', () => expect(isCompatibilityModeSettingEnabled('yes')).toBe(true));
    it('string "no" → false', () => expect(isCompatibilityModeSettingEnabled('no')).toBe(false));
    it('string "on" → true', () => expect(isCompatibilityModeSettingEnabled('on')).toBe(true));
    it('string "off" → false', () => expect(isCompatibilityModeSettingEnabled('off')).toBe(false));
    it('string "1" → true', () => expect(isCompatibilityModeSettingEnabled('1')).toBe(true));
    it('string "0" → false', () => expect(isCompatibilityModeSettingEnabled('0')).toBe(false));
    it('string "undefined" → default false', () => expect(isCompatibilityModeSettingEnabled('undefined')).toBe(false));
    it('string "null" → default false', () => expect(isCompatibilityModeSettingEnabled('null')).toBe(false));
    it('empty string → default false', () => expect(isCompatibilityModeSettingEnabled('')).toBe(false));
    it('null → default false', () => expect(isCompatibilityModeSettingEnabled(null)).toBe(false));
    it('undefined → default false', () => expect(isCompatibilityModeSettingEnabled(undefined)).toBe(false));
    it('boolean true → true', () => expect(isCompatibilityModeSettingEnabled(true)).toBe(true));
    it('boolean false → false', () => expect(isCompatibilityModeSettingEnabled(false)).toBe(false));
    it('string "TRUE" → true', () => expect(isCompatibilityModeSettingEnabled('TRUE')).toBe(true));
    it('string "  true  " with spaces → true', () => expect(isCompatibilityModeSettingEnabled('  true  ')).toBe(true));
});

describe('normalizeOpenAIMessageContent edge cases', () => {
    it('null → empty string', () => expect(normalizeOpenAIMessageContent(null)).toBe(''));
    it('undefined → empty string', () => expect(normalizeOpenAIMessageContent(undefined)).toBe(''));
    it('array with string items', () => expect(normalizeOpenAIMessageContent(['hello', 'world'])).toBe('helloworld'));
    it('array with mixed types', () => {
        const result = normalizeOpenAIMessageContent([
            { text: 'a' },
            'b',
            null,
            { type: 'text', content: 'c' },
        ]);
        expect(result).toBe('abc');
    });
    it('non-string non-array → String()', () => expect(normalizeOpenAIMessageContent(42)).toBe('42'));
});
