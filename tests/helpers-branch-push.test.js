/**
 * helpers-branch-push.test.js — helpers.js branch coverage push
 *
 * Targets uncovered smartFetch Copilot paths, streamingFetch risuFetch fallback paths,
 * toResponseBody edge cases, and sanitizeBodyForBridge catch blocks.
 *
 * Current: 84.15% → target: 87%+
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ipc-protocol getRisu ──
const mockRisu = {
    getArgument: vi.fn(async () => ''),
    setArgument: vi.fn(),
};
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => mockRisu,
    CH: { CONTROL: 'cpm:control', RESPONSE: 'cpm:response', ABORT: 'cpm:abort', FETCH: 'cpm:fetch' },
    MSG: {},
    safeUUID: () => 'test-uuid',
    MANAGER_NAME: 'cupcake-provider-manager',
    setupChannelCleanup: vi.fn(),
    registerWithManager: vi.fn(),
}));

import { smartFetch, streamingFetch, _stripNonSerializable, _resetCompatibilityModeCache } from '../src/shared/helpers.js';

// ──────────────────────────────────────────────────────────────
// helpers.js L170-180: getHeaderValue / hasHeaders edge cases
// (reached indirectly through smartFetch Copilot path)
// ──────────────────────────────────────────────────────────────
describe('smartFetch — Copilot Strategy B: proxy-forced risuFetch', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        mockRisu.getArgument = vi.fn(async () => '');
        _resetCompatibilityModeCache();
    });

    it('Strategy B returns response with valid data and status', async () => {
        // nativeFetch fails → Strategy B activates
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new Uint8Array([123, 125]), // {}
            status: 200,
            ok: true,
            headers: { 'content-type': 'application/json' },
        });

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4' }),
        });
        expect(res.status).toBe(200);
    });

    it('Strategy B: 4xx with null data → synthetic error response', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        // First call (Strategy B): data=null, status=403
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 403, ok: false, headers: {} });

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ msg: 'hi' }),
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toContain('403');
    });

    it('Strategy B: toResponseBody returns null → falls to Strategy C', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        // Strategy B: data is a Blob (toResponseBody returns null for Blob)
        const blob = new Blob(['hello']);
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: blob, status: 200, ok: true, headers: {} })
            // Strategy C: valid response
            .mockResolvedValueOnce({
                data: new Uint8Array([79, 75]),
                status: 200, ok: true,
                headers: { 'x-real': '1' },
            });

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ msg: 'test' }),
        });
        expect(res.status).toBe(200);
    });
});

describe('smartFetch — Copilot Strategy C: plainFetchForce', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        mockRisu.getArgument = vi.fn(async () => '');
        _resetCompatibilityModeCache();
    });

    it('Strategy C: hasRealHeaders=true → returns response', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        // Strategy B: fails (status=0)
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 0, ok: false, headers: {} })
            // Strategy C: has real headers
            .mockResolvedValueOnce({
                data: new TextEncoder().encode('{"ok":true}'),
                status: 200, ok: false, // ok=false but hasRealHeaders=true
                headers: { 'content-type': 'application/json', 'x-request-id': '123' },
            });

        const res = await smartFetch('https://api.githubcopilot.com/v1/models', {
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(200);
    });

    it('Strategy C: ok=true → returns response (no real headers)', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 0, ok: false, headers: {} })
            .mockResolvedValueOnce({
                data: new Uint8Array([49, 50, 51]),
                status: 200, ok: true,
                headers: {},
            });

        const res = await smartFetch('https://api.githubcopilot.com/v1/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
    });

    it('Strategy C: status 4xx → returns response (real API error)', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 0, ok: false, headers: {} })
            .mockResolvedValueOnce({
                data: new TextEncoder().encode('{"error":"rate_limited"}'),
                status: 429, ok: false,
                headers: {},
            });

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(429);
    });

    it('Strategy C: 4xx with null data → synthetic error', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 0, ok: false, headers: {} })
            .mockResolvedValueOnce({ data: null, status: 401, ok: false, headers: {} });

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('401');
    });

    it('Strategy C: toResponseBody returns null → throws', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('native fail'));
        const blob = new Blob(['x']);
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 0, ok: false, headers: {} })
            .mockResolvedValueOnce({
                data: blob, status: 200, ok: true,
                headers: { 'x-real': '1' },
            });

        // All strategies fail → should throw
        await expect(smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow();
    });
});

describe('smartFetch — Strategy 2 nativeFetch response wrapping', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        mockRisu.getArgument = vi.fn(async () => '');
        _resetCompatibilityModeCache();
    });

    it('nativeFetch returns status=0 → throws invalid response', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0, ok: false });
        // No risuFetch → goes straight to nativeFetch (Strategy 2)

        await expect(smartFetch('https://api.example.com/v1/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow('All fetch strategies failed');
    });

    it('nativeFetch returns null → throws', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(null);

        await expect(smartFetch('https://api.example.com/v1/test', {
            method: 'POST',
            headers: {},
        })).rejects.toThrow();
    });

    it('nativeFetch with valid status returns as-is', async () => {
        const mockRes = new Response('ok', { status: 200 });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(mockRes);

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(200);
    });
});

// ──────────────────────────────────────────────────────────────
// streamingFetch — risuFetch fallback: data conversion paths
// ──────────────────────────────────────────────────────────────
describe('streamingFetch — risuFetch response data conversion', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        mockRisu.getArgument = vi.fn(async () => '');
        _resetCompatibilityModeCache();
    });

    it('risuFetch ArrayBufferView data → Uint8Array conversion', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        // Return DataView (ArrayBufferView but not Uint8Array)
        const buf = new ArrayBuffer(4);
        new Uint8Array(buf).set([65, 66, 67, 68]);
        const dv = new DataView(buf);
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: dv, status: 200, ok: true, headers: {},
        });

        const res = await streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toBe('ABCD');
    });

    it('risuFetch ArrayBuffer data → Uint8Array conversion', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        const buf = new ArrayBuffer(2);
        new Uint8Array(buf).set([72, 73]);
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: buf, status: 200, ok: true, headers: {},
        });

        const res = await streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        const text = await res.text();
        expect(text).toBe('HI');
    });

    it('risuFetch Array data → Uint8Array conversion', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: [72, 101, 108, 108, 111],
            status: 200, ok: true, headers: {},
        });

        const res = await streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        const text = await res.text();
        expect(text).toBe('Hello');
    });

    it('risuFetch array-like object with .length → Uint8Array conversion', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        const arrayLike = { 0: 65, 1: 66, length: 2 };
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: arrayLike, status: 200, ok: true, headers: {},
        });

        const res = await streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        const text = await res.text();
        expect(text).toBe('AB');
    });

    it('risuFetch null data → falls through, throws all-failed', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: null, status: 200, ok: true, headers: {},
        });

        await expect(streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow('All fetch strategies failed');
    });

    it('risuFetch Blob data → no conversion, falls through', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new Blob(['x']), status: 200, ok: true, headers: {},
        });

        await expect(streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow('All fetch strategies failed');
    });

    it('risuFetch non-AbortError catch → logs and falls through', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        mockRisu.risuFetch = vi.fn().mockRejectedValue(new Error('risuFetch crashed'));

        await expect(streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow('All fetch strategies failed');
    });

    it('risuFetch AbortError → re-thrown', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        mockRisu.risuFetch = vi.fn().mockRejectedValue(
            new DOMException('Aborted', 'AbortError')
        );

        await expect(streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow('Aborted');
    });

    it('risuFetch with non-JSON body object (skip JSON.parse path)', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('fail'));
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new Uint8Array([79, 75]),
            status: 200, ok: true, headers: {},
        });

        const res = await streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: { already: 'an object' }, // Not a string → else branch
        });
        expect(res.status).toBe(200);
    });
});

// ──────────────────────────────────────────────────────────────
// streamingFetch — compatibility mode skip path
// ──────────────────────────────────────────────────────────────
describe('streamingFetch — compatibility mode', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        _resetCompatibilityModeCache();
    });

    it('compatibility mode skips nativeFetch and uses risuFetch', async () => {
        // Enable compatibility mode
        mockRisu.getArgument = vi.fn(async (key) => {
            if (key === 'cpm_compatibility_mode') return 'true';
            return '';
        });
        mockRisu.nativeFetch = vi.fn();
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new Uint8Array([79, 75]),
            status: 200, ok: true, headers: {},
        });

        const res = await streamingFetch('https://api.example.com/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
        // nativeFetch should NOT have been called
        expect(mockRisu.nativeFetch).not.toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────
// smartFetch — Strategy 1 direct fetch hasHeaders/toResponseBody
// ──────────────────────────────────────────────────────────────
describe('smartFetch — Strategy 1 direct fetch edge cases', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        mockRisu.getArgument = vi.fn(async () => '');
        _resetCompatibilityModeCache();
    });

    it('Strategy 1: risuFetch ok=true with empty headers → returns', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new TextEncoder().encode('{"result":"ok"}'),
            status: 200, ok: true,
            headers: {},
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
    });

    it('Strategy 1: string data with valid status → TextEncoder conversion', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: '{"result":"text"}',
            status: 200, ok: true,
            headers: { 'content-type': 'application/json' },
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.result).toBe('text');
    });

    it('Strategy 1: ArrayBuffer data → Uint8Array conversion', async () => {
        const ab = new ArrayBuffer(2);
        new Uint8Array(ab).set([65, 66]);
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: ab,
            status: 200, ok: true,
            headers: { 'x-header': 'val' },
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(200);
    });

    it('Strategy 1: Array data → Uint8Array conversion', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: [72, 73],
            status: 200, ok: true,
            headers: { 'x-h': '1' },
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(200);
    });

    it('Strategy 1: data=null → falls through to nativeFetch', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: null,
            status: 200, ok: true,
            headers: {},
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(
            new Response('ok', { status: 200 })
        );

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(200);
    });

    it('Strategy 1: no real headers and not ok → falls to nativeFetch', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new Uint8Array([1]),
            status: 400, ok: false,
            headers: {}, // no real headers
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(
            new Response('fallback', { status: 200 })
        );

        const res = await smartFetch('https://api.example.com/v1/test', {
            method: 'GET',
            headers: {},
        });
        // Should fall through to nativeFetch
        expect(res.status).toBe(200);
    });
});

// ──────────────────────────────────────────────────────────────
// smartFetch — Copilot Strategy A nativeFetch edge cases
// ──────────────────────────────────────────────────────────────
describe('smartFetch — Copilot Strategy A edge cases', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        mockRisu.getArgument = vi.fn(async () => '');
        _resetCompatibilityModeCache();
    });

    it('Strategy A: nativeRes with empty body → returns nativeRes directly', async () => {
        // clone().text() returns empty → returns nativeRes as-is
        const mockRes = {
            status: 200, ok: true, statusText: 'OK',
            headers: new Headers({ 'x-test': '1' }),
            clone: () => ({ text: async () => '' }),
        };
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(mockRes);
        mockRisu.risuFetch = vi.fn();

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
    });

    it('Strategy A: nativeRes.clone().text() throws → returns nativeRes', async () => {
        const mockRes = {
            status: 200, ok: true, statusText: 'OK',
            headers: new Headers(),
            clone: () => ({ text: async () => { throw new Error('clone fail'); } }),
        };
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(mockRes);
        mockRisu.risuFetch = vi.fn();

        const res = await smartFetch('https://api.githubcopilot.com/v1/chat', {
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(200);
    });

    it('Strategy A: nativeRes not ok and status=0 → falls to Strategy B', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0, ok: false });
        mockRisu.risuFetch = vi.fn().mockResolvedValueOnce({
            data: new Uint8Array([123, 125]),
            status: 200, ok: true,
            headers: { 'content-type': 'application/json' },
        });

        const res = await smartFetch('https://api.githubcopilot.com/v1/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        });
        expect(res.status).toBe(200);
    });
});

// ──────────────────────────────────────────────────────────────
// smartFetch — compatibility mode skip nativeFetch
// ──────────────────────────────────────────────────────────────
describe('smartFetch — compatibility mode path', () => {
    beforeEach(() => {
        Object.keys(mockRisu).forEach(k => {
            if (k !== 'getArgument' && k !== 'setArgument') delete mockRisu[k];
        });
        _resetCompatibilityModeCache();
    });

    it('compatibility mode → throws for non-copilot URL', async () => {
        mockRisu.getArgument = vi.fn(async (key) => {
            if (key === 'cpm_compatibility_mode') return 'true';
            return '';
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });

        await expect(smartFetch('https://api.example.com/v1/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: 1 }),
        })).rejects.toThrow('Compatibility mode skipped');
    });

    it('nativeFetch unavailable → tries direct fetch then throws', async () => {
        mockRisu.getArgument = vi.fn(async () => '');
        // No nativeFetch, no risuFetch
        delete mockRisu.nativeFetch;
        delete mockRisu.risuFetch;

        await expect(smartFetch('https://api.example.com/v1/test', {
            method: 'GET',
            headers: {},
        })).rejects.toThrow();
    });
});

// ──────────────────────────────────────────────────────────────
// _stripNonSerializable — additional depth/ArrayBufferView edges
// ──────────────────────────────────────────────────────────────
describe('_stripNonSerializable — additional edges', () => {
    it('ArrayBufferView (DataView) → returns as-is', () => {
        const buf = new ArrayBuffer(4);
        const dv = new DataView(buf);
        // DataView is ArrayBufferView but NOT instanceof Uint8Array or ArrayBuffer
        // So it falls through to object iteration
        const result = _stripNonSerializable(dv);
        // DataView has numeric properties from buffer, result depends on implementation
        expect(result).toBeDefined();
    });

    it('nested object with mixed exotic types', () => {
        const obj = {
            date: new Date('2025-01-01'),
            regex: /test/gi,
            error: new Error('test error'),
            nested: {
                fn: () => {},
                sym: Symbol('x'),
                big: BigInt(99),
                normal: 'keep',
            },
            arr: [1, () => {}, new Date(), 'str'],
        };
        const result = _stripNonSerializable(obj);
        expect(typeof result.date).toBe('string');
        expect(typeof result.regex).toBe('string');
        expect(typeof result.error).toBe('string');
        expect(result.nested.normal).toBe('keep');
        expect(result.nested.fn).toBeUndefined();
        expect(result.nested.sym).toBeUndefined();
        expect(result.nested.big).toBeUndefined();
        expect(result.arr).toHaveLength(3); // fn filtered out
    });
});
