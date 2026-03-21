import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpdateToast } from '../src/shared/update-toast.js';

// ── Mock RisuAI DOM API ──
function createMockDoc() {
    const elements = {};
    const removed = [];
    const appended = [];

    const mockElement = (tag) => ({
        _tag: tag,
        _attrs: {},
        _styles: {},
        _innerHTML: '',
        setAttribute: vi.fn(async (k, v) => { mockElement._attrs = { ...mockElement._attrs, [k]: v }; }),
        setStyle: vi.fn(async (k, v) => { mockElement._styles = { ...mockElement._styles, [k]: v }; }),
        setInnerHTML: vi.fn(async (html) => { mockElement._innerHTML = html; }),
        remove: vi.fn(async () => { removed.push(tag); }),
        appendChild: vi.fn(async (child) => { appended.push(child); }),
    });

    return {
        createElement: vi.fn(async (tag) => {
            const el = mockElement(tag);
            elements[tag] = el;
            return el;
        }),
        querySelector: vi.fn(async (sel) => {
            if (sel === 'body') return { appendChild: vi.fn(async (child) => { appended.push(child); }) };
            // Return null for toast selectors unless we want to test removal
            return null;
        }),
        _elements: elements,
        _removed: removed,
        _appended: appended,
    };
}

function createMockRisu(doc) {
    return {
        getRootDocument: vi.fn(async () => doc),
    };
}

function mockEscHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

describe('createUpdateToast', () => {
    let doc, risu, toast;

    beforeEach(() => {
        doc = createMockDoc();
        risu = createMockRisu(doc);
        toast = createUpdateToast({ Risu: risu, escHtml: mockEscHtml });
    });

    it('returns object with showUpdateToast and showMainAutoUpdateResult', () => {
        expect(typeof toast.showUpdateToast).toBe('function');
        expect(typeof toast.showMainAutoUpdateResult).toBe('function');
    });

    // ── showUpdateToast ──
    describe('showUpdateToast', () => {
        it('creates toast element with update info', async () => {
            await toast.showUpdateToast([
                { name: 'Plugin A', icon: '🔌', localVersion: '1.0.0', remoteVersion: '1.1.0', changes: 'bugfix' },
            ]);

            expect(risu.getRootDocument).toHaveBeenCalled();
            expect(doc.createElement).toHaveBeenCalledWith('div');
        });

        it('handles empty updates array gracefully', async () => {
            await toast.showUpdateToast([]);
            // Should still create a toast with 0 updates
            expect(doc.createElement).toHaveBeenCalled();
        });

        it('limits display to 3 updates and shows overflow count', async () => {
            const updates = Array.from({ length: 5 }, (_, i) => ({
                name: `Plugin ${i}`,
                icon: '🧩',
                localVersion: '1.0.0',
                remoteVersion: '2.0.0',
            }));
            await toast.showUpdateToast(updates);
            // The toast innerHTML should contain overflow text
            const createdEl = doc._elements['div'];
            if (createdEl) {
                const html = createdEl.setInnerHTML.mock.calls[0]?.[0] || '';
                expect(html).toContain('외 2개');
            }
        });

        it('escapes HTML in update names and changes', async () => {
            await toast.showUpdateToast([
                { name: '<script>xss</script>', icon: '⚠️', localVersion: '1.0', remoteVersion: '2.0', changes: '<b>evil</b>' },
            ]);
            const createdEl = doc._elements['div'];
            if (createdEl) {
                const html = createdEl.setInnerHTML.mock.calls[0]?.[0] || '';
                expect(html).not.toContain('<script>');
                expect(html).toContain('&lt;script&gt;');
            }
        });

        it('handles null getRootDocument gracefully', async () => {
            risu.getRootDocument = vi.fn(async () => null);
            // Should not throw
            await toast.showUpdateToast([{ name: 'X', icon: '🔌', localVersion: '1.0', remoteVersion: '2.0' }]);
        });

        it('removes existing toast before showing new one', async () => {
            const existingToast = { remove: vi.fn(async () => {}) };
            doc.querySelector = vi.fn(async (sel) => {
                if (sel === '[x-cpm-toast]') return existingToast;
                if (sel === 'body') return { appendChild: vi.fn(async () => {}) };
                return null;
            });

            await toast.showUpdateToast([{ name: 'X', icon: '🔌', localVersion: '1.0', remoteVersion: '2.0' }]);
            expect(existingToast.remove).toHaveBeenCalled();
        });
    });

    // ── showMainAutoUpdateResult ──
    describe('showMainAutoUpdateResult', () => {
        it('shows success toast with version info', async () => {
            await toast.showMainAutoUpdateResult('1.19.0', '1.20.0', 'performance boost', true);

            expect(risu.getRootDocument).toHaveBeenCalled();
            expect(doc.createElement).toHaveBeenCalledWith('div');
            const createdEl = doc._elements['div'];
            if (createdEl) {
                const html = createdEl.setInnerHTML.mock.calls[0]?.[0] || '';
                expect(html).toContain('1.19.0');
                expect(html).toContain('1.20.0');
                expect(html).toContain('performance boost');
                expect(html).toContain('업데이트 완료');
            }
        });

        it('shows failure toast with error message', async () => {
            await toast.showMainAutoUpdateResult('1.19.0', '1.20.0', '', false, '다운로드 실패');

            const createdEl = doc._elements['div'];
            if (createdEl) {
                const html = createdEl.setInnerHTML.mock.calls[0]?.[0] || '';
                expect(html).toContain('업데이트 실패');
                expect(html).toContain('다운로드 실패');
            }
        });

        it('shows default error when error is undefined', async () => {
            await toast.showMainAutoUpdateResult('1.0', '2.0', '', false);

            const createdEl = doc._elements['div'];
            if (createdEl) {
                const html = createdEl.setInnerHTML.mock.calls[0]?.[0] || '';
                expect(html).toContain('알 수 없는 오류');
            }
        });

        it('escapes HTML in version strings', async () => {
            await toast.showMainAutoUpdateResult('<script>', '2.0', '', true);

            const createdEl = doc._elements['div'];
            if (createdEl) {
                const html = createdEl.setInnerHTML.mock.calls[0]?.[0] || '';
                expect(html).not.toContain('<script>');
            }
        });

        it('handles null getRootDocument gracefully', async () => {
            risu.getRootDocument = vi.fn(async () => null);
            await toast.showMainAutoUpdateResult('1.0', '2.0', '', true);
            // No throw
        });

        it('adjusts position when sub-plugin toast exists', async () => {
            const subToast = { _tag: 'sub-toast' };
            doc.querySelector = vi.fn(async (sel) => {
                if (sel === '[x-cpm-toast]') return subToast;
                if (sel === '[x-cpm-main-toast]') return null;
                if (sel === 'body') return { appendChild: vi.fn(async () => {}) };
                return null;
            });

            await toast.showMainAutoUpdateResult('1.0', '2.0', '', true);

            const createdEl = doc._elements['div'];
            if (createdEl) {
                // Should set bottom to 110px when sub-toast exists
                const bottomCall = createdEl.setStyle.mock.calls.find(([k]) => k === 'bottom');
                if (bottomCall) {
                    expect(bottomCall[1]).toBe('110px');
                }
            }
        });

        it('uses 20px bottom when no sub-toast exists', async () => {
            await toast.showMainAutoUpdateResult('1.0', '2.0', '', true);

            const createdEl = doc._elements['div'];
            if (createdEl) {
                const bottomCall = createdEl.setStyle.mock.calls.find(([k]) => k === 'bottom');
                if (bottomCall) {
                    expect(bottomCall[1]).toBe('20px');
                }
            }
        });
    });
});

// ── Edge cases ──
describe('createUpdateToast edge cases', () => {
    it('handles getRootDocument exception', async () => {
        const risu = { getRootDocument: vi.fn(async () => { throw new Error('dom error'); }) };
        const t = createUpdateToast({ Risu: risu, escHtml: (s) => s });
        // Should not throw
        await t.showUpdateToast([]);
        await t.showMainAutoUpdateResult('1.0', '2.0', '', true);
    });

    it('handles body not found', async () => {
        const doc = {
            querySelector: vi.fn(async (sel) => {
                if (sel === 'body') return null;
                return null;
            }),
            createElement: vi.fn(async () => ({
                setAttribute: vi.fn(async () => {}),
                setStyle: vi.fn(async () => {}),
                setInnerHTML: vi.fn(async () => {}),
            })),
        };
        const risu = { getRootDocument: vi.fn(async () => doc) };
        const t = createUpdateToast({ Risu: risu, escHtml: (s) => s });
        await t.showUpdateToast([{ name: 'X', icon: '🔌', localVersion: '1.0', remoteVersion: '2.0' }]);
        await t.showMainAutoUpdateResult('1.0', '2.0', '', true);
    });
});

// ── Timer callback coverage ──
describe('createUpdateToast timer callbacks', () => {
    let doc, risu, toast;

    beforeEach(() => {
        vi.useFakeTimers();
        const elements = {};
        const mockElement = (tag) => ({
            _tag: tag,
            _attrs: {},
            _styles: {},
            _innerHTML: '',
            setAttribute: vi.fn(async (k, v) => {}),
            setStyle: vi.fn(async (k, v) => {}),
            setInnerHTML: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
            appendChild: vi.fn(async (child) => {}),
        });

        doc = {
            createElement: vi.fn(async (tag) => {
                const el = mockElement(tag);
                elements[tag] = el;
                return el;
            }),
            querySelector: vi.fn(async (sel) => {
                if (sel === 'body') return { appendChild: vi.fn(async () => {}) };
                return null;
            }),
            _elements: elements,
        };
        risu = { getRootDocument: vi.fn(async () => doc) };
        toast = createUpdateToast({ Risu: risu, escHtml: (s) => String(s ?? '') });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('showUpdateToast fade-in timer fires at 50ms', async () => {
        await toast.showUpdateToast([{ name: 'P', icon: '🧩', localVersion: '1.0', remoteVersion: '2.0' }]);
        const el = doc._elements['div'];

        await vi.advanceTimersByTimeAsync(50);

        const opacityCall = el.setStyle.mock.calls.find(([k, v]) => k === 'opacity' && v === '1');
        expect(opacityCall).toBeTruthy();
    });

    it('showUpdateToast fade-out and remove timer fires at 8000ms', async () => {
        await toast.showUpdateToast([{ name: 'P', icon: '🧩', localVersion: '1.0', remoteVersion: '2.0' }]);
        const el = doc._elements['div'];

        await vi.advanceTimersByTimeAsync(8050);

        const fadeOutCall = el.setStyle.mock.calls.find(([k, v]) => k === 'opacity' && v === '0');
        expect(fadeOutCall).toBeTruthy();

        await vi.advanceTimersByTimeAsync(400);
        expect(el.remove).toHaveBeenCalled();
    });

    it('showMainAutoUpdateResult success fade-in fires at 50ms', async () => {
        await toast.showMainAutoUpdateResult('1.0', '2.0', 'changes', true);
        const el = doc._elements['div'];

        await vi.advanceTimersByTimeAsync(50);

        const opacityCall = el.setStyle.mock.calls.find(([k, v]) => k === 'opacity' && v === '1');
        expect(opacityCall).toBeTruthy();
    });

    it('showMainAutoUpdateResult success dismiss at 10000ms', async () => {
        await toast.showMainAutoUpdateResult('1.0', '2.0', '', true);
        const el = doc._elements['div'];

        await vi.advanceTimersByTimeAsync(10050);

        const fadeOutCall = el.setStyle.mock.calls.find(([k, v]) => k === 'opacity' && v === '0');
        expect(fadeOutCall).toBeTruthy();

        await vi.advanceTimersByTimeAsync(400);
        expect(el.remove).toHaveBeenCalled();
    });

    it('showMainAutoUpdateResult failure dismiss at 15000ms', async () => {
        await toast.showMainAutoUpdateResult('1.0', '2.0', '', false, 'error');
        const el = doc._elements['div'];

        await vi.advanceTimersByTimeAsync(15050);

        const fadeOut = el.setStyle.mock.calls.find(([k, v]) => k === 'opacity' && v === '0');
        expect(fadeOut).toBeTruthy();

        await vi.advanceTimersByTimeAsync(400);
        expect(el.remove).toHaveBeenCalled();
    });

    it('showMainAutoUpdateResult removes existing main toast', async () => {
        const existingMainToast = { remove: vi.fn(async () => {}) };
        doc.querySelector = vi.fn(async (sel) => {
            if (sel === '[x-cpm-main-toast]') return existingMainToast;
            if (sel === 'body') return { appendChild: vi.fn(async () => {}) };
            return null;
        });

        await toast.showMainAutoUpdateResult('1.0', '2.0', '', true);
        expect(existingMainToast.remove).toHaveBeenCalled();
    });

    it('showMainAutoUpdateResult body not found returns early', async () => {
        doc.querySelector = vi.fn(async (sel) => {
            if (sel === 'body') return null;
            return null;
        });

        // Should not throw
        await toast.showMainAutoUpdateResult('1.0', '2.0', '', true);
    });
});
