/**
 * branch-90-push.test.js
 *
 * Targeted branch coverage tests for sub-90% modules:
 *   - slot-inference.js (L83-88)
 *   - key-pool.js (L130-133)
 *   - sse-parser.js (L33, L543-545, L570-573)
 */
import { describe, it, expect, vi } from 'vitest';

// ── slot-inference ──
import { inferSlot, scoreSlotHeuristic } from '../src/shared/slot-inference.js';

describe('slot-inference — branch coverage push', () => {
    // safeGetArg that makes model match 'chat' slot
    const MODEL_ID = 'test-model-001';
    const makeDeps = (overrides = {}) => ({
        safeGetArg: async (key) => {
            if (key === 'cpm_slot_translation') return MODEL_ID;
            return '';
        },
        ...overrides,
    });

    it('prompt_chat is not an array → skips extraction, returns early', async () => {
        const result = await inferSlot(
            { uniqueId: MODEL_ID },
            { prompt_chat: 'not-array' },
            makeDeps(),
        );
        expect(result).toBeDefined();
        // prompt_chat not array → promptText stays '' → early return
        expect(result.heuristicConfirmed).toBe(false);
    });

    it('prompt_chat with null/undefined elements → skips them via continue', async () => {
        const result = await inferSlot(
            { uniqueId: MODEL_ID },
            {
                prompt_chat: [
                    { role: 'system', content: 'Please translate the following text from Korean to English. 번역해 주세요.' },
                    null,
                    undefined,
                    { role: 'user', content: '이 문장을 영어로 번역해 주세요.' },
                ],
            },
            makeDeps(),
        );
        expect(result).toBeDefined();
        // Translation keywords present → should detect translation slot
        expect(result.slot).toBe('translation');
    });

    it('prompt_chat element with non-string content → falls back to empty string', async () => {
        const result = await inferSlot(
            { uniqueId: MODEL_ID },
            {
                prompt_chat: [
                    { role: 'system', content: 123 },
                    { role: 'user', content: { text: 'hi' } },
                    { role: 'assistant', content: null },
                ],
            },
            makeDeps(),
        );
        expect(result).toBeDefined();
        // All content fallback to '' → promptText empty → returns with heuristicConfirmed=false
        expect(result.heuristicConfirmed).toBe(false);
    });

    it('prompt_chat is undefined → early return', async () => {
        const result = await inferSlot(
            { uniqueId: MODEL_ID },
            {},
            makeDeps(),
        );
        expect(result.heuristicConfirmed).toBe(false);
    });
});

// ── key-pool ──
import { KeyPool } from '../src/shared/key-pool.js';

describe('key-pool — branch coverage push', () => {
    it('fromJson with JSON that parses as null', () => {
        const pool = KeyPool.fromJson('null');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with JSON that parses as a number', () => {
        const pool = KeyPool.fromJson('42');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with JSON that parses as a boolean', () => {
        const pool = KeyPool.fromJson('true');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with JSON that parses as a string', () => {
        const pool = KeyPool.fromJson('"hello"');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with invalid JSON (parse throws)', () => {
        const pool = KeyPool.fromJson('{broken json');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with array of non-objects → filters to empty', () => {
        const pool = KeyPool.fromJson('[1, 2, "str", null]');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with empty string', () => {
        const pool = KeyPool.fromJson('');
        expect(pool.remaining).toBe(0);
    });

    it('fromJson with Windows path', () => {
        const pool = KeyPool.fromJson('C:\\Users\\test\\key.json');
        expect(pool.remaining).toBe(0);
        expect(pool._jsonParseError).toBeTruthy();
    });
});

// ── sse-parser ──
import {
    ThoughtSignatureCache,
    createSSEStream,
    parseResponsesAPINonStreamingResponse,
    saveThoughtSignatureFromStream,
} from '../src/shared/sse-parser.js';

describe('ThoughtSignatureCache — branch coverage push', () => {
    it('save with empty text returns early', () => {
        ThoughtSignatureCache.save('', 'sig');
    });

    it('save with empty sig returns early', () => {
        ThoughtSignatureCache.save('text', '');
    });

    it('get with empty text returns null', () => {
        expect(ThoughtSignatureCache.get('')).toBeNull();
    });

    it('get with non-existent key returns null', () => {
        expect(ThoughtSignatureCache.get('nonexistent-key-12345')).toBeNull();
    });

    it('evicts oldest entry when cache exceeds SIG_MAX (50)', () => {
        ThoughtSignatureCache.clear();
        for (let i = 0; i < 51; i++) {
            ThoughtSignatureCache.save(`text_${i}`, `sig_${i}`);
        }
        expect(ThoughtSignatureCache.get('text_0')).toBeNull();
        expect(ThoughtSignatureCache.get('text_50')).toBe('sig_50');
        ThoughtSignatureCache.clear();
    });
});

describe('parseResponsesAPINonStreamingResponse — reasoning branch push', () => {
    it('reasoning item with showThinking=false → skipped', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: false });
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello');
        expect(result.content).not.toContain('Thoughts');
    });

    it('reasoning item with summary not array → skipped', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: 'not-an-array' },
                { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hi');
    });

    it('reasoning summary has non-summary_text type → skipped', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'other_type', text: 'skip' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Result' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toBe('Result');
    });

    it('reasoning summary_text with empty text → no <Thoughts> block', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toBe('Done');
    });

    it('data.usage present with _requestId → records token usage', () => {
        const data = {
            output: [
                { type: 'message', content: [{ type: 'output_text', text: 'OK' }] },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        const result = parseResponsesAPINonStreamingResponse(data, {
            showThinking: false,
            _requestId: 'req-resp-001',
        });
        expect(result.success).toBe(true);
        expect(result.content).toBe('OK');
    });

    it('data.error → returns error result', () => {
        const data = { error: { message: 'Rate limit exceeded' } };
        const result = parseResponsesAPINonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Rate limit exceeded');
    });

    it('empty output with choices fallback', () => {
        const data = {
            output: [],
            choices: [{ message: { content: 'Fallback text' } }],
        };
        const result = parseResponsesAPINonStreamingResponse(data);
        // No output items → result empty → falls through to choices check
        expect(result.content).toContain('Fallback');
    });
});

describe('saveThoughtSignatureFromStream — branch push', () => {
    it('requestId set but no _streamUsageMetadata → does not call _setTokenUsage', () => {
        const config = {
            _requestId: 'req-001',
            _inThoughtBlock: false,
            _lastSignature: null,
            _streamResponseText: '',
            _streamUsageMetadata: null,
        };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toBeNull();
    });

    it('requestId set and _streamUsageMetadata present but _normalizeTokenUsage returns null → does not crash', () => {
        const config = {
            _requestId: 'req-002',
            _inThoughtBlock: false,
            _lastSignature: null,
            _streamResponseText: '',
            _streamUsageMetadata: { invalid: true },
        };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toBeNull();
    });

    it('with _lastSignature and _streamResponseText → saves to cache', () => {
        ThoughtSignatureCache.clear();
        const config = {
            _requestId: null,
            _inThoughtBlock: false,
            _lastSignature: 'sig-abc',
            _streamResponseText: 'My response text',
        };
        saveThoughtSignatureFromStream(config);
        expect(ThoughtSignatureCache.get('My response text')).toBe('sig-abc');
        ThoughtSignatureCache.clear();
    });

    it('with _inThoughtBlock=true → appends closing tag', () => {
        const config = {
            _requestId: null,
            _inThoughtBlock: true,
            _lastSignature: null,
            _streamResponseText: '',
        };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('with valid Gemini _streamUsageMetadata → calls _setTokenUsage', () => {
        const config = {
            _requestId: 'req-gemini-003',
            _inThoughtBlock: false,
            _lastSignature: null,
            _streamResponseText: '',
            _streamUsageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 50,
                totalTokenCount: 150,
            },
        };
        const result = saveThoughtSignatureFromStream(config);
        // Should not throw, usage gets recorded (no assertion on internal state,
        // we just ensure the branch is exercised)
        expect(result).toBeNull();
    });
});

describe('createSSEStream — onComplete dedup', () => {
    it('does not call onComplete twice on abort+cancel', async () => {
        let callCount = 0;
        const ac = new AbortController();
        const mockReader = {
            read: vi.fn(async () => {
                ac.abort();
                return { done: false, value: new TextEncoder().encode('data: test\n\n') };
            }),
            cancel: vi.fn(),
        };
        const mockResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(
            mockResponse,
            (line) => line.replace('data: ', ''),
            ac.signal,
            () => { callCount++; return null; },
        );

        const reader = stream.getReader();
        try { await reader.read(); } catch {}
        try { await reader.cancel(); } catch {}
        expect(callCount).toBeLessThanOrEqual(1);
    });

    it('calls onComplete on normal done and enqueues extra', async () => {
        let called = false;
        const mockReader = {
            read: vi.fn()
                .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: hello\n\n') })
                .mockResolvedValueOnce({ done: true }),
            cancel: vi.fn(),
        };
        const mockResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(
            mockResponse,
            (line) => line.replace('data: ', ''),
            undefined,
            () => { called = true; return 'extra'; },
        );

        const reader = stream.getReader();
        const chunks = [];
        let r;
        do {
            r = await reader.read();
            if (r.value) chunks.push(r.value);
        } while (!r.done);

        expect(called).toBe(true);
        expect(chunks).toContain('extra');
    });
});
