/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createMockDoc(options = {}) {
    const appended = [];
    const existing = options.existing || null;
    const toast = {
        attrs: {},
        styles: {},
        innerHTML: '',
        listeners: {},
        removed: false,
        async setAttribute(name, value) { this.attrs[name] = value; },
        async setStyle(name, value) { this.styles[name] = value; },
        async setInnerHTML(value) { this.innerHTML = value; },
        async addEventListener(name, fn) { this.listeners[name] = fn; },
        async remove() { this.removed = true; },
    };
    const body = options.hasBody === false
        ? null
        : {
            children: appended,
            async appendChild(node) { appended.push(node); },
        };

    return {
        appended,
        toast,
        body,
        async createElement() { return toast; },
        async querySelector(selector) {
            if (selector === '[x-cpm-token-toast]') return existing;
            if (selector === 'body') return body;
            return null;
        },
    };
}

async function loadToastModule(docOrFactory) {
    vi.resetModules();
    const getRootDocument = vi.fn();
    if (typeof docOrFactory === 'function') getRootDocument.mockImplementation(docOrFactory);
    else getRootDocument.mockResolvedValue(docOrFactory);

    globalThis.window = { risuai: { getRootDocument } };

    const mod = await import('../src/shared/token-toast.js');
    return { ...mod, getRootDocument };
}

describe('showTokenUsageToast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.resetModules();
        delete globalThis.window;
    });

    it('returns early when usage is missing', async () => {
        const { showTokenUsageToast, getRootDocument } = await loadToastModule(createMockDoc());
        await showTokenUsageToast('model', null, 1000);
        expect(getRootDocument).not.toHaveBeenCalled();
    });

    it('returns early when root document is unavailable', async () => {
        const { showTokenUsageToast, getRootDocument } = await loadToastModule(null);
        await showTokenUsageToast('model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 1000);
        expect(getRootDocument).toHaveBeenCalledTimes(1);
    });

    it('removes an existing token toast before showing a new one', async () => {
        const existing = { remove: vi.fn().mockResolvedValue(undefined) };
        const doc = createMockDoc({ existing });
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast('gpt-5.4', { input: 10, output: 20, reasoning: 0, cached: 0, total: 30 }, 1200);

        expect(existing.remove).toHaveBeenCalledTimes(1);
        expect(doc.appended).toHaveLength(1);
    });

    it('builds toast html with truncated model, reasoning, cached tokens and duration', async () => {
        const doc = createMockDoc();
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast(
            'very-long-model-name-1234567890-abcdefghijklmnopqrstuvwxyz',
            { input: 1234, output: 5678, reasoning: 90, cached: 12, total: 7014, reasoningEstimated: true },
            2500,
        );

        expect(doc.toast.innerHTML).toContain('very-long-model-name-1234567890-');
        expect(doc.toast.innerHTML).toContain('...');
        expect(doc.toast.innerHTML).toContain('1,234');
        expect(doc.toast.innerHTML).toContain('5,678');
        expect(doc.toast.innerHTML).toContain('90');
        expect(doc.toast.innerHTML).toContain('12');
        expect(doc.toast.innerHTML).toContain('⏱️ 2.5s');
    });

    it('skips reasoning and cached sections when values are zero', async () => {
        const doc = createMockDoc();
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast('short-model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 0);

        expect(doc.toast.innerHTML).not.toContain('🗯');
        expect(doc.toast.innerHTML).not.toContain('💾');
        expect(doc.toast.innerHTML).not.toContain('⏱️');
    });

    it('animates the toast in shortly after append', async () => {
        const doc = createMockDoc();
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast('model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 0);
        expect(doc.toast.styles.opacity).toBe('0');
        expect(doc.toast.styles.transform).toBe('translateY(-8px)');

        await vi.advanceTimersByTimeAsync(30);

        expect(doc.toast.styles.opacity).toBe('1');
        expect(doc.toast.styles.transform).toBe('translateY(0)');
    });

    it('dismisses on click and removes the toast after animation', async () => {
        const doc = createMockDoc();
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast('model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 0);
        await doc.toast.listeners.click();

        expect(doc.toast.styles.opacity).toBe('0');
        expect(doc.toast.styles.transform).toBe('translateY(-8px)');

        await vi.advanceTimersByTimeAsync(300);

        expect(doc.toast.removed).toBe(true);
    });

    it('auto-dismisses after 6 seconds', async () => {
        const doc = createMockDoc();
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast('model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 0);

        await vi.advanceTimersByTimeAsync(6000);
        expect(doc.toast.styles.opacity).toBe('0');

        await vi.advanceTimersByTimeAsync(300);
        expect(doc.toast.removed).toBe(true);
    });

    it('returns without appending when body is missing', async () => {
        const doc = createMockDoc({ hasBody: false });
        const { showTokenUsageToast } = await loadToastModule(doc);

        await showTokenUsageToast('model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 0);

        expect(doc.appended).toHaveLength(0);
    });

    it('logs debug info when root document access throws', async () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const { showTokenUsageToast } = await loadToastModule(async () => {
            throw new Error('doc fail');
        });

        await showTokenUsageToast('model', { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 }, 0);

        expect(debugSpy).toHaveBeenCalledWith('[CPM TokenToast] Failed:', 'doc fail');
    });
});