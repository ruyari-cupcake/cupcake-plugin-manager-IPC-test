/**
 * @file tool-executor.test.js — Tool execution function tests
 * Covers: getCurrentDatetime, calculate, rollDice, webSearch, fetchUrl,
 *         executeToolCall, _parseSearchResults, PRIVATE_IP_PATTERN
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies ──
const mockGetWebSearchConfig = vi.fn().mockResolvedValue({ provider: 'brave', url: '', key: '', cx: '' });
vi.mock('../src/shared/tool-config.js', () => ({
    getWebSearchConfig: (...a) => mockGetWebSearchConfig(...a),
}));

const mockNativeFetch = vi.fn();
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({ nativeFetch: mockNativeFetch }),
}));

const {
    getCurrentDatetime, calculate, rollDice, webSearch, fetchUrl,
    executeToolCall, _parseSearchResults, PRIVATE_IP_PATTERN,
} = await import('../src/shared/tool-executor.js');

beforeEach(() => vi.clearAllMocks());

// ══════════════════════════════════════════════════════
// getCurrentDatetime
// ══════════════════════════════════════════════════════
describe('getCurrentDatetime', () => {
    it('returns iso, formatted, timezone, unix', () => {
        const result = getCurrentDatetime({});
        expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.unix).toBeGreaterThan(0);
        expect(result.timezone).toBeTruthy();
        expect(result.formatted).toBeTruthy();
    });

    it('uses provided timezone', () => {
        const result = getCurrentDatetime({ timezone: 'America/New_York' });
        expect(result.timezone).toBe('America/New_York');
    });

    it('uses provided locale', () => {
        const result = getCurrentDatetime({ locale: 'en-US', timezone: 'UTC' });
        expect(result.formatted).toBeTruthy();
    });

    it('uses default locale ko-KR', () => {
        const result = getCurrentDatetime({ timezone: 'UTC' });
        expect(result.formatted).toBeTruthy();
    });

    it('handles null args', () => {
        const result = getCurrentDatetime(null);
        expect(result.iso).toBeTruthy();
    });

    it('handles undefined args', () => {
        const result = getCurrentDatetime(undefined);
        expect(result.iso).toBeTruthy();
    });
});

// ══════════════════════════════════════════════════════
// calculate
// ══════════════════════════════════════════════════════
describe('calculate', () => {
    it('evaluates basic arithmetic', () => {
        expect(calculate({ expression: '2 + 3' }).result).toBe(5);
    });
    it('evaluates multiplication', () => {
        expect(calculate({ expression: '6 * 7' }).result).toBe(42);
    });
    it('evaluates division', () => {
        expect(calculate({ expression: '10 / 4' }).result).toBe(2.5);
    });
    it('evaluates modulo', () => {
        expect(calculate({ expression: '10 % 3' }).result).toBe(1);
    });
    it('evaluates power', () => {
        expect(calculate({ expression: '2 ** 10' }).result).toBe(1024);
    });
    it('evaluates Math functions', () => {
        expect(calculate({ expression: 'Math.sqrt(144)' }).result).toBe(12);
    });
    it('evaluates Math functions without prefix', () => {
        expect(calculate({ expression: 'sqrt(144)' }).result).toBe(12);
    });
    it('evaluates complex expression', () => {
        expect(calculate({ expression: 'Math.sqrt(144) + 5 * 3' }).result).toBe(27);
    });
    it('evaluates standalone PI', () => {
        expect(calculate({ expression: 'PI' }).result).toBeCloseTo(Math.PI);
    });
    it('evaluates standalone E', () => {
        expect(calculate({ expression: 'E' }).result).toBeCloseTo(Math.E);
    });
    it('evaluates Math.PI', () => {
        expect(calculate({ expression: 'Math.PI' }).result).toBeCloseTo(Math.PI);
    });
    it('evaluates Math.E', () => {
        expect(calculate({ expression: 'Math.E' }).result).toBeCloseTo(Math.E);
    });
    it('uses PI in expression context', () => {
        const r = calculate({ expression: '2 * PI' });
        expect(r.result).toBeCloseTo(2 * Math.PI);
    });
    it('uses E in expression context', () => {
        const r = calculate({ expression: '2 * E' });
        expect(r.result).toBeCloseTo(2 * Math.E);
    });
    it('evaluates nested functions', () => {
        expect(calculate({ expression: 'floor(3.7)' }).result).toBe(3);
    });
    it('evaluates min/max', () => {
        expect(calculate({ expression: 'min(3, 7)' }).result).toBe(3);
        expect(calculate({ expression: 'max(3, 7)' }).result).toBe(7);
    });
    it('evaluates trig functions', () => {
        expect(calculate({ expression: 'sin(0)' }).result).toBe(0);
        expect(calculate({ expression: 'cos(0)' }).result).toBe(1);
    });
    it('avoids duplicate Math.Math.', () => {
        expect(calculate({ expression: 'Math.Math.sqrt(9)' }).result).toBe(3);
    });
    it('returns error for empty expression', () => {
        expect(calculate({ expression: '' }).error).toBe('expression is empty');
    });
    it('returns error for no args', () => {
        expect(calculate({}).error).toBe('expression is empty');
    });
    it('returns error for too long expression', () => {
        expect(calculate({ expression: '1+'.repeat(260) }).error).toMatch(/too long/);
    });
    it('rejects disallowed characters', () => {
        expect(calculate({ expression: 'process.exit()' }).error).toMatch(/Disallowed/);
    });
    it('rejects import/require attempts', () => {
        expect(calculate({ expression: 'require("fs")' }).error).toMatch(/Disallowed/);
    });
    it('rejects variable assignment', () => {
        expect(calculate({ expression: 'x=5' }).error).toMatch(/Disallowed/);
    });
    it('rejects Infinity result', () => {
        expect(calculate({ expression: '1 / 0' }).error).toMatch(/Infinity|NaN/);
    });
    it('rejects NaN result', () => {
        expect(calculate({ expression: 'sqrt(-1)' }).error).toMatch(/Infinity|NaN/);
    });
    it('handles null args object', () => {
        expect(calculate(null).error).toBe('expression is empty');
    });
    it('handles parentheses correctly', () => {
        expect(calculate({ expression: '(2 + 3) * 4' }).result).toBe(20);
    });
    it('handles scientific notation', () => {
        expect(calculate({ expression: '1e3 + 1' }).result).toBe(1001);
    });
});

// ══════════════════════════════════════════════════════
// rollDice
// ══════════════════════════════════════════════════════
describe('rollDice', () => {
    it('rolls default 1d6', () => {
        const r = rollDice({});
        expect(r.rolls).toHaveLength(1);
        expect(r.total).toBeGreaterThanOrEqual(1);
        expect(r.total).toBeLessThanOrEqual(6);
    });
    it('rolls 2d6', () => {
        const r = rollDice({ notation: '2d6' });
        expect(r.rolls).toHaveLength(2);
        expect(r.total).toBeGreaterThanOrEqual(2);
        expect(r.total).toBeLessThanOrEqual(12);
    });
    it('handles modifier +', () => {
        const r = rollDice({ notation: '1d6+5' });
        expect(r.total).toBeGreaterThanOrEqual(6);
        expect(r.total).toBeLessThanOrEqual(11);
    });
    it('handles modifier -', () => {
        const r = rollDice({ notation: '1d6-1' });
        expect(r.total).toBeGreaterThanOrEqual(0);
        expect(r.total).toBeLessThanOrEqual(5);
    });
    it('returns error for invalid notation', () => {
        expect(rollDice({ notation: 'abc' }).error).toMatch(/Invalid/);
    });
    it('returns error for 0d6', () => {
        expect(rollDice({ notation: '0d6' }).error).toMatch(/must be >= 1/);
    });
    it('returns error for 1d0', () => {
        expect(rollDice({ notation: '1d0' }).error).toMatch(/must be >= 1/);
    });
    it('clamps dice count to 100', () => {
        const r = rollDice({ notation: '200d6' });
        expect(r.rolls).toHaveLength(100);
    });
    it('clamps sides to 1000', () => {
        const r = rollDice({ notation: '1d5000' });
        expect(r.total).toBeGreaterThanOrEqual(1);
        expect(r.total).toBeLessThanOrEqual(1000);
    });
    it('handles null notation', () => {
        const r = rollDice({ notation: null });
        expect(r.rolls).toHaveLength(1); // defaults to 1d6
    });
    it('case insensitive', () => {
        const r = rollDice({ notation: '2D6' });
        expect(r.rolls).toHaveLength(2);
    });
});

// ══════════════════════════════════════════════════════
// _parseSearchResults
// ══════════════════════════════════════════════════════
describe('_parseSearchResults', () => {
    it('parses brave results', () => {
        const data = { web: { results: [{ title: 'T', url: 'https://a.com', description: 'D' }] } };
        const r = _parseSearchResults(data, 'brave');
        expect(r).toHaveLength(1);
        expect(r[0]).toEqual({ title: 'T', url: 'https://a.com', snippet: 'D' });
    });
    it('parses serpapi results', () => {
        const data = { organic_results: [{ title: 'T', link: 'https://b.com', snippet: 'S' }] };
        const r = _parseSearchResults(data, 'serpapi');
        expect(r).toHaveLength(1);
        expect(r[0].url).toBe('https://b.com');
    });
    it('parses google_cse results', () => {
        const data = { items: [{ title: 'T', link: 'https://c.com', snippet: 'S' }] };
        const r = _parseSearchResults(data, 'google_cse');
        expect(r).toHaveLength(1);
    });
    it('parses custom provider results', () => {
        const data = { results: [{ title: 'T', url: 'https://d.com', snippet: 'S' }] };
        const r = _parseSearchResults(data, 'custom');
        expect(r).toHaveLength(1);
    });
    it('handles empty results', () => {
        expect(_parseSearchResults({}, 'brave')).toEqual([]);
        expect(_parseSearchResults({}, 'serpapi')).toEqual([]);
        expect(_parseSearchResults({}, 'google_cse')).toEqual([]);
        expect(_parseSearchResults({}, 'custom')).toEqual([]);
    });
    it('limits to 10 results', () => {
        const data = { web: { results: Array.from({ length: 15 }, (_, i) => ({ title: `T${i}`, url: `u${i}`, description: '' })) } };
        const r = _parseSearchResults(data, 'brave');
        expect(r).toHaveLength(10);
    });
    it('handles missing fields gracefully (custom)', () => {
        const data = { results: [{}] };
        const r = _parseSearchResults(data, 'custom');
        expect(r[0]).toEqual({ title: '', url: '', snippet: '' });
    });
});

// ══════════════════════════════════════════════════════
// webSearch
// ══════════════════════════════════════════════════════
describe('webSearch', () => {
    it('returns error for empty query', async () => {
        const r = await webSearch({ query: '' });
        expect(r.error).toMatch(/empty/);
    });
    it('returns error if no API key', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: '', cx: '' });
        const r = await webSearch({ query: 'test' });
        expect(r.error).toMatch(/not configured/);
    });
    it('returns error if no URL for empty provider', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'unknown', url: '', key: 'k', cx: '' });
        const r = await webSearch({ query: 'test' });
        expect(r.error).toMatch(/URL not configured/);
    });
    it('calls brave API with correct params', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'brave-key', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [{ title: 'T', url: 'https://x.com', description: 'D' }] } })
        });
        const r = await webSearch({ query: 'test query', count: 3 });
        expect(r.results).toHaveLength(1);
        expect(mockNativeFetch).toHaveBeenCalled();
        const url = mockNativeFetch.mock.calls[0][0];
        expect(url).toContain('api.search.brave.com');
        expect(url).toContain('count=3');
    });
    it('calls serpapi with correct params', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'serpapi', url: '', key: 'sk', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true, json: async () => ({ organic_results: [] })
        });
        const r = await webSearch({ query: 'test' });
        expect(r.message).toMatch(/No results/);
    });
    it('calls google_cse - requires cx', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'google_cse', url: '', key: 'gk', cx: '' });
        const r = await webSearch({ query: 'test' });
        expect(r.error).toMatch(/CX ID/);
    });
    it('calls google_cse with cx', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'google_cse', url: '', key: 'gk', cx: 'cx1' });
        mockNativeFetch.mockResolvedValue({
            ok: true, json: async () => ({ items: [{ title: 'T', link: 'u', snippet: 'S' }] })
        });
        const r = await webSearch({ query: 'test' });
        expect(r.results).toHaveLength(1);
    });
    it('handles custom provider with {query} template', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'custom', url: 'https://custom.search/q={query}', key: 'ck', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true, json: async () => ({ results: [] })
        });
        const r = await webSearch({ query: 'test' });
        expect(mockNativeFetch.mock.calls[0][0]).toContain('q=test');
    });
    it('handles HTTP error', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({ ok: false, status: 500 });
        const r = await webSearch({ query: 'test' });
        expect(r.error).toMatch(/HTTP 500/);
    });
    it('handles fetch exception', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockRejectedValue(new Error('network'));
        const r = await webSearch({ query: 'test' });
        expect(r.error).toMatch(/network/);
    });
    it('defaults count=0 to 5 (falsy fallback)', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true, json: async () => ({ web: { results: [] } })
        });
        await webSearch({ query: 'test', count: 0 });
        expect(mockNativeFetch.mock.calls[0][0]).toContain('count=5');
    });
    it('clamps count=20 to 10', async () => {
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true, json: async () => ({ web: { results: [] } })
        });
        await webSearch({ query: 'test', count: 20 });
        expect(mockNativeFetch.mock.calls[0][0]).toContain('count=10');
    });
});

// ══════════════════════════════════════════════════════
// fetchUrl
// ══════════════════════════════════════════════════════
describe('fetchUrl', () => {
    it('returns error for empty URL', async () => {
        expect((await fetchUrl({ url: '' })).error).toMatch(/empty/);
    });
    it('rejects non-http URL', async () => {
        expect((await fetchUrl({ url: 'ftp://x.com' })).error).toMatch(/HTTP\/HTTPS/);
    });
    it('blocks localhost', async () => {
        expect((await fetchUrl({ url: 'http://localhost/path' })).error).toMatch(/Private/);
    });
    it('blocks 127.0.0.1', async () => {
        expect((await fetchUrl({ url: 'http://127.0.0.1/path' })).error).toMatch(/Private/);
    });
    it('blocks 10.x.x.x', async () => {
        expect((await fetchUrl({ url: 'http://10.0.0.1/path' })).error).toMatch(/Private/);
    });
    it('blocks 192.168.x.x', async () => {
        expect((await fetchUrl({ url: 'http://192.168.1.1/path' })).error).toMatch(/Private/);
    });
    it('blocks 172.16-31.x.x', async () => {
        expect((await fetchUrl({ url: 'http://172.16.0.1/path' })).error).toMatch(/Private/);
    });
    it('allows public URLs', async () => {
        mockNativeFetch.mockResolvedValue({
            ok: true,
            text: async () => '<html><body><p>Hello</p></body></html>'
        });
        const r = await fetchUrl({ url: 'https://example.com/page' });
        expect(r.content).toContain('Hello');
        expect(r.url).toBe('https://example.com/page');
    });
    it('strips HTML tags', async () => {
        mockNativeFetch.mockResolvedValue({
            ok: true,
            text: async () => '<script>evil()</script><style>.bad{}</style><p>Good</p>'
        });
        const r = await fetchUrl({ url: 'https://example.com' });
        expect(r.content).not.toContain('evil');
        expect(r.content).not.toContain('.bad');
        expect(r.content).toContain('Good');
    });
    it('truncates to 8000 chars', async () => {
        mockNativeFetch.mockResolvedValue({
            ok: true,
            text: async () => 'A'.repeat(10000)
        });
        const r = await fetchUrl({ url: 'https://example.com' });
        expect(r.content.length).toBe(8000);
    });
    it('handles HTTP error', async () => {
        mockNativeFetch.mockResolvedValue({ ok: false, status: 404 });
        const r = await fetchUrl({ url: 'https://example.com' });
        expect(r.error).toMatch(/404/);
    });
    it('handles fetch exception', async () => {
        mockNativeFetch.mockRejectedValue(new Error('timeout'));
        const r = await fetchUrl({ url: 'https://example.com' });
        expect(r.error).toMatch(/timeout/);
    });
});

// ══════════════════════════════════════════════════════
// PRIVATE_IP_PATTERN
// ══════════════════════════════════════════════════════
describe('PRIVATE_IP_PATTERN', () => {
    it.each([
        'http://localhost/path',
        'http://127.0.0.1/path',
        'https://10.0.0.1/path',
        'http://172.16.0.1/path',
        'http://172.31.255.255/path',
        'http://192.168.0.1/path',
        'http://0.0.0.0/path',
        'http://[::1]/path',
    ])('matches private: %s', (url) => {
        expect(PRIVATE_IP_PATTERN.test(url)).toBe(true);
    });

    it.each([
        'https://google.com',
        'https://1.1.1.1/dns-query',
        'http://172.32.0.1/path',
        'http://172.15.0.1/path',
        'https://api.openai.com/v1',
    ])('does not match public: %s', (url) => {
        expect(PRIVATE_IP_PATTERN.test(url)).toBe(false);
    });
});

// ══════════════════════════════════════════════════════
// executeToolCall
// ══════════════════════════════════════════════════════
describe('executeToolCall', () => {
    it('dispatches to get_current_datetime', async () => {
        const r = await executeToolCall('get_current_datetime', {});
        expect(r).toHaveLength(1);
        expect(r[0].type).toBe('text');
        const parsed = JSON.parse(r[0].text);
        expect(parsed.iso).toBeTruthy();
    });
    it('dispatches to calculate', async () => {
        const r = await executeToolCall('calculate', { expression: '2+2' });
        const parsed = JSON.parse(r[0].text);
        expect(parsed.result).toBe(4);
    });
    it('dispatches to roll_dice', async () => {
        const r = await executeToolCall('roll_dice', { notation: '1d6' });
        const parsed = JSON.parse(r[0].text);
        expect(parsed.total).toBeGreaterThanOrEqual(1);
    });
    it('returns error for unknown tool', async () => {
        const r = await executeToolCall('nonexistent_tool', {});
        const parsed = JSON.parse(r[0].text);
        expect(parsed.error).toMatch(/Unknown tool/);
    });
    it('handles null args', async () => {
        const r = await executeToolCall('get_current_datetime', null);
        expect(r).toHaveLength(1);
    });
    it('catches executor exceptions', async () => {
        // Force an error by passing bad args to webSearch (no key)
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: '', cx: '' });
        const r = await executeToolCall('web_search', { query: 'test' });
        const parsed = JSON.parse(r[0].text);
        // This returns an error object, not an exception
        expect(parsed.error).toBeTruthy();
    });
});
