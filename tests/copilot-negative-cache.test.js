/**
 * @file copilot-negative-cache.test.js — Tests for copilot-token negative caching
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    ensureCopilotApiToken,
    getCopilotApiBase,
    clearCopilotTokenCache,
} from '../src/shared/copilot-token.js';

describe('copilot-token negative cache', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearCopilotTokenCache();
    });

    it('returns cached token when valid (warm cache path)', async () => {
        // Warm up the cache with a successful fetch
        const getArg = vi.fn().mockResolvedValue('gho_test123');
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ token: 'cached-tok', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        });
        const t1 = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t1).toBe('cached-tok');

        // Second call should return from cache without fetching
        const t2 = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t2).toBe('cached-tok');
        // fetchFn called only once (for initial warm-up)
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('returns empty for negative cache (no repeated fetches)', async () => {
        const getArg = vi.fn().mockResolvedValue('gho_test123');
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401 });
        // First call triggers negative cache
        const t1 = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t1).toBe('');
        // Second call should hit negative cache without fetching
        const t2 = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t2).toBe('');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('retries after negative cache expires', async () => {
        const getArg = vi.fn().mockResolvedValue('gho_test123');
        // First call: failure
        const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
        const t1 = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t1).toBe('');

        // Manually clear cache to simulate expiry
        clearCopilotTokenCache();

        // Second call: success
        fetchFn.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ token: 'new-tok', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        });
        const t2 = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t2).toBe('new-tok');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('sets negative cache on HTTP failure', async () => {
        const getArg = vi.fn().mockResolvedValue('gho_test123');
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401 });
        const t = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t).toBe('');
        // Immediately calling again should NOT fetch
        const fetchFn2 = vi.fn();
        const t2 = await ensureCopilotApiToken({ getArg, fetchFn: fetchFn2 });
        expect(t2).toBe('');
        expect(fetchFn2).not.toHaveBeenCalled();
    });

    it('sets negative cache on fetch exception', async () => {
        const getArg = vi.fn().mockResolvedValue('gho_test123');
        const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'));
        const t = await ensureCopilotApiToken({ getArg, fetchFn });
        expect(t).toBe('');
        // Immediately calling again should NOT fetch
        const fetchFn2 = vi.fn();
        const t2 = await ensureCopilotApiToken({ getArg, fetchFn: fetchFn2 });
        expect(t2).toBe('');
        expect(fetchFn2).not.toHaveBeenCalled();
    });

    it('returns empty when getArg is missing', async () => {
        const t = await ensureCopilotApiToken({});
        expect(t).toBe('');
    });
});

describe('getCopilotApiBase', () => {
    it('returns default base URL', () => {
        expect(getCopilotApiBase()).toBe('https://api.githubcopilot.com');
    });
});
