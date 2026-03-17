import { beforeEach, describe, expect, it, vi } from 'vitest';
import { smartFetch, _resetCompatibilityModeCache } from '../src/shared/helpers.js';

describe('smartFetch', () => {
    let mockRisu;

    beforeEach(() => {
        mockRisu = {
            nativeFetch: vi.fn(),
            risuFetch: vi.fn(),
            getArgument: vi.fn(async () => ''),
        };
        globalThis.window = { risuai: mockRisu };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('CORS blocked'));
        vi.clearAllMocks();
        _resetCompatibilityModeCache();
    });

    it('does not replay Copilot POST when nativeFetch returns a concrete HTTP error', async () => {
        mockRisu.nativeFetch.mockResolvedValue({
            ok: false,
            status: 500,
            clone: () => ({ text: async () => 'Server error' }),
            text: async () => 'Server error',
            headers: new Headers({ 'content-type': 'text/plain' }),
            statusText: 'Server Error',
        });
        mockRisu.risuFetch.mockResolvedValue({
            status: 200,
            data: 'should-not-be-used',
            headers: { 'content-type': 'text/plain' },
        });

        const res = await smartFetch('https://api.githubcopilot.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] }),
        });

        expect(mockRisu.nativeFetch).toHaveBeenCalledOnce();
        expect(mockRisu.risuFetch).not.toHaveBeenCalled();
        expect(res.status).toBe(500);
    });

    it('falls back only when nativeFetch has no usable HTTP response', async () => {
        mockRisu.nativeFetch.mockResolvedValue({ ok: false, status: 0 });
        mockRisu.risuFetch.mockResolvedValue({
            status: 200,
            ok: true,
            data: JSON.stringify({ ok: true }),
            headers: { 'content-type': 'application/json' },
        });

        const res = await smartFetch('https://api.githubcopilot.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] }),
        });

        expect(mockRisu.nativeFetch).toHaveBeenCalledOnce();
        expect(mockRisu.risuFetch).toHaveBeenCalledOnce();
        expect(res.status).toBe(200);
    });

    it('skips risuFetch direct strategy for non-JSON bodies', async () => {
        mockRisu.nativeFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => 'ok',
            headers: new Headers({ 'content-type': 'text/plain' }),
        });

        const res = await smartFetch('https://example.com/form', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'a=1&b=2',
        });

        expect(res.status).toBe(200);
        expect(mockRisu.risuFetch).not.toHaveBeenCalled();
        expect(mockRisu.nativeFetch).toHaveBeenCalledOnce();
    });

    it('passes through 4xx Copilot proxy errors with synthesized body', async () => {
        mockRisu.nativeFetch.mockResolvedValue({ ok: false, status: 0 });
        mockRisu.risuFetch.mockResolvedValue({ status: 401, data: null, headers: {} });

        const res = await smartFetch('https://api.githubcopilot.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] }),
        });

        expect(res.status).toBe(401);
        expect(await res.text()).toContain('HTTP 401');
    });

    it('throws AbortError when already aborted before request', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(smartFetch('https://example.com', {
            method: 'POST',
            signal: controller.signal,
        })).rejects.toThrow(/aborted/i);
        expect(mockRisu.nativeFetch).not.toHaveBeenCalled();
    });

    // TEST-1: 3-tier strategy tests
    describe('3-tier fetch strategy', () => {
        it('Strategy 1: risuFetch succeeds for API call with JSON body', async () => {
            mockRisu.risuFetch.mockResolvedValue({
                status: 200,
                ok: true,
                data: JSON.stringify({ success: true }),
                headers: { 'content-type': 'application/json' },
            });

            const res = await smartFetch('https://api.example.com/v1/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'test', messages: [] }),
            });

            expect(res.status).toBe(200);
            // risuFetch should be the first strategy tried for JSON POST
            expect(mockRisu.risuFetch).toHaveBeenCalled();
        });

        it('Strategy 2: nativeFetch succeeds when risuFetch fails', async () => {
            mockRisu.risuFetch.mockRejectedValue(new Error('risuFetch failed'));
            mockRisu.nativeFetch.mockResolvedValue({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ success: true }),
                headers: new Headers({ 'content-type': 'application/json' }),
            });

            const res = await smartFetch('https://api.example.com/v1/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'test', messages: [] }),
            });

            expect(res.status).toBe(200);
            expect(mockRisu.nativeFetch).toHaveBeenCalled();
        });

        it('GET request goes through nativeFetch (skip risuFetch for non-JSON POST)', async () => {
            mockRisu.nativeFetch.mockResolvedValue({
                ok: true,
                status: 200,
                text: async () => '[]',
                headers: new Headers({ 'content-type': 'application/json' }),
            });

            const res = await smartFetch('https://api.example.com/models', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer key' },
            });

            expect(res.status).toBe(200);
            expect(mockRisu.nativeFetch).toHaveBeenCalled();
        });

        it('skips nativeFetch for non-Copilot requests in compatibility mode', async () => {
            mockRisu.getArgument.mockImplementation(async (key) => key === 'cpm_compatibility_mode' ? 'true' : '');
            mockRisu.risuFetch.mockResolvedValue({
                status: 0,
                ok: false,
                data: null,
                headers: {},
            });

            await expect(smartFetch('https://api.example.com/v1/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'test', messages: [] }),
            })).rejects.toThrow(/Compatibility mode skipped nativeFetch/i);

            expect(mockRisu.nativeFetch).not.toHaveBeenCalled();
            expect(mockRisu.risuFetch).toHaveBeenCalledOnce();
        });
    });
});
