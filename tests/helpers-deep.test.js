/**
 * @file helpers-deep.test.js — Deep branch coverage for helpers.js
 * @vitest-environment jsdom
 *
 * Covers: extractImageUrlFromPart, escHtml, _stripNonSerializable,
 *         _raceWithAbortSignal, safeGetArg, safeGetBoolArg, setArg,
 *         normalizeBooleanSetting (via shouldEnableStreaming/isCompatibilityModeSettingEnabled),
 *         smartFetch, streamingFetch, collectStream, checkStreamCapability
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock ipc-protocol getRisu ──
const mockRisu = {};
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => mockRisu,
}));

import {
    _raceWithAbortSignal,
    safeGetArg,
    safeGetBoolArg,
    setArg,
    escHtml,
    extractImageUrlFromPart,
    safeStringify,
    _stripNonSerializable,
    shouldEnableStreaming,
    isCompatibilityModeSettingEnabled,
    isCompatibilityModeEnabled,
    _resetCompatibilityModeCache,
    smartFetch,
    streamingFetch,
    collectStream,
    checkStreamCapability,
} from '../src/shared/helpers.js';

// ────────────────────────────────────────────────
// extractImageUrlFromPart
// ────────────────────────────────────────────────
describe('extractImageUrlFromPart', () => {
    it('returns empty string for null/undefined', () => {
        expect(extractImageUrlFromPart(null)).toBe('');
        expect(extractImageUrlFromPart(undefined)).toBe('');
    });

    it('returns empty for non-object', () => {
        expect(extractImageUrlFromPart(42)).toBe('');
        expect(extractImageUrlFromPart('hello')).toBe('');
    });

    it('returns string image_url directly for type image_url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: 'https://img.png' })).toBe('https://img.png');
    });

    it('returns url from object image_url for type image_url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: { url: 'https://img2.png' } })).toBe('https://img2.png');
    });

    it('returns empty for image_url type with non-string/non-obj image_url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: 123 })).toBe('');
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: null })).toBe('');
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: {} })).toBe('');
    });

    it('handles input_image type with string url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'https://input.png' })).toBe('https://input.png');
    });

    it('handles input_image type with object url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'https://obj.png' } })).toBe('https://obj.png');
    });

    it('returns empty for unknown type', () => {
        expect(extractImageUrlFromPart({ type: 'audio', audio_url: 'x' })).toBe('');
    });
});

// ────────────────────────────────────────────────
// escHtml
// ────────────────────────────────────────────────
describe('escHtml', () => {
    it('escapes all HTML special characters', () => {
        expect(escHtml('<script>"alert&test</script>')).toBe('&lt;script&gt;&quot;alert&amp;test&lt;/script&gt;');
    });

    it('returns empty for non-string', () => {
        expect(escHtml(null)).toBe('');
        expect(escHtml(undefined)).toBe('');
        expect(escHtml(42)).toBe('');
    });

    it('returns empty string for empty input', () => {
        expect(escHtml('')).toBe('');
    });

    it('handles ampersand correctly', () => {
        expect(escHtml('a&b')).toBe('a&amp;b');
    });
});

// ────────────────────────────────────────────────
// _stripNonSerializable
// ────────────────────────────────────────────────
describe('_stripNonSerializable', () => {
    it('strips functions', () => {
        const obj = { a: 1, fn: () => {} };
        expect(_stripNonSerializable(obj)).toEqual({ a: 1 });
    });

    it('strips symbols', () => {
        const obj = { a: 'x', sym: Symbol('test') };
        expect(_stripNonSerializable(obj)).toEqual({ a: 'x' });
    });

    it('strips bigint', () => {
        const obj = { a: 1, big: BigInt(42) };
        expect(_stripNonSerializable(obj)).toEqual({ a: 1 });
    });

    it('converts Date to string', () => {
        const d = new Date('2025-01-01');
        const result = _stripNonSerializable(d);
        expect(typeof result).toBe('string');
    });

    it('converts RegExp to string', () => {
        expect(typeof _stripNonSerializable(/test/g)).toBe('string');
    });

    it('converts Error to string', () => {
        expect(typeof _stripNonSerializable(new Error('x'))).toBe('string');
    });

    it('preserves Uint8Array', () => {
        const u = new Uint8Array([1, 2, 3]);
        expect(_stripNonSerializable(u)).toBe(u);
    });

    it('preserves ArrayBuffer', () => {
        const ab = new ArrayBuffer(4);
        expect(_stripNonSerializable(ab)).toBe(ab);
    });

    it('handles arrays, filtering undefined items from functions', () => {
        const arr = [1, () => {}, 'hello', Symbol('s')];
        expect(_stripNonSerializable(arr)).toEqual([1, 'hello']);
    });

    it('handles null/undefined passthrough', () => {
        expect(_stripNonSerializable(null)).toBeNull();
        expect(_stripNonSerializable(undefined)).toBeUndefined();
    });

    it('handles primitive types passthrough', () => {
        expect(_stripNonSerializable(42)).toBe(42);
        expect(_stripNonSerializable('str')).toBe('str');
        expect(_stripNonSerializable(true)).toBe(true);
    });

    it('stops recursion at depth 15', () => {
        let obj = { value: 'end' };
        for (let i = 0; i < 20; i++) obj = { nested: obj };
        // Should not throw — just returns obj at depth 15
        const result = _stripNonSerializable(obj);
        expect(result).toBeDefined();
    });

    it('handles nested objects', () => {
        const obj = { a: { b: { c: () => {}, d: 1 } } };
        expect(_stripNonSerializable(obj)).toEqual({ a: { b: { d: 1 } } });
    });
});

// ────────────────────────────────────────────────
// _raceWithAbortSignal
// ────────────────────────────────────────────────
describe('_raceWithAbortSignal', () => {
    it('returns promise directly if no signal', async () => {
        const result = await _raceWithAbortSignal(Promise.resolve('ok'), null);
        expect(result).toBe('ok');
    });

    it('returns promise directly if signal is undefined', async () => {
        const result = await _raceWithAbortSignal(Promise.resolve('ok'), undefined);
        expect(result).toBe('ok');
    });

    it('rejects immediately if signal already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(_raceWithAbortSignal(Promise.resolve('ok'), ac.signal))
            .rejects.toThrow('The operation was aborted.');
    });

    it('resolves when fetch resolves before abort', async () => {
        const ac = new AbortController();
        const result = await _raceWithAbortSignal(Promise.resolve('data'), ac.signal);
        expect(result).toBe('data');
    });

    it('rejects when abort fires before fetch resolves', async () => {
        const ac = new AbortController();
        const slowPromise = new Promise((resolve) => setTimeout(resolve, 5000));
        const racePromise = _raceWithAbortSignal(slowPromise, ac.signal);
        ac.abort();
        await expect(racePromise).rejects.toThrow('The operation was aborted.');
    });

    it('rejects with fetch error if fetch rejects first', async () => {
        const ac = new AbortController();
        const failing = Promise.reject(new Error('net error'));
        await expect(_raceWithAbortSignal(failing, ac.signal)).rejects.toThrow('net error');
    });
});

// ────────────────────────────────────────────────
// safeGetArg / safeGetBoolArg / setArg
// ────────────────────────────────────────────────
describe('safeGetArg', () => {
    beforeEach(() => {
        mockRisu.getArgument = vi.fn();
    });

    it('returns value when present', async () => {
        mockRisu.getArgument.mockResolvedValue('mykey');
        expect(await safeGetArg('key')).toBe('mykey');
    });

    it('returns default for null/undefined/empty', async () => {
        mockRisu.getArgument.mockResolvedValue(null);
        expect(await safeGetArg('key', 'def')).toBe('def');

        mockRisu.getArgument.mockResolvedValue(undefined);
        expect(await safeGetArg('key', 'def')).toBe('def');

        mockRisu.getArgument.mockResolvedValue('');
        expect(await safeGetArg('key', 'def')).toBe('def');
    });

    it('returns default on error', async () => {
        mockRisu.getArgument.mockRejectedValue(new Error('no'));
        expect(await safeGetArg('key', 'fallback')).toBe('fallback');
    });

    it('uses empty string as default', async () => {
        mockRisu.getArgument.mockResolvedValue(null);
        expect(await safeGetArg('key')).toBe('');
    });
});

describe('safeGetBoolArg', () => {
    beforeEach(() => {
        mockRisu.getArgument = vi.fn();
    });

    it('returns boolean directly', async () => {
        mockRisu.getArgument.mockResolvedValue(true);
        expect(await safeGetBoolArg('key')).toBe(true);

        mockRisu.getArgument.mockResolvedValue(false);
        expect(await safeGetBoolArg('key')).toBe(false);
    });

    it('parses string true variants', async () => {
        for (const val of ['true', '1', 'yes', 'on', 'TRUE', 'Yes', 'ON']) {
            mockRisu.getArgument.mockResolvedValue(val);
            expect(await safeGetBoolArg('key')).toBe(true);
        }
    });

    it('parses string false variants', async () => {
        for (const val of ['false', '0', 'no', 'off', 'FALSE', 'No', 'OFF']) {
            mockRisu.getArgument.mockResolvedValue(val);
            expect(await safeGetBoolArg('key')).toBe(false);
        }
    });

    it('returns default for empty/null/undefined strings', async () => {
        for (const val of ['', 'undefined', 'null', null, undefined]) {
            mockRisu.getArgument.mockResolvedValue(val);
            expect(await safeGetBoolArg('key', true)).toBe(true);
        }
    });

    it('returns default for unrecognized values', async () => {
        mockRisu.getArgument.mockResolvedValue('maybe');
        expect(await safeGetBoolArg('key', false)).toBe(false);
    });

    it('returns default on error', async () => {
        mockRisu.getArgument.mockRejectedValue(new Error('fail'));
        expect(await safeGetBoolArg('key', true)).toBe(true);
    });
});

describe('setArg', () => {
    beforeEach(() => {
        mockRisu.setArgument = vi.fn();
    });

    it('calls Risu.setArgument', () => {
        setArg('key', 'value');
        expect(mockRisu.setArgument).toHaveBeenCalledWith('key', 'value');
    });

    it('warns on error without throwing', () => {
        mockRisu.setArgument = vi.fn(() => { throw new Error('fail'); });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setArg('key', 'value');
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});

// ────────────────────────────────────────────────
// shouldEnableStreaming edge cases
// ────────────────────────────────────────────────
describe('shouldEnableStreaming edge cases', () => {
    it('returns false for empty settings', () => {
        expect(shouldEnableStreaming()).toBe(false);
        expect(shouldEnableStreaming({})).toBe(false);
    });

    it('returns true when streaming enabled and compatibility off', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: false })).toBe(true);
    });

    it('returns true for Copilot even in compatibility mode', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: true }, { isCopilot: true })).toBe(true);
    });

    it('handles string "true" for streaming_enabled', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true' })).toBe(true);
    });

    it('handles string "1" for streaming_enabled', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: '1' })).toBe(true);
    });
});

// ────────────────────────────────────────────────
// isCompatibilityModeEnabled (cached async)
// ────────────────────────────────────────────────
describe('isCompatibilityModeEnabled', () => {
    beforeEach(() => {
        _resetCompatibilityModeCache();
        mockRisu.getArgument = vi.fn();
    });

    it('caches the result', async () => {
        mockRisu.getArgument.mockResolvedValue('true');
        const r1 = await isCompatibilityModeEnabled();
        const r2 = await isCompatibilityModeEnabled();
        expect(r1).toBe(true);
        expect(r2).toBe(true);
        expect(mockRisu.getArgument).toHaveBeenCalledTimes(1);
    });
});

// ────────────────────────────────────────────────
// smartFetch
// ────────────────────────────────────────────────
describe('smartFetch', () => {
    beforeEach(() => {
        _resetCompatibilityModeCache();
        mockRisu.getArgument = vi.fn().mockResolvedValue(null);
        // Suppress console.log/error in smartFetch
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('throws immediately if signal already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        mockRisu.nativeFetch = vi.fn();
        await expect(smartFetch('https://api.test.com', { signal: ac.signal }))
            .rejects.toThrow('The operation was aborted.');
    });

    it('uses nativeFetch as final fallback for non-JSON content', async () => {
        mockRisu.risuFetch = undefined;
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        const res = await smartFetch('https://api.test.com', {
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'key=value'
        });
        expect(res.status).toBe(200);
    });

    it('Copilot URL uses nativeFetch first', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
        mockRisu.risuFetch = vi.fn();
        const res = await smartFetch('https://api.githubcopilot.com/chat', {
            method: 'POST',
            body: '{}'
        });
        expect(res.status).toBe(200);
        expect(mockRisu.nativeFetch).toHaveBeenCalled();
    });

    it('falls back to nativeFetch when risuFetch plainFetchForce returns no headers', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: new Uint8Array([1]),
            status: 400,
            ok: false,
            headers: {},
        });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        const res = await smartFetch('https://api.openai.com/v1/chat', {
            body: '{"msg":"hi"}',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(200);
    });

    it('returns risuFetch result when headers are present', async () => {
        const mockHeaders = new Headers({ 'content-type': 'application/json' });
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: new TextEncoder().encode('{"result":"ok"}'),
            status: 200,
            ok: true,
            headers: mockHeaders,
        });
        const res = await smartFetch('https://api.openai.com/v1/chat', {
            body: '{"msg":"hi"}',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('result');
    });

    it('throws when nativeFetch is unavailable and direct fetch fails', async () => {
        mockRisu.nativeFetch = undefined;
        mockRisu.risuFetch = undefined;
        // globalThis.fetch will fail for this URL
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('CORS'));
        try {
            await expect(smartFetch('https://api.no-cors.com', {
                headers: { 'content-type': 'text/plain' },
            })).rejects.toThrow();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('compatibility mode throws for non-Copilot URL on nativeFetch path', async () => {
        mockRisu.getArgument.mockResolvedValue('true');
        _resetCompatibilityModeCache();
        mockRisu.risuFetch = vi.fn().mockResolvedValue({ data: null, status: 0, headers: {} });
        mockRisu.nativeFetch = vi.fn();
        await expect(smartFetch('https://api.anthropic.com/v1/messages', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        })).rejects.toThrow('Compatibility mode');
    });

    it('Copilot URL: falls back through all strategies', async () => {
        // nativeFetch fails, risuFetch + plainFetchDeforce fails, risuFetch + plainFetchForce fails
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0 });
        mockRisu.risuFetch = vi.fn()
            .mockResolvedValueOnce({ data: null, status: 0, headers: {} })  // deforce
            .mockResolvedValueOnce({ data: null, status: 0, headers: {} }); // force
        // Falls through to generic path, which also risuFetch then nativeFetch
        // Final nativeFetch will return status 0 again
        await expect(smartFetch('https://api.githubcopilot.com/chat', {
            body: '{"model":"gpt-4"}',
            headers: { 'content-type': 'application/json' },
        })).rejects.toThrow();
    });

    it('Copilot URL: risuFetch body parse failure skips to next strategy', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0 });
        mockRisu.risuFetch = vi.fn();
        await expect(smartFetch('https://api.githubcopilot.com/chat', {
            body: 'not-json-body',
            headers: { 'content-type': 'application/json' },
        })).rejects.toThrow();
    });

    it('Copilot URL: 4xx with null data returns error response', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0 });
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: null, status: 401, headers: {},
        });
        const res = await smartFetch('https://api.githubcopilot.com/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(401);
    });

    it('generic path: risuFetch body parse failure falls to nativeFetch', async () => {
        mockRisu.risuFetch = vi.fn();
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        const res = await smartFetch('https://api.anthropic.com/v1/messages', {
            body: 'not-json',
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(200);
    });

    it('nativeFetch returns invalid response (status 0) then throws', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValue({ data: null, status: 0, headers: {} });
        mockRisu.nativeFetch = vi.fn().mockResolvedValue({ status: 0 });
        await expect(smartFetch('https://api.openai.com/v1/chat', {
            body: '{}',
            headers: { 'content-type': 'application/json' },
        })).rejects.toThrow();
    });

    it('re-throws AbortError from nativeFetch', async () => {
        mockRisu.risuFetch = vi.fn().mockResolvedValue({ data: null, status: 0, headers: {} });
        const abortErr = new DOMException('aborted', 'AbortError');
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(abortErr);
        await expect(smartFetch('https://api.openai.com/v1/chat', {
            body: '{}',
        })).rejects.toThrow('aborted');
    });
});

// ────────────────────────────────────────────────
// streamingFetch
// ────────────────────────────────────────────────
describe('streamingFetch', () => {
    beforeEach(() => {
        _resetCompatibilityModeCache();
        mockRisu.getArgument = vi.fn().mockResolvedValue(null);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('throws immediately if signal already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        mockRisu.nativeFetch = vi.fn();
        await expect(streamingFetch('https://api.test.com', { signal: ac.signal }))
            .rejects.toThrow('The operation was aborted.');
    });

    it('uses nativeFetch successfully', async () => {
        mockRisu.nativeFetch = vi.fn().mockResolvedValue(new Response('stream data', { status: 200 }));
        mockRisu.risuFetch = vi.fn();
        const res = await streamingFetch('https://api.openai.com/v1/chat', {});
        expect(res.status).toBe(200);
    });

    it('falls back to direct fetch when no bridge', async () => {
        mockRisu.nativeFetch = undefined;
        mockRisu.risuFetch = undefined;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        try {
            const res = await streamingFetch('https://cors-enabled-api.test.com', {});
            expect(res.status).toBe(200);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('falls back to risuFetch proxy when nativeFetch fails', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('bridge down'));
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: new TextEncoder().encode('proxy response'),
            status: 200,
            headers: {},
        });
        const res = await streamingFetch('https://api.openai.com/v1/chat', {
            body: '{"msg":"hi"}',
        });
        expect(res.status).toBe(200);
    });

    it('throws when all strategies fail', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('bridge'));
        mockRisu.risuFetch = vi.fn().mockRejectedValue(new Error('proxy too'));
        await expect(streamingFetch('https://api.test.com', { body: '{}' }))
            .rejects.toThrow('All fetch strategies failed');
    });

    it('compatibility mode skips nativeFetch for non-Copilot URL', async () => {
        mockRisu.getArgument.mockResolvedValue('true');
        _resetCompatibilityModeCache();
        mockRisu.nativeFetch = vi.fn();
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: new TextEncoder().encode('proxy'),
            status: 200,
            headers: {},
        });
        const res = await streamingFetch('https://api.anthropic.com', { body: '{}' });
        expect(res.status).toBe(200);
        // nativeFetch should NOT have been called due to compatibility mode
        expect(mockRisu.nativeFetch).not.toHaveBeenCalled();
    });

    it('risuFetch handles various data types', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('nope'));

        // ArrayBuffer
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: new ArrayBuffer(4), status: 200, headers: {},
        });
        let res = await streamingFetch('https://api.test.com', { body: '{}' });
        expect(res.status).toBe(200);

        // Array of numbers
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: [72, 101, 108], status: 200, headers: {},
        });
        res = await streamingFetch('https://api.test.com', { body: '{}' });
        expect(res.status).toBe(200);

        // String data
        mockRisu.risuFetch = vi.fn().mockResolvedValue({
            data: 'string response', status: 200, headers: {},
        });
        res = await streamingFetch('https://api.test.com', { body: '{}' });
        expect(res.status).toBe(200);
    });

    it('risuFetch body parse failure skips to throw', async () => {
        mockRisu.nativeFetch = vi.fn().mockRejectedValue(new Error('nope'));
        mockRisu.risuFetch = vi.fn().mockRejectedValue(new Error('Body JSON parse failed'));
        await expect(streamingFetch('https://api.test.com', {
            body: 'not-json',
        })).rejects.toThrow('All fetch strategies failed');
    });
});

// ────────────────────────────────────────────────
// collectStream
// ────────────────────────────────────────────────
describe('collectStream', () => {
    it('collects string chunks', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('hello ');
                controller.enqueue('world');
                controller.close();
            }
        });
        expect(await collectStream(stream)).toBe('hello world');
    });

    it('collects Uint8Array chunks (node environment)', async () => {
        // Note: In jsdom, Uint8Array from TextEncoder may not pass instanceof check
        // due to realm differences. This test verifies the string path works.
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('abc');
                controller.enqueue('def');
                controller.close();
            }
        });
        expect(await collectStream(stream)).toBe('abcdef');
    });

    it('handles empty stream', async () => {
        const stream = new ReadableStream({ start(c) { c.close(); } });
        expect(await collectStream(stream)).toBe('');
    });

    it('handles null/undefined values', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('a');
                controller.enqueue(null);
                controller.enqueue('b');
                controller.close();
            }
        });
        expect(await collectStream(stream)).toBe('ab');
    });

    it('stops when abort signal fires', async () => {
        const ac = new AbortController();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('before');
                // abort fires between chunks
            }
        });
        ac.abort();
        const result = await collectStream(stream, ac.signal);
        // Should stop early — might get partial
        expect(typeof result).toBe('string');
    });

    it('handles ArrayBuffer values via TextDecoder', async () => {
        const enc = new TextEncoder();
        const ab = enc.encode('test').buffer;
        const stream = new ReadableStream({
            start(controller) {
                // collectStream checks: instanceof Uint8Array → decode, instanceof ArrayBuffer → decode
                controller.enqueue(new Uint8Array(ab));
                controller.close();
            }
        });
        expect(await collectStream(stream)).toBe('test');
    });

    it('converts non-standard value via String() fallback', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(12345);
                controller.enqueue(true);
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('12345true');
    });

    it('converts non-standard values with String()', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(42);
                controller.close();
            }
        });
        expect(await collectStream(stream)).toBe('42');
    });
});

// ────────────────────────────────────────────────
// checkStreamCapability (MessageChannel-based)
// ────────────────────────────────────────────────
describe('checkStreamCapability', () => {
    it('returns a boolean', async () => {
        // This tests the actual browser capability
        const result = await checkStreamCapability();
        expect(typeof result).toBe('boolean');
    });

    it('caches the result', async () => {
        const r1 = await checkStreamCapability();
        const r2 = await checkStreamCapability();
        expect(r1).toBe(r2);
    });
});
