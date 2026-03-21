/**
 * @file tool-definitions.test.js — Tool definition registry tests
 * Covers: TOOL_*, getActiveToolList, getToolByName
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsToolEnabled = vi.fn().mockResolvedValue(false);
vi.mock('../src/shared/tool-config.js', () => ({
    isToolEnabled: (...a) => mockIsToolEnabled(...a),
}));

const {
    TOOL_DATETIME, TOOL_CALCULATE, TOOL_DICE, TOOL_WEB_SEARCH, TOOL_FETCH_URL,
    getActiveToolList, getToolByName,
} = await import('../src/shared/tool-definitions.js');

beforeEach(() => vi.clearAllMocks());

// ── Tool definition shapes ──
describe('tool definitions', () => {
    const allDefs = [TOOL_DATETIME, TOOL_CALCULATE, TOOL_DICE, TOOL_WEB_SEARCH, TOOL_FETCH_URL];

    it.each(allDefs.map(d => [d.name, d]))('%s has required MCP fields', (_name, def) => {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
        expect(def.inputSchema.properties).toBeDefined();
    });

    it('TOOL_DATETIME has timezone and locale properties', () => {
        expect(TOOL_DATETIME.inputSchema.properties.timezone).toBeDefined();
        expect(TOOL_DATETIME.inputSchema.properties.locale).toBeDefined();
    });

    it('TOOL_CALCULATE requires expression', () => {
        expect(TOOL_CALCULATE.inputSchema.required).toContain('expression');
    });

    it('TOOL_DICE notation is optional', () => {
        expect(TOOL_DICE.inputSchema.required).toEqual([]);
    });

    it('TOOL_WEB_SEARCH requires query', () => {
        expect(TOOL_WEB_SEARCH.inputSchema.required).toContain('query');
    });

    it('TOOL_FETCH_URL requires url', () => {
        expect(TOOL_FETCH_URL.inputSchema.required).toContain('url');
    });
});

// ── getActiveToolList ──
describe('getActiveToolList', () => {
    it('returns empty when all disabled', async () => {
        mockIsToolEnabled.mockResolvedValue(false);
        expect(await getActiveToolList()).toEqual([]);
    });

    it('returns only enabled tools', async () => {
        mockIsToolEnabled.mockImplementation(async (toolId) => {
            return toolId === 'datetime' || toolId === 'dice';
        });
        const active = await getActiveToolList();
        expect(active).toHaveLength(2);
        expect(active.map(t => t.name)).toContain('get_current_datetime');
        expect(active.map(t => t.name)).toContain('roll_dice');
    });

    it('returns all 5 tools when all enabled', async () => {
        mockIsToolEnabled.mockResolvedValue(true);
        const active = await getActiveToolList();
        expect(active).toHaveLength(5);
    });

    it('checks each tool ID', async () => {
        mockIsToolEnabled.mockResolvedValue(false);
        await getActiveToolList();
        const calledIds = mockIsToolEnabled.mock.calls.map(c => c[0]);
        expect(calledIds).toContain('datetime');
        expect(calledIds).toContain('calculator');
        expect(calledIds).toContain('dice');
        expect(calledIds).toContain('web_search');
        expect(calledIds).toContain('fetch_url');
    });
});

// ── getToolByName ──
describe('getToolByName', () => {
    it('finds get_current_datetime', () => {
        expect(getToolByName('get_current_datetime')).toBe(TOOL_DATETIME);
    });
    it('finds calculate', () => {
        expect(getToolByName('calculate')).toBe(TOOL_CALCULATE);
    });
    it('finds roll_dice', () => {
        expect(getToolByName('roll_dice')).toBe(TOOL_DICE);
    });
    it('finds web_search', () => {
        expect(getToolByName('web_search')).toBe(TOOL_WEB_SEARCH);
    });
    it('finds fetch_url', () => {
        expect(getToolByName('fetch_url')).toBe(TOOL_FETCH_URL);
    });
    it('returns null for unknown tool', () => {
        expect(getToolByName('unknown_tool')).toBeNull();
    });
    it('returns null for empty string', () => {
        expect(getToolByName('')).toBeNull();
    });
});
