/**
 * @file tool-config.test.js — Tool-Use configuration loader tests
 * Covers: isToolUseEnabled, isToolEnabled, getToolMaxDepth, getToolTimeout, getWebSearchConfig
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock helpers.js ──
const mockGetArg = vi.fn().mockResolvedValue('');
const mockGetBoolArg = vi.fn().mockResolvedValue(false);

vi.mock('../src/shared/helpers.js', () => ({
    safeGetArg: (...a) => mockGetArg(...a),
    safeGetBoolArg: (...a) => mockGetBoolArg(...a),
}));

const { isToolUseEnabled, isToolEnabled, getToolMaxDepth, getToolTimeout, getWebSearchConfig } = await import('../src/shared/tool-config.js');

beforeEach(() => {
    vi.clearAllMocks();
});

// ── isToolUseEnabled ──
describe('isToolUseEnabled', () => {
    it('returns false by default', async () => {
        mockGetBoolArg.mockResolvedValue(false);
        expect(await isToolUseEnabled()).toBe(false);
    });
    it('returns true when enabled', async () => {
        mockGetBoolArg.mockResolvedValue(true);
        expect(await isToolUseEnabled()).toBe(true);
    });
    it('calls safeGetBoolArg with correct key', async () => {
        await isToolUseEnabled();
        expect(mockGetBoolArg).toHaveBeenCalledWith('cpm_tool_use_enabled', false);
    });
});

// ── isToolEnabled ──
describe('isToolEnabled', () => {
    it('returns false if tool-use is globally disabled', async () => {
        mockGetBoolArg.mockResolvedValue(false);
        expect(await isToolEnabled('datetime')).toBe(false);
    });
    it('returns true for specific tool when globally enabled', async () => {
        mockGetBoolArg.mockImplementation(async (key) => {
            if (key === 'cpm_tool_use_enabled') return true;
            if (key === 'cpm_tool_datetime') return true;
            return false;
        });
        expect(await isToolEnabled('datetime')).toBe(true);
    });
    it('returns false for disabled specific tool even when globally enabled', async () => {
        mockGetBoolArg.mockImplementation(async (key) => {
            if (key === 'cpm_tool_use_enabled') return true;
            if (key === 'cpm_tool_calculator') return false;
            return false;
        });
        expect(await isToolEnabled('calculator')).toBe(false);
    });
});

// ── getToolMaxDepth ──
describe('getToolMaxDepth', () => {
    it('returns default 5 when empty', async () => {
        mockGetArg.mockResolvedValue('');
        expect(await getToolMaxDepth()).toBe(5);
    });
    it('parses valid integer', async () => {
        mockGetArg.mockResolvedValue('10');
        expect(await getToolMaxDepth()).toBe(10);
    });
    it('clamps to max 20', async () => {
        mockGetArg.mockResolvedValue('50');
        expect(await getToolMaxDepth()).toBe(20);
    });
    it('returns default for 0', async () => {
        mockGetArg.mockResolvedValue('0');
        expect(await getToolMaxDepth()).toBe(5);
    });
    it('returns default for negative', async () => {
        mockGetArg.mockResolvedValue('-3');
        expect(await getToolMaxDepth()).toBe(5);
    });
    it('returns default for NaN', async () => {
        mockGetArg.mockResolvedValue('abc');
        expect(await getToolMaxDepth()).toBe(5);
    });
    it('returns 1 as minimum valid depth', async () => {
        mockGetArg.mockResolvedValue('1');
        expect(await getToolMaxDepth()).toBe(1);
    });
});

// ── getToolTimeout ──
describe('getToolTimeout', () => {
    it('returns default 10000 when empty', async () => {
        mockGetArg.mockResolvedValue('');
        expect(await getToolTimeout()).toBe(10000);
    });
    it('parses valid timeout', async () => {
        mockGetArg.mockResolvedValue('5000');
        expect(await getToolTimeout()).toBe(5000);
    });
    it('clamps to max 60000', async () => {
        mockGetArg.mockResolvedValue('120000');
        expect(await getToolTimeout()).toBe(60000);
    });
    it('returns default for non-positive', async () => {
        mockGetArg.mockResolvedValue('0');
        expect(await getToolTimeout()).toBe(10000);
    });
    it('returns default for NaN', async () => {
        mockGetArg.mockResolvedValue('invalid');
        expect(await getToolTimeout()).toBe(10000);
    });
});

// ── getWebSearchConfig ──
describe('getWebSearchConfig', () => {
    it('returns defaults when all empty', async () => {
        mockGetArg.mockResolvedValue('');
        const cfg = await getWebSearchConfig();
        expect(cfg.provider).toBe('brave');
        expect(cfg.url).toBe('');
        expect(cfg.key).toBe('');
        expect(cfg.cx).toBe('');
    });
    it('returns configured values', async () => {
        mockGetArg.mockImplementation(async (key) => {
            const map = {
                cpm_tool_websearch_provider: 'google_cse',
                cpm_tool_websearch_url: 'https://custom.search/',
                cpm_tool_websearch_key: 'my-key-123',
                cpm_tool_websearch_cx: 'cx-456',
            };
            return map[key] || '';
        });
        const cfg = await getWebSearchConfig();
        expect(cfg.provider).toBe('google_cse');
        expect(cfg.url).toBe('https://custom.search/');
        expect(cfg.key).toBe('my-key-123');
        expect(cfg.cx).toBe('cx-456');
    });
});
