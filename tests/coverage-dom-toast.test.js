/**
 * @file coverage-dom-toast.test.js — DOM 의존 코드 (token-toast, update-toast) 커버리지
 *
 * RisuAI DOM API (getRootDocument → querySelector, createElement, setStyle, setInnerHTML 등)
 * 를 mock하여 테스트.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock getRisu with async DOM ──
const _mockDoc = {
    querySelector: vi.fn(async () => null),
    createElement: vi.fn(async (tag) => ({
        setAttribute: vi.fn(async () => {}),
        setStyle: vi.fn(async () => {}),
        setInnerHTML: vi.fn(async () => {}),
        addEventListener: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        appendChild: vi.fn(async () => {}),
    })),
};
const _mockBody = {
    appendChild: vi.fn(async () => {}),
};

vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({
        getArgument: vi.fn(async () => ''),
        setArgument: vi.fn(),
        pluginStorage: {
            getItem: vi.fn(async () => null),
            setItem: vi.fn(async () => {}),
            removeItem: vi.fn(async () => {}),
        },
        getDatabase: vi.fn(async () => ({ plugins: [] })),
        risuFetch: vi.fn(async () => ({ data: null, status: 200 })),
        nativeFetch: vi.fn(async () => ({ ok: true, status: 200 })),
        registerPlugin: vi.fn(),
        getRootDocument: vi.fn(async () => _mockDoc),
    }),
    CH: { CONTROL: 'cpm-control' },
    MSG: {},
    safeUUID: () => 'test-uuid-dom',
    MANAGER_NAME: 'CPM',
}));

import { showTokenUsageToast } from '../src/shared/token-toast.js';
import { createUpdateToast } from '../src/shared/update-toast.js';
import { escHtml } from '../src/shared/helpers.js';
import { getRisu } from '../src/shared/ipc-protocol.js';

describe('showTokenUsageToast — DOM mock tests', () => {
    let createdToast;

    beforeEach(() => {
        vi.useFakeTimers();
        createdToast = {
            setAttribute: vi.fn(async () => {}),
            setStyle: vi.fn(async () => {}),
            setInnerHTML: vi.fn(async () => {}),
            addEventListener: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        };
        _mockDoc.createElement = vi.fn(async () => createdToast);
        _mockDoc.querySelector = vi.fn(async (sel) => {
            if (sel === 'body') return _mockBody;
            if (sel === '[x-cpm-token-toast]') return null;
            return null;
        });
    });

    it('creates toast with input/output tokens (L24, L31)', async () => {
        const usage = { input: 100, output: 200, reasoning: 0, cached: 0, total: 300 };
        await showTokenUsageToast('claude-3.5-sonnet', usage, 1234);

        expect(_mockDoc.createElement).toHaveBeenCalledWith('div');
        expect(createdToast.setInnerHTML).toHaveBeenCalled();
        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('📥');
        expect(html).toContain('📤');
    });

    it('shows reasoning tokens when > 0', async () => {
        const usage = { input: 100, output: 500, reasoning: 300, cached: 0, total: 600 };
        await showTokenUsageToast('claude-3.5-sonnet', usage);

        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('🗯');
    });

    it('shows estimated reasoning with ≈', async () => {
        const usage = { input: 100, output: 500, reasoning: 300, cached: 0, total: 600, reasoningEstimated: true };
        await showTokenUsageToast('claude-3.5-sonnet', usage);

        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('🗯≈');
    });

    it('shows cached tokens when > 0', async () => {
        const usage = { input: 100, output: 200, reasoning: 0, cached: 80, total: 300 };
        await showTokenUsageToast('claude-3.5-sonnet', usage);

        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('💾');
    });

    it('removes existing toast before creating new one', async () => {
        const existingToast = { remove: vi.fn(async () => {}) };
        _mockDoc.querySelector = vi.fn(async (sel) => {
            if (sel === 'body') return _mockBody;
            if (sel === '[x-cpm-token-toast]') return existingToast;
            return null;
        });

        const usage = { input: 100, output: 200, reasoning: 0, cached: 0, total: 300 };
        await showTokenUsageToast('claude-3.5-sonnet', usage);

        expect(existingToast.remove).toHaveBeenCalled();
    });

    it('truncates long model name', async () => {
        const usage = { input: 100, output: 200, reasoning: 0, cached: 0, total: 300 };
        await showTokenUsageToast('a'.repeat(50), usage);

        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('...');
    });

    it('skips when no usage', async () => {
        await showTokenUsageToast('model', null);
        expect(_mockDoc.createElement).not.toHaveBeenCalled();
    });

    it('skips when getRootDocument returns null', async () => {
        const Risu = getRisu();
        Risu.getRootDocument = vi.fn(async () => null);
        const usage = { input: 10, output: 20, reasoning: 0, cached: 0, total: 30 };
        await showTokenUsageToast('model', usage);
        // No crash
    });

    it('skips when body not found', async () => {
        _mockDoc.querySelector = vi.fn(async (sel) => {
            if (sel === '[x-cpm-token-toast]') return null;
            return null; // body not found
        });
        const usage = { input: 10, output: 20, reasoning: 0, cached: 0, total: 30 };
        await showTokenUsageToast('model', usage);
    });
});

describe('createUpdateToast — DOM mock tests', () => {
    let Risu;
    let createdToast;

    beforeEach(() => {
        vi.useFakeTimers();
        Risu = getRisu();
        createdToast = {
            setAttribute: vi.fn(async () => {}),
            setStyle: vi.fn(async () => {}),
            setInnerHTML: vi.fn(async () => {}),
            addEventListener: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        };
        _mockDoc.createElement = vi.fn(async () => createdToast);
        _mockDoc.querySelector = vi.fn(async (sel) => {
            if (sel === 'body') return _mockBody;
            if (sel === '[x-cpm-update-toast]') return null;
            return null;
        });
    });

    it('shows success toast (L157 dismiss path)', async () => {
        const toast = createUpdateToast({ Risu, escHtml });
        await toast.showMainAutoUpdateResult('1.0.0', '2.0.0', 'Bug fixes', true);

        expect(_mockDoc.createElement).toHaveBeenCalledWith('div');
        expect(createdToast.setInnerHTML).toHaveBeenCalled();
        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('2.0.0');
    });

    it('shows failure toast', async () => {
        const toast = createUpdateToast({ Risu, escHtml });
        await toast.showMainAutoUpdateResult('1.0.0', '2.0.0', '', false);

        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('실패'); // failure message
    });

    it('removes existing toast before showing new', async () => {
        const existing = { remove: vi.fn(async () => {}) };
        _mockDoc.querySelector = vi.fn(async (sel) => {
            if (sel === 'body') return _mockBody;
            if (sel === '[x-cpm-main-toast]') return existing;
            if (sel === '[x-cpm-toast]') return null;
            return null;
        });

        const toast = createUpdateToast({ Risu, escHtml });
        await toast.showMainAutoUpdateResult('1.0.0', '2.0.0', '', true);
        expect(existing.remove).toHaveBeenCalled();
    });

    it('handles body not found', async () => {
        _mockDoc.querySelector = vi.fn(async () => null);
        const toast = createUpdateToast({ Risu, escHtml });
        await toast.showMainAutoUpdateResult('1.0.0', '2.0.0', '', true);
        // No crash
    });

    it('handles success with changes text', async () => {
        const toast = createUpdateToast({ Risu, escHtml });
        await toast.showMainAutoUpdateResult('1.0.0', '2.0.0', 'Fixed important bug\nNew feature', true);

        const html = createdToast.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('Fixed important bug');
    });
});
