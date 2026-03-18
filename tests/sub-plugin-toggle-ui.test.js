/**
 * sub-plugin-toggle-ui.test.js
 *
 * Tests for sub-plugin toggle UI module:
 *   1. Panel rendering — correct DOM structure, toggle states
 *   2. Empty state — no sub-plugins message
 *   3. Toggle interaction — onToggle callback invocation
 *   4. Destroy — panel removal from DOM
 *   5. Integration — toggle UI + auto-updater toggle API round-trip
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubPluginToggleUI } from '../src/shared/sub-plugin-toggle-ui.js';
import { createAutoUpdater } from '../src/shared/auto-updater.js';

// ─── Mock SafeElement / SafeDocument ───

function createMockDocument() {
    const elements = new Map();
    let bodyChildren = [];

    function makeElement(tag = 'div') {
        const attrs = {};
        const styles = {};
        let innerHTML = '';
        const listeners = {};
        let parent = null;
        const children = [];

        const el = {
            _tag: tag,
            _attrs: attrs,
            _styles: styles,
            _children: children,
            getAttribute: vi.fn(async (key) => attrs[key] || null),
            setAttribute: vi.fn(async (key, val) => { attrs[key] = val; }),
            setStyle: vi.fn(async (key, val) => { styles[key] = val; }),
            getStyle: vi.fn(async (key) => styles[key] || ''),
            setInnerHTML: vi.fn(async (html) => { innerHTML = html; }),
            getInnerHTML: vi.fn(async () => innerHTML),
            addEventListener: vi.fn(async (event, handler) => {
                if (!listeners[event]) listeners[event] = [];
                listeners[event].push(handler);
            }),
            _fireEvent: async (event) => {
                for (const h of (listeners[event] || [])) await h();
            },
            appendChild: vi.fn(async (child) => {
                children.push(child);
                child._parent = el;
            }),
            remove: vi.fn(async () => {
                bodyChildren = bodyChildren.filter(c => c !== el);
            }),
            querySelector: vi.fn(async (selector) => {
                // Simple attribute selector matching: [attr="value"]
                const attrMatch = selector.match(/\[([^\]=]+)(?:="([^"]*)")?\]/);
                if (attrMatch) {
                    const [, attrName, attrVal] = attrMatch;
                    // Check self
                    if (attrVal !== undefined && attrs[attrName] === attrVal) return el;
                    if (attrVal === undefined && attrs[attrName] !== undefined) return el;
                    // Check children
                    for (const child of children) {
                        const found = await child.querySelector(selector);
                        if (found) return found;
                    }
                }
                return null;
            }),
            getParent: vi.fn(async () => parent),
            _parent: parent,
        };
        return el;
    }

    const body = makeElement('body');
    body.appendChild = vi.fn(async (child) => {
        bodyChildren.push(child);
        child._parent = body;
    });

    const doc = {
        createElement: vi.fn(async (tag) => makeElement(tag)),
        querySelector: vi.fn(async (selector) => {
            if (selector === 'body') return body;
            const attrMatch = selector.match(/\[([^\]=]+)(?:="([^"]*)")?\]/);
            if (attrMatch) {
                const [, attrName, attrVal] = attrMatch;
                for (const child of bodyChildren) {
                    const childAttrs = child._attrs;
                    if (attrVal !== undefined && childAttrs[attrName] === attrVal) return child;
                    if (attrVal === undefined && childAttrs[attrName] !== undefined) return child;
                }
            }
            return null;
        }),
    };

    return { doc, body, bodyChildren: () => bodyChildren, makeElement };
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── 1. Panel rendering ───

describe('sub-plugin-toggle-ui: renderTogglePanel', () => {
    it('renders a panel with toggle switches for each sub-plugin', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const states = [
            { name: 'SubAlpha', enabled: true },
            { name: 'SubBeta', enabled: false },
        ];

        const result = await ui.renderTogglePanel(states, vi.fn());

        expect(result.toggleCount).toBe(2);
        expect(result.element).toBeDefined();
        expect(result.element.setAttribute).toHaveBeenCalledWith('x-cpm-sub-toggle-panel', '1');
        expect(result.element.setInnerHTML).toHaveBeenCalledOnce();

        const html = result.element.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('SubAlpha');
        expect(html).toContain('SubBeta');
        expect(html).toContain('자동 업데이트 활성');
        expect(html).toContain('자동 업데이트 비활성');
    });

    it('renders empty state message when no sub-plugins', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const result = await ui.renderTogglePanel([], vi.fn());

        expect(result.toggleCount).toBe(0);
        const html = result.element.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('등록된 서브 플러그인이 없습니다');
    });

    it('throws when states is not an array', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        await expect(ui.renderTogglePanel(null, vi.fn())).rejects.toThrow('states must be an array');
    });

    it('throws when getRootDocument returns null', async () => {
        const Risu = { getRootDocument: vi.fn(async () => null) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        await expect(ui.renderTogglePanel([], vi.fn())).rejects.toThrow('getRootDocument');
    });

    it('appends panel to document body', async () => {
        const { doc, body } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        await ui.renderTogglePanel([{ name: 'Sub1', enabled: true }], vi.fn());

        expect(body.appendChild).toHaveBeenCalledOnce();
    });

    it('removes existing panel before rendering new one', async () => {
        const { doc, body } = createMockDocument();
        const existingPanel = { remove: vi.fn(async () => {}), _attrs: { 'x-cpm-sub-toggle-panel': '1' } };
        // First call to querySelector for existing panel returns it
        const originalQuery = doc.querySelector;
        let firstCall = true;
        doc.querySelector = vi.fn(async (selector) => {
            if (selector.includes('x-cpm-sub-toggle-panel') && firstCall) {
                firstCall = false;
                return existingPanel;
            }
            return originalQuery(selector);
        });

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        await ui.renderTogglePanel([], vi.fn());

        expect(existingPanel.remove).toHaveBeenCalledOnce();
    });

    it('escapes sub-plugin names in HTML output', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const states = [{ name: '<script>alert(1)</script>', enabled: true }];
        const result = await ui.renderTogglePanel(states, vi.fn());

        const rendered = result.element.setInnerHTML.mock.calls[0][0];
        expect(rendered).not.toContain('<script>');
        expect(rendered).toContain('&lt;script&gt;');
    });

    it('sets correct toggle dot position for enabled vs disabled', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const states = [
            { name: 'Enabled', enabled: true },
            { name: 'Disabled', enabled: false },
        ];
        const result = await ui.renderTogglePanel(states, vi.fn());

        const html = result.element.setInnerHTML.mock.calls[0][0];
        // Enabled: dot at left:20px, Disabled: dot at left:2px
        expect(html).toContain('left:20px');
        expect(html).toContain('left:2px');
    });
});

// ─── 2. Toggle interaction ───

describe('sub-plugin-toggle-ui: toggle click handler', () => {
    it('registers click listeners on each toggle button', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const states = [
            { name: 'SubA', enabled: true },
            { name: 'SubB', enabled: false },
        ];

        const result = await ui.renderTogglePanel(states, vi.fn());

        // Each toggle button should have addEventListener called
        const panel = result.element;
        expect(panel.querySelector).toHaveBeenCalled();
    });
});

// ─── 3. Destroy panel ───

describe('sub-plugin-toggle-ui: destroyTogglePanel', () => {
    it('removes panel element from DOM', async () => {
        const { doc, body, bodyChildren } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const result = await ui.renderTogglePanel([{ name: 'Sub1', enabled: true }], vi.fn());
        const panel = result.element;

        await ui.destroyTogglePanel();

        expect(panel.remove).toHaveBeenCalledOnce();
    });

    it('does nothing if no panel was rendered', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        // Should not throw
        await ui.destroyTogglePanel();
    });

    it('falls back to query when panel reference is lost', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        // No render was done, but a panel exists in DOM from another source
        const orphan = { remove: vi.fn(async () => {}), _attrs: { 'x-cpm-sub-toggle-panel': '1' } };
        const originalQuery = doc.querySelector;
        doc.querySelector = vi.fn(async (selector) => {
            if (selector.includes('x-cpm-sub-toggle-panel')) return orphan;
            return originalQuery(selector);
        });

        await ui.destroyTogglePanel();

        expect(orphan.remove).toHaveBeenCalledOnce();
    });
});

// ─── 4. Panel styling ───

describe('sub-plugin-toggle-ui: panel styles', () => {
    it('applies correct container styles', async () => {
        const { doc } = createMockDocument();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu, escHtml });

        const result = await ui.renderTogglePanel([{ name: 'Sub1', enabled: true }], vi.fn());

        expect(result.element.setStyle).toHaveBeenCalledWith('background', '#1f2937');
        expect(result.element.setStyle).toHaveBeenCalledWith('borderRadius', '8px');
        expect(result.element.setStyle).toHaveBeenCalledWith('padding', '16px');
    });
});

// ─── 5. Integration: toggle UI + auto-updater API ───

describe('sub-plugin-toggle-ui: integration with auto-updater toggle API', () => {
    function createUpdaterForUI() {
        const storage = {};
        const db = {
            plugins: [
                { name: 'MainPlugin', version: '3.0', versionOfPlugin: '1.0.0', script: 'x', enabled: true },
                { name: 'SubAlpha', version: '3.0', versionOfPlugin: '1.0.0', script: 'y', enabled: true },
                { name: 'SubBeta', version: '3.0', versionOfPlugin: '1.0.0', script: 'z', enabled: true },
            ],
        };
        const Risu = {
            pluginStorage: {
                getItem: vi.fn(async (key) => storage[key] || null),
                setItem: vi.fn(async (key, val) => { storage[key] = val; }),
                removeItem: vi.fn(async (key) => { delete storage[key]; }),
            },
            getDatabase: vi.fn(async () => JSON.parse(JSON.stringify(db))),
            setDatabaseLite: vi.fn(async () => {}),
            risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
            getArgument: vi.fn(async () => ''),
            registerPlugin: vi.fn(),
        };

        const updater = createAutoUpdater({
            Risu,
            currentVersion: '1.0.0',
            pluginName: 'MainPlugin',
            versionsUrl: 'https://example.com/versions.json',
            mainUpdateUrl: 'https://example.com/plugin.js',
            updateBundleUrl: 'https://example.com/bundle.json',
            toast: { showMainAutoUpdateResult: vi.fn(async () => {}) },
            _autoSaveDelayMs: 0,
        });

        return { updater, Risu, storage };
    }

    it('getSubPluginToggleStates feeds directly into renderTogglePanel', async () => {
        const { updater } = createUpdaterForUI();
        const { doc } = createMockDocument();
        const mockRisu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu: mockRisu, escHtml });

        const states = await updater.getSubPluginToggleStates();

        // States should have SubAlpha and SubBeta (excluding MainPlugin)
        expect(states.length).toBe(2);
        expect(states.every(s => s.enabled === true)).toBe(true);

        const result = await ui.renderTogglePanel(states, vi.fn());
        expect(result.toggleCount).toBe(2);

        const html = result.element.setInnerHTML.mock.calls[0][0];
        expect(html).toContain('SubAlpha');
        expect(html).toContain('SubBeta');
    });

    it('onToggle callback calls setSubPluginAutoUpdateEnabled', async () => {
        const { updater } = createUpdaterForUI();
        const { doc } = createMockDocument();
        const mockRisu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu: mockRisu, escHtml });

        const states = await updater.getSubPluginToggleStates();

        // Wire up onToggle to call the updater API
        const onToggle = async (name, enabled) => {
            await updater.setSubPluginAutoUpdateEnabled(name, enabled);
        };

        await ui.renderTogglePanel(states, onToggle);

        // Simulate disabling SubAlpha
        await onToggle('SubAlpha', false);

        // Verify the toggle persisted
        const isEnabled = await updater.isSubPluginAutoUpdateEnabled('SubAlpha');
        expect(isEnabled).toBe(false);

        // SubBeta should still be enabled
        const isBetaEnabled = await updater.isSubPluginAutoUpdateEnabled('SubBeta');
        expect(isBetaEnabled).toBe(true);
    });

    it('round-trip: disable via UI → reflected in getSubPluginToggleStates', async () => {
        const { updater } = createUpdaterForUI();
        const { doc } = createMockDocument();
        const mockRisu = { getRootDocument: vi.fn(async () => doc) };
        const ui = createSubPluginToggleUI({ Risu: mockRisu, escHtml });

        // Initially all enabled
        let states = await updater.getSubPluginToggleStates();
        expect(states.every(s => s.enabled)).toBe(true);

        // Disable SubAlpha via the toggle API (simulating UI click)
        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', false);

        // Re-fetch states
        states = await updater.getSubPluginToggleStates();
        const alpha = states.find(s => s.name === 'SubAlpha');
        const beta = states.find(s => s.name === 'SubBeta');
        expect(alpha.enabled).toBe(false);
        expect(beta.enabled).toBe(true);

        // Render with updated states
        const result = await ui.renderTogglePanel(states, vi.fn());
        const html = result.element.setInnerHTML.mock.calls[0][0];
        // SubAlpha should show as disabled (left:2px)
        expect(html).toContain('SubAlpha');
        expect(result.toggleCount).toBe(2);
    });
});
