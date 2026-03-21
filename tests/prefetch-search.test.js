/**
 * @file prefetch-search.test.js — Tests for prefetch web search injection
 * Covers: isPrefetchSearchEnabled, extractUserQuery, shouldTriggerPrefetch,
 *         formatSearchBlock, injectPrefetchSearch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ──
const mockSafeGetArg = vi.fn().mockResolvedValue('');
const mockSafeGetBoolArg = vi.fn().mockResolvedValue(false);
const mockGetWebSearchConfig = vi.fn().mockResolvedValue({ provider: 'brave', url: '', key: '', cx: '' });
const mockNativeFetch = vi.fn();
const mockParseSearchResults = vi.fn().mockReturnValue([]);

vi.mock('../src/shared/helpers.js', () => ({
    safeGetArg: (...a) => mockSafeGetArg(...a),
    safeGetBoolArg: (...a) => mockSafeGetBoolArg(...a),
}));
vi.mock('../src/shared/tool-config.js', () => ({
    getWebSearchConfig: (...a) => mockGetWebSearchConfig(...a),
}));
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({ nativeFetch: mockNativeFetch }),
}));
vi.mock('../src/shared/tool-executor.js', () => ({
    _parseSearchResults: (...a) => mockParseSearchResults(...a),
}));

const {
    isPrefetchSearchEnabled, extractUserQuery, shouldTriggerPrefetch,
    formatSearchBlock, injectPrefetchSearch,
} = await import('../src/shared/prefetch-search.js');

beforeEach(() => {
    vi.clearAllMocks();
    mockSafeGetArg.mockResolvedValue('');
    mockSafeGetBoolArg.mockResolvedValue(false);
});

// ══════════════════════════════════════════════════
// isPrefetchSearchEnabled
// ══════════════════════════════════════════════════
describe('isPrefetchSearchEnabled', () => {
    it('returns false by default', async () => {
        mockSafeGetBoolArg.mockResolvedValue(false);
        expect(await isPrefetchSearchEnabled()).toBe(false);
    });
    it('returns true when enabled', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        expect(await isPrefetchSearchEnabled()).toBe(true);
    });
});

// ══════════════════════════════════════════════════
// extractUserQuery
// ══════════════════════════════════════════════════
describe('extractUserQuery', () => {
    it('extracts last user string message', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: '  latest question  ' },
        ];
        expect(extractUserQuery(msgs)).toBe('latest question');
    });
    it('handles array content (multimodal)', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'image_url', url: 'x' }, { type: 'text', text: 'describe this' }] },
        ];
        expect(extractUserQuery(msgs)).toBe('describe this');
    });
    it('returns empty when no user messages', () => {
        expect(extractUserQuery([{ role: 'system', content: 'hi' }])).toBe('');
    });
    it('returns empty for empty messages', () => {
        expect(extractUserQuery([])).toBe('');
    });
    it('handles user with empty content', () => {
        expect(extractUserQuery([{ role: 'user', content: '' }])).toBe('');
    });
    it('handles array content without text part', () => {
        const msgs = [{ role: 'user', content: [{ type: 'image_url' }] }];
        expect(extractUserQuery(msgs)).toBe('');
    });
});

// ══════════════════════════════════════════════════
// shouldTriggerPrefetch
// ══════════════════════════════════════════════════
describe('shouldTriggerPrefetch', () => {
    it('returns true when no keywords set', async () => {
        mockSafeGetArg.mockResolvedValue('');
        expect(await shouldTriggerPrefetch('anything')).toBe(true);
    });
    it('returns true when keyword matches', async () => {
        mockSafeGetArg.mockResolvedValue('search,find');
        expect(await shouldTriggerPrefetch('please search for cats')).toBe(true);
    });
    it('returns false when no keyword matches', async () => {
        mockSafeGetArg.mockResolvedValue('search,find');
        expect(await shouldTriggerPrefetch('hello world')).toBe(false);
    });
    it('is case insensitive', async () => {
        mockSafeGetArg.mockResolvedValue('SEARCH');
        expect(await shouldTriggerPrefetch('Search for stuff')).toBe(true);
    });
    it('handles whitespace in keywords', async () => {
        mockSafeGetArg.mockResolvedValue(' search , find , lookup ');
        expect(await shouldTriggerPrefetch('can you lookup this')).toBe(true);
    });
});

// ══════════════════════════════════════════════════
// formatSearchBlock
// ══════════════════════════════════════════════════
describe('formatSearchBlock', () => {
    const results = [
        { title: 'Title 1', url: 'https://a.com', snippet: 'Snippet 1' },
        { title: 'Title 2', url: 'https://b.com', snippet: 'Snippet 2' },
    ];
    it('formats full results with title, snippet, URL', () => {
        const block = formatSearchBlock(results, 'test query', false);
        expect(block).toContain('[Web Search Results for: "test query"]');
        expect(block).toContain('1. Title 1');
        expect(block).toContain('Snippet 1');
        expect(block).toContain('URL: https://a.com');
        expect(block).toContain('2. Title 2');
        expect(block).toContain('[End of Web Search Results]');
    });
    it('formats snippet-only mode', () => {
        const block = formatSearchBlock(results, 'test', true);
        expect(block).toContain('1. Snippet 1');
        expect(block).not.toContain('Title 1');
        expect(block).not.toContain('URL:');
    });
    it('returns empty for null results', () => {
        expect(formatSearchBlock(null, 'q', false)).toBe('');
    });
    it('returns empty for empty results', () => {
        expect(formatSearchBlock([], 'q', false)).toBe('');
    });
    it('skips empty snippets in snippet-only mode', () => {
        const block = formatSearchBlock([{ title: 'T', url: 'u', snippet: '' }], 'q', true);
        expect(block).toContain('[Web Search Results');
        expect(block).not.toContain('1.');
    });
});

// ══════════════════════════════════════════════════
// injectPrefetchSearch
// ══════════════════════════════════════════════════
describe('injectPrefetchSearch', () => {
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Tell me about cats' },
    ];

    it('returns original messages when disabled', async () => {
        mockSafeGetBoolArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_enabled') return Promise.resolve(false);
            return Promise.resolve(false);
        });
        const r = await injectPrefetchSearch(messages);
        expect(r.searched).toBe(false);
        expect(r.messages).toBe(messages); // same ref
    });

    it('returns original messages when no user query', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        const sysOnly = [{ role: 'system', content: 'sys' }];
        const r = await injectPrefetchSearch(sysOnly);
        expect(r.searched).toBe(false);
    });

    it('returns original messages when query too short', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        const short = [{ role: 'user', content: 'a' }];
        const r = await injectPrefetchSearch(short);
        expect(r.searched).toBe(false);
    });

    it('returns original messages when keyword trigger fails', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        mockSafeGetArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_keywords') return Promise.resolve('search,find');
            return Promise.resolve('');
        });
        const noKeyword = [{ role: 'user', content: 'hello world again' }];
        const r = await injectPrefetchSearch(noKeyword);
        expect(r.searched).toBe(false);
    });

    it('injects search results into system prompt (after)', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        mockSafeGetArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_keywords') return Promise.resolve('');
            if (key === 'cpm_prefetch_search_position') return Promise.resolve('after');
            if (key === 'cpm_prefetch_search_max_results') return Promise.resolve('3');
            return Promise.resolve('');
        });
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'brave-key', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [{ title: 'Cat', url: 'u', description: 'D' }] } })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'Cat', url: 'u', snippet: 'D' }]);

        const r = await injectPrefetchSearch(messages);
        expect(r.searched).toBe(true);
        expect(r.query).toBe('Tell me about cats');
        expect(r.messages[0].content).toContain('You are a helpful assistant.');
        expect(r.messages[0].content).toContain('[Web Search Results');
    });

    it('injects search results (before position)', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        mockSafeGetArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_keywords') return Promise.resolve('');
            if (key === 'cpm_prefetch_search_position') return Promise.resolve('before');
            if (key === 'cpm_prefetch_search_max_results') return Promise.resolve('3');
            return Promise.resolve('');
        });
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [{ title: 'T', url: 'u', description: 'D' }] } })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'D' }]);

        const r = await injectPrefetchSearch(messages);
        expect(r.searched).toBe(true);
        // "before" means search block comes first
        expect(r.messages[0].content.indexOf('[Web Search')).toBeLessThan(
            r.messages[0].content.indexOf('You are a helpful')
        );
    });

    it('adds system message when none exists', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        mockSafeGetArg.mockResolvedValue('');
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [{ title: 'T', url: 'u', description: 'D' }] } })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'D' }]);

        const noSys = [{ role: 'user', content: 'Tell me about dogs' }];
        const r = await injectPrefetchSearch(noSys);
        expect(r.searched).toBe(true);
        expect(r.messages[0].role).toBe('system');
        expect(r.messages[0].content).toContain('[Web Search Results');
    });

    it('does not mutate original messages array', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        mockSafeGetArg.mockResolvedValue('');
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [{ title: 'T', url: 'u', description: 'D' }] } })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'D' }]);

        const msgs = [
            { role: 'system', content: 'Original' },
            { role: 'user', content: 'Test query here' },
        ];
        const originalContent = msgs[0].content;
        const r = await injectPrefetchSearch(msgs);
        expect(msgs[0].content).toBe(originalContent); // not mutated
        expect(r.messages).not.toBe(msgs);
    });

    it('handles search failure gracefully', async () => {
        mockSafeGetBoolArg.mockResolvedValue(true);
        mockSafeGetArg.mockResolvedValue('');
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: '', cx: '' });

        const r = await injectPrefetchSearch(messages);
        expect(r.searched).toBe(false);
        expect(r.error).toBeTruthy();
    });
});

// ══════════════════════════════════════════════════
// doWebSearch provider branches (via injectPrefetchSearch)
// ══════════════════════════════════════════════════
describe('injectPrefetchSearch — provider branches', () => {
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test query provider' },
    ];

    function enablePrefetch() {
        mockSafeGetBoolArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_enabled') return Promise.resolve(true);
            if (key === 'cpm_prefetch_search_snippet_only') return Promise.resolve(false);
            return Promise.resolve(false);
        });
        mockSafeGetArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_keywords') return Promise.resolve('');
            if (key === 'cpm_prefetch_search_position') return Promise.resolve('after');
            if (key === 'cpm_prefetch_search_max_results') return Promise.resolve('3');
            return Promise.resolve('');
        });
    }

    it('uses serpapi URL format', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'serpapi', url: '', key: 'serp-key', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ organic_results: [{ title: 'T', link: 'u', snippet: 'S' }] })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'S' }]);

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(true);
        const url = mockNativeFetch.mock.calls[0][0];
        expect(url).toContain('serpapi.com');
        expect(url).toContain('api_key=serp-key');
    });

    it('uses google_cse URL format', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'google_cse', url: '', key: 'gk', cx: 'cx1' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ items: [{ title: 'T', link: 'u', snippet: 'S' }] })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'S' }]);

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(true);
        const url = mockNativeFetch.mock.calls[0][0];
        expect(url).toContain('googleapis.com');
        expect(url).toContain('cx=cx1');
    });

    it('google_cse fails without cx', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'google_cse', url: '', key: 'gk', cx: '' });

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(false);
        expect(r.error).toMatch(/CX/);
    });

    it('uses custom provider with {query} template', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'custom', url: 'https://my.search/q={query}', key: 'ck', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ title: 'T', url: 'u', snippet: 'S' }] })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'S' }]);

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(true);
        expect(mockNativeFetch.mock.calls[0][0]).toContain('q=test');
    });

    it('uses custom provider without {query} template', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'custom', url: 'https://my.search/api', key: 'ck', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ title: 'T', url: 'u', snippet: 'S' }] })
        });
        mockParseSearchResults.mockReturnValue([{ title: 'T', url: 'u', snippet: 'S' }]);

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(true);
        expect(mockNativeFetch.mock.calls[0][0]).toContain('my.search/api?q=');
    });

    it('handles HTTP error in search', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({ ok: false, status: 500 });

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(false);
        expect(r.error).toContain('500');
    });

    it('handles network exception in search', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockRejectedValue(new Error('DNS failure'));

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(false);
        expect(r.error).toContain('DNS failure');
    });

    it('handles empty search results', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'brave', url: '', key: 'k', cx: '' });
        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [] } })
        });
        mockParseSearchResults.mockReturnValue([]);

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(false);
    });

    it('provider with missing URL fails gracefully', async () => {
        enablePrefetch();
        mockGetWebSearchConfig.mockResolvedValue({ provider: 'unknown_no_preset', url: '', key: 'k', cx: '' });

        const r = await injectPrefetchSearch(msgs);
        expect(r.searched).toBe(false);
        expect(r.error).toMatch(/URL/);
    });
});
