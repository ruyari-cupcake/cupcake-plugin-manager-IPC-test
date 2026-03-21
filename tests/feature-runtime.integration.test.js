import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAsyncElement(name = 'div') {
    const state = {
        name,
        attributes: new Map(),
        styles: new Map(),
        children: [],
        listeners: [],
        innerHTML: '',
        parent: null,
    };

    return {
        __state: state,
        async setAttribute(key, value) {
            state.attributes.set(key, value);
        },
        async getAttribute(key) {
            return state.attributes.get(key) ?? null;
        },
        async setStyle(key, value) {
            state.styles.set(key, value);
        },
        async setStyleAttribute(value) {
            state.styles.set('style', value);
        },
        async setInnerHTML(value) {
            state.innerHTML = value;
        },
        async getInnerHTML() {
            return state.innerHTML;
        },
        async appendChild(child) {
            state.children.push(child);
            if (child?.__state) child.__state.parent = this;
            return child;
        },
        async remove() {
            if (!state.parent?.__state) return;
            state.parent.__state.children = state.parent.__state.children.filter((child) => child !== this);
            state.parent = null;
        },
        async addEventListener(type, handler) {
            const id = `${type}-${state.listeners.length + 1}`;
            state.listeners.push({ id, type, handler });
            return id;
        },
        async removeEventListener(_type, id) {
            state.listeners = state.listeners.filter((listener) => listener.id !== id);
        },
        async getBoundingClientRect() {
            return { left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40 };
        },
        async querySelector(selector) {
            if (selector === '[x-cpm-btn]') {
                return state.children.find((child) => child?.__state?.attributes?.get('x-cpm-btn')) ?? null;
            }
            return null;
        },
        async querySelectorAll(selector) {
            if (selector === 'div') return state.children.filter((child) => child?.__state?.name === 'div');
            return [];
        },
        async matches() {
            return false;
        },
        async getParent() {
            return state.parent;
        },
        async getChildren() {
            return state.children;
        },
        async scrollIntoView() {},
        async select() {},
    };
}

function createRootDoc({ textareas = [], hasChatContainer = true } = {}) {
    const body = createAsyncElement('body');
    const head = createAsyncElement('head');
    const overlay = createAsyncElement('div');
    const chatContainer = createAsyncElement('div');
    chatContainer.getChildren = vi.fn(async () => [{}, {}]);

    let textareaIndex = 0;

    return {
        body,
        head,
        overlay,
        chatContainer,
        async querySelector(selector) {
            if (selector === 'body') return body;
            if (selector === 'head') return head;
            if (selector === '.absolute.top-0.left-0.w-full.h-full') return overlay;
            if (selector === '[x-id="cpm-maximizer-styles"]') return null;
            if (selector === 'textarea:not([x-cpm-resizer])') {
                const next = textareas[textareaIndex] ?? null;
                textareaIndex += 1;
                return next;
            }
            if (
                selector === '.flex-col-reverse' ||
                selector === '.flex-col-reverse:nth-of-type(2)' ||
                selector === '.flex-col-reverse:nth-of-type(1)' ||
                selector === 'main .flex-col-reverse'
            ) {
                return hasChatContainer ? chatContainer : null;
            }
            return null;
        },
        async createElement(tagName) {
            return createAsyncElement(tagName);
        },
    };
}

function createTextareaWithParent() {
    const parent = createAsyncElement('div');
    const textarea = createAsyncElement('textarea');
    textarea.getParent = vi.fn(async () => parent);
    textarea.matches = vi.fn(async () => false);
    return { textarea, parent };
}

describe('migrated feature runtime smoke tests', () => {
    let originalWindow;
    let originalDocument;
    let originalAlert;
    let originalSetInterval;
    let originalClearInterval;
    let originalNavigatorDescriptor;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        originalWindow = globalThis.window;
        originalDocument = globalThis.document;
        originalAlert = globalThis.alert;
        originalSetInterval = globalThis.setInterval;
        originalClearInterval = globalThis.clearInterval;
        originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

        globalThis.document = {
            head: { innerHTML: '' },
            body: { innerHTML: '', appendChild: vi.fn(), removeChild: vi.fn() },
            getElementById: vi.fn(() => null),
            addEventListener: vi.fn(),
            createElement: vi.fn(() => ({ style: {}, remove: vi.fn(), select: vi.fn() })),
            execCommand: vi.fn(() => true),
        };
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { clipboard: { writeText: vi.fn(async () => {}) } },
        });
        globalThis.alert = vi.fn();
        globalThis.setInterval = vi.fn(() => 101);
        globalThis.clearInterval = vi.fn();
    });

    afterEach(() => {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
        globalThis.alert = originalAlert;
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;

        if (originalNavigatorDescriptor) {
            Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
        } else {
            delete globalThis.navigator;
        }
    });

    it('Translation Cache feature registers display hook, UI setting, and cleanup', async () => {
        const risu = {
            addRisuScriptHandler: vi.fn(),
            removeRisuScriptHandler: vi.fn(),
            registerSetting: vi.fn(async () => {}),
            getArgument: vi.fn(async () => 'true'),
            setArgument: vi.fn(async () => {}),
            searchTranslationCache: vi.fn(async () => [{ key: 'hello', value: '안녕' }]),
            getTranslationCache: vi.fn(async () => '안녕'),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            showContainer: vi.fn(),
            hideContainer: vi.fn(),
        };

        globalThis.window = { risuai: risu };

        await import('../src/features/transcache.js');
        await flush();

        expect(risu.addRisuScriptHandler).toHaveBeenCalledWith('display', expect.any(Function));
        expect(risu.registerSetting).toHaveBeenCalledWith('번역 캐시', expect.any(Function), '💾', 'html');
        expect(typeof globalThis.window._cpmTransCacheCleanup).toBe('function');

        globalThis.window._cpmTransCacheCleanup();
        expect(risu.removeRisuScriptHandler).toHaveBeenCalledWith('display', expect.any(Function));
    });

    it('Navigation feature registers chat button and observer-based cleanup', async () => {
        const observer = {
            observe: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
        };
        const rootDoc = createRootDoc();
        const risu = {
            getRootDocument: vi.fn(async () => rootDoc),
            registerButton: vi.fn(async () => {}),
            createMutationObserver: vi.fn(async () => observer),
        };

        globalThis.window = { risuai: risu };

        await import('../src/features/navigation.js');
        await flush();

        expect(risu.registerButton).toHaveBeenCalledWith(
            expect.objectContaining({ name: '🧭 네비게이션', location: 'chat' }),
            expect.any(Function),
        );
        expect(risu.createMutationObserver).toHaveBeenCalledTimes(1);
        expect(observer.observe).toHaveBeenCalledWith(rootDoc.body, { childList: true, subtree: true });
        expect(typeof globalThis.window._cpmNaviCleanup).toBe('function');

        await globalThis.window._cpmNaviCleanup();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        expect(globalThis.clearInterval).toHaveBeenCalledWith(101);
    });

    it('Resizer feature initializes observer, injects styles, and exposes cleanup', async () => {
        const observer = {
            observe: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
        };
        const { textarea, parent } = createTextareaWithParent();
        const rootDoc = createRootDoc({ textareas: [textarea, null] });
        const risu = {
            getArgument: vi.fn(async (key) => (key === 'cpm_enable_chat_resizer' ? 'on' : '')),
            getCharacter: vi.fn(async () => ({ chatPage: 0, chats: [{ scriptstate: {} }] })),
            setCharacter: vi.fn(async () => {}),
            getRootDocument: vi.fn(async () => rootDoc),
            createMutationObserver: vi.fn(async () => observer),
        };

        globalThis.window = { risuai: risu };

        await import('../src/features/resizer.js');
        await flush();
        await flush();

        expect(risu.createMutationObserver).toHaveBeenCalledTimes(1);
        expect(observer.observe).toHaveBeenCalledWith(rootDoc.body, { childList: true, subtree: true });
        expect(rootDoc.head.__state.children).toHaveLength(1);
        expect(rootDoc.body.__state.children.some((child) => child?.__state?.attributes?.get('x-cpm-btn') === 'true')).toBe(true);
        expect(typeof globalThis.window._cpmResizerCleanup).toBe('function');

        await globalThis.window._cpmResizerCleanup();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    it('Resizer feature respects the disable flag and exits early', async () => {
        const risu = {
            getArgument: vi.fn(async () => 'off'),
            getRootDocument: vi.fn(async () => createRootDoc()),
            createMutationObserver: vi.fn(),
        };

        globalThis.window = { risuai: risu };

        await import('../src/features/resizer.js');
        await flush();

        expect(risu.getRootDocument).not.toHaveBeenCalled();
        expect(risu.createMutationObserver).not.toHaveBeenCalled();
    });
});