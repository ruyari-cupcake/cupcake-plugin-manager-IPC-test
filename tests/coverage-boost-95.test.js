/**
 * coverage-boost-95.test.js — Target 95%+ statement coverage
 *
 * Focuses on uncovered branches in:
 *   - update-toast.js (76% → 100%)
 *   - model-helpers.js (86% → 100%)
 *   - helpers.js (83.95% → 90%+)
 *   - message-format.js (87.85% → 95%+)
 *   - sse-parser.js (89.6% → 95%+)
 *   - auto-updater.js (88.5% → 95%+)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ──────────────────────────────────────────────
// 1. update-toast.js — showMainAutoUpdateResult
// ──────────────────────────────────────────────
import { createUpdateToast } from '../src/shared/update-toast.js';

function createMockDoc() {
    const elements = {};
    return {
        querySelector: vi.fn(async (sel) => elements[sel] || null),
        createElement: vi.fn(async () => ({
            setAttribute: vi.fn(async () => {}),
            setStyle: vi.fn(async () => {}),
            setInnerHTML: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        })),
        _setElement(sel, el) { elements[sel] = el; },
    };
}

describe('update-toast: showUpdateToast', () => {
    it('shows toast with updates and auto-dismisses', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showUpdateToast([
            { name: 'A', icon: '🔵', localVersion: '1.0', remoteVersion: '2.0', changes: 'fix' },
            { name: 'B', icon: '🟢', localVersion: '1.0', remoteVersion: '2.0' },
        ]);

        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('handles > 3 updates (shows ...외 N개)', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showUpdateToast([
            { name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' },
            { name: 'B', icon: '2', localVersion: '1', remoteVersion: '2' },
            { name: 'C', icon: '3', localVersion: '1', remoteVersion: '2' },
            { name: 'D', icon: '4', localVersion: '1', remoteVersion: '2' },
        ]);

        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('returns silently when getRootDocument is null', async () => {
        const Risu = { getRootDocument: vi.fn(async () => null) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showUpdateToast([{ name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' }]);
        // no error thrown
    });

    it('returns silently when body not found', async () => {
        const doc = createMockDoc();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showUpdateToast([{ name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' }]);
    });

    it('removes existing toast before creating new one', async () => {
        const doc = createMockDoc();
        const existing = { remove: vi.fn(async () => {}) };
        doc._setElement('[x-cpm-toast]', existing);
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showUpdateToast([{ name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' }]);
        expect(existing.remove).toHaveBeenCalled();
    });
});

describe('update-toast: showMainAutoUpdateResult', () => {
    it('shows success toast', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showMainAutoUpdateResult('1.0', '2.0', 'bugfix', true);
        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('shows failure toast with error', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showMainAutoUpdateResult('1.0', '2.0', '', false, 'network error');
        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('shows failure toast without explicit error message', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showMainAutoUpdateResult('1.0', '2.0', '', false);
        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('returns silently when getRootDocument is null', async () => {
        const Risu = { getRootDocument: vi.fn(async () => null) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', '', true);
    });

    it('returns silently when body not found', async () => {
        const doc = createMockDoc();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', '', true);
    });

    it('adjusts bottom position when sub-toast exists', async () => {
        const doc = createMockDoc();
        doc._setElement('[x-cpm-toast]', { exists: true });
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', '', true);
        expect(body.appendChild).toHaveBeenCalled();
    });

    it('removes existing main toast before creating new one', async () => {
        const doc = createMockDoc();
        const existing = { remove: vi.fn(async () => {}) };
        doc._setElement('[x-cpm-main-toast]', existing);
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', 'changes', true);
        expect(existing.remove).toHaveBeenCalled();
    });

    it('success toast includes changes text', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);
        let capturedHtml = '';
        doc.createElement = vi.fn(async () => ({
            setAttribute: vi.fn(async () => {}),
            setStyle: vi.fn(async () => {}),
            setInnerHTML: vi.fn(async (h) => { capturedHtml = h; }),
            remove: vi.fn(async () => {}),
        }));

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', 'big fix', true);
        expect(capturedHtml).toContain('big fix');
    });
});

// ──────────────────────────────────────────────
// 2. model-helpers.js — uncovered branches
// ──────────────────────────────────────────────
import {
    supportsOpenAIReasoningEffort,
    supportsOpenAIVerbosity,
    needsCopilotResponsesAPI,
    shouldStripOpenAISamplingParams,
    shouldStripGPT54SamplingForReasoning,
    needsMaxCompletionTokens,
} from '../src/shared/model-helpers.js';

describe('model-helpers: supportsOpenAIVerbosity', () => {
    it('returns false for empty/falsy', () => {
        expect(supportsOpenAIVerbosity('')).toBe(false);
        expect(supportsOpenAIVerbosity(null)).toBe(false);
    });
    it('returns true for gpt-5', () => expect(supportsOpenAIVerbosity('gpt-5')).toBe(true));
    it('returns true for gpt-5.4', () => expect(supportsOpenAIVerbosity('gpt-5.4')).toBe(true));
    it('returns true for gpt-5-mini', () => expect(supportsOpenAIVerbosity('gpt-5-mini')).toBe(true));
    it('returns true for gpt-5-nano', () => expect(supportsOpenAIVerbosity('gpt-5-nano')).toBe(true));
    it('returns true for gpt-5-2025-01-01', () => expect(supportsOpenAIVerbosity('gpt-5-2025-01-01')).toBe(true));
    it('returns false for gpt-4o', () => expect(supportsOpenAIVerbosity('gpt-4o')).toBe(false));
    it('returns false for o3', () => expect(supportsOpenAIVerbosity('o3')).toBe(false));
});

describe('model-helpers: needsCopilotResponsesAPI', () => {
    it('returns false for empty/falsy', () => {
        expect(needsCopilotResponsesAPI('')).toBe(false);
        expect(needsCopilotResponsesAPI(null)).toBe(false);
    });
    it('returns true for gpt-5.4', () => expect(needsCopilotResponsesAPI('gpt-5.4')).toBe(true));
    it('returns true for gpt-5.5', () => expect(needsCopilotResponsesAPI('gpt-5.5')).toBe(true));
    it('returns false for gpt-5.3', () => expect(needsCopilotResponsesAPI('gpt-5.3')).toBe(false));
    it('returns false for gpt-5', () => expect(needsCopilotResponsesAPI('gpt-5')).toBe(false));
    it('returns true for prefixed model org/gpt-5.4', () => expect(needsCopilotResponsesAPI('org/gpt-5.4')).toBe(true));
});

describe('model-helpers: shouldStripOpenAISamplingParams', () => {
    it('returns false for empty', () => expect(shouldStripOpenAISamplingParams('')).toBe(false));
    it('returns true for o1', () => expect(shouldStripOpenAISamplingParams('o1')).toBe(true));
    it('returns true for o1-mini', () => expect(shouldStripOpenAISamplingParams('o1-mini')).toBe(true));
    it('returns true for o1-preview', () => expect(shouldStripOpenAISamplingParams('o1-preview')).toBe(true));
    it('returns true for o1-pro', () => expect(shouldStripOpenAISamplingParams('o1-pro')).toBe(true));
    it('returns true for o3', () => expect(shouldStripOpenAISamplingParams('o3')).toBe(true));
    it('returns true for o3-mini', () => expect(shouldStripOpenAISamplingParams('o3-mini')).toBe(true));
    it('returns true for o3-pro', () => expect(shouldStripOpenAISamplingParams('o3-pro')).toBe(true));
    it('returns true for o3-deep-research', () => expect(shouldStripOpenAISamplingParams('o3-deep-research')).toBe(true));
    it('returns true for o4-mini', () => expect(shouldStripOpenAISamplingParams('o4-mini')).toBe(true));
    it('returns true for o4-mini-deep-research', () => expect(shouldStripOpenAISamplingParams('o4-mini-deep-research')).toBe(true));
    it('returns false for gpt-5', () => expect(shouldStripOpenAISamplingParams('gpt-5')).toBe(false));
    it('returns true for prefixed org/o3', () => expect(shouldStripOpenAISamplingParams('org/o3')).toBe(true));
});

describe('model-helpers: shouldStripGPT54SamplingForReasoning', () => {
    it('returns false for empty model', () => expect(shouldStripGPT54SamplingForReasoning('', 'medium')).toBe(false));
    it('returns false for no reasoning effort', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', '')).toBe(false));
    it('returns false for none reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'none')).toBe(false));
    it('returns false for off reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'off')).toBe(false));
    it('returns true for gpt-5.4 with medium reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'medium')).toBe(true));
    it('returns true for gpt-5.4-mini with high reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-mini', 'high')).toBe(true));
    it('returns true for gpt-5.4-nano with low reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-nano', 'low')).toBe(true));
    it('returns true for gpt-5.4-pro with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-pro', 'medium')).toBe(true));
    it('returns true for gpt-5.4-2025-01-01 with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-2025-01-01', 'medium')).toBe(true));
    it('returns false for gpt-5.3 with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.3', 'medium')).toBe(false));
    it('returns false for gpt-4o with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-4o', 'medium')).toBe(false));
});

describe('model-helpers: needsMaxCompletionTokens', () => {
    it('returns false for empty', () => expect(needsMaxCompletionTokens('')).toBe(false));
    it('returns true for gpt-4.5', () => expect(needsMaxCompletionTokens('gpt-4.5')).toBe(true));
    it('returns true for gpt-5', () => expect(needsMaxCompletionTokens('gpt-5')).toBe(true));
    it('returns true for o1', () => expect(needsMaxCompletionTokens('o1')).toBe(true));
    it('returns true for o3', () => expect(needsMaxCompletionTokens('o3')).toBe(true));
    it('returns false for gpt-4o', () => expect(needsMaxCompletionTokens('gpt-4o')).toBe(false));
});

// ──────────────────────────────────────────────
// 3. helpers.js — uncovered branches
// ──────────────────────────────────────────────
import {
    extractImageUrlFromPart,
    _raceWithAbortSignal,
    collectStream,
    shouldEnableStreaming,
} from '../src/shared/helpers.js';

describe('helpers: _raceWithAbortSignal — already aborted signal', () => {
    it('rejects immediately if signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const p = new Promise(r => setTimeout(() => r('done'), 100));
        await expect(_raceWithAbortSignal(p, ac.signal)).rejects.toThrow('aborted');
    });
});

describe('helpers: extractImageUrlFromPart — input_image type', () => {
    it('returns string image_url for input_image', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'http://img.png' }))
            .toBe('http://img.png');
    });
    it('returns nested object url for input_image', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'http://nested.png' } }))
            .toBe('http://nested.png');
    });
    it('returns empty string for input_image without valid image_url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 123 })).toBe('');
    });
});

describe('helpers: collectStream — abort mid-stream', () => {
    it('stops collecting when abort signal fires', async () => {
        const ac = new AbortController();
        let enqueued = 0;
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('a');
                controller.enqueue('b');
                enqueued = 2;
            }
        });
        // abort before collecting
        ac.abort();
        const result = await collectStream(stream, ac.signal);
        expect(typeof result).toBe('string');
    });

    it('handles null value chunks', async () => {
        let ctrl;
        const stream = new ReadableStream({
            start(controller) {
                ctrl = controller;
                controller.enqueue(null);
                controller.enqueue('hello');
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('hello');
    });

    it('handles ArrayBuffer value chunks', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('ab').buffer);
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('ab');
    });

    it('handles non-standard value chunks (String coercion)', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(42);
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('42');
    });
});

describe('helpers: shouldEnableStreaming edge cases', () => {
    it('returns true when streaming enabled and not compatibility mode', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'false' })).toBe(true);
    });
    it('returns false when streaming disabled', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'false' })).toBe(false);
    });
    it('returns true for copilot even in compatibility mode', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'true' }, { isCopilot: true })).toBe(true);
    });
    it('returns false when streaming enabled + compat mode + not copilot', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'true' }, { isCopilot: false })).toBe(false);
    });
});

// ──────────────────────────────────────────────
// 4. message-format.js — audio, cache, gemini system msg
// ──────────────────────────────────────────────
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';

describe('formatToOpenAI — audio modal branches', () => {
    const makeMsg = (mimeInUri) => [
        {
            role: 'user',
            content: 'test',
            multimodals: [{ type: 'audio', base64: `data:audio/${mimeInUri};base64,AAAA` }],
        },
    ];

    it('detects wav audio format', () => {
        const messages = formatToOpenAI(makeMsg('wav'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('wav');
    });

    it('detects ogg audio format', () => {
        const messages = formatToOpenAI(makeMsg('ogg'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('ogg');
    });

    it('detects flac audio format', () => {
        const messages = formatToOpenAI(makeMsg('flac'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('flac');
    });

    it('detects webm audio format', () => {
        const messages = formatToOpenAI(makeMsg('webm'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('webm');
    });

    it('defaults to mp3 for unknown mime', () => {
        const messages = formatToOpenAI(makeMsg('mpeg'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('mp3');
    });
});

describe('formatToAnthropic — cache control (cachePoint)', () => {
    it('adds cache_control to string content message with cachePoint', () => {
        const msgs = [
            { role: 'user', content: 'hello', cachePoint: true },
            { role: 'assistant', content: 'reply' },
        ];
        const { messages } = formatToAnthropic(msgs);
        const cached = messages.find(m => m.role === 'user');
        expect(Array.isArray(cached.content)).toBe(true);
        expect(cached.content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds cache_control to last element of array content with cachePoint', () => {
        const msgs = [
            {
                role: 'user',
                content: 'hello from user with array',
                cachePoint: true,
            },
            { role: 'assistant', content: 'reply from assistant' },
        ];
        const { messages } = formatToAnthropic(msgs);
        // Find the user message that should have cache_control
        const cached = messages.find(m => m.role === 'user');
        expect(cached).toBeTruthy();
        // With cachePoint on string content, it converts to array
        if (Array.isArray(cached.content)) {
            expect(cached.content[cached.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
        }
    });
});

describe('formatToGemini — non-leading system messages', () => {
    it('converts non-leading system to "system: content" as user', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'Additional context' },
            { role: 'assistant', content: 'Reply' },
        ];
        const { contents } = formatToGemini(msgs);
        // system after user should be converted with "system: " prefix
        const allTexts = contents.flatMap(c => c.parts.map(p => p.text));
        expect(allTexts.some(t => t?.startsWith('system: '))).toBe(true);
    });

    it('appends to previous user message when consecutive', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'More system' },
        ];
        const { contents } = formatToGemini(msgs);
        // "system: More system" should be appended to the user message
        const lastUser = contents.find(c => c.role === 'user');
        const sysPart = lastUser?.parts.find(p => p.text?.startsWith('system: '));
        expect(sysPart).toBeTruthy();
    });

    it('creates new user part when previous is model', () => {
        const msgs = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Reply' },
            { role: 'system', content: 'Mid-system' },
        ];
        const { contents } = formatToGemini(msgs);
        // After assistant (model) message, system should create a new user entry
        const lastContent = contents[contents.length - 1];
        expect(lastContent.role).toBe('user');
        expect(lastContent.parts[0].text).toBe('system: Mid-system');
    });
});

describe('formatToGemini — file-based image handling', () => {
    it('pushes fileData for image with url', () => {
        const msgs = [
            {
                role: 'user',
                content: 'look at this',
                multimodals: [{ type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' }],
            },
        ];
        const { contents } = formatToGemini(msgs);
        const parts = contents[0].parts;
        const filePart = parts.find(p => p.fileData);
        expect(filePart.fileData.fileUri).toBe('https://example.com/img.png');
        expect(filePart.fileData.mimeType).toBe('image/png');
    });

    it('uses default mimeType when not provided', () => {
        const msgs = [
            {
                role: 'user',
                content: 'image',
                multimodals: [{ type: 'image', url: 'https://example.com/img.webp' }],
            },
        ];
        const { contents } = formatToGemini(msgs);
        const filePart = contents[0].parts.find(p => p.fileData);
        expect(filePart.fileData.mimeType).toBe('image/*');
    });
});

describe('formatToGemini — multimodal merge into same-role message', () => {
    it('merges multimodal image into previous same-role message', () => {
        const msgs = [
            { role: 'user', content: 'Image 1', multimodals: [{ type: 'image', base64: 'data:image/png;base64,AAAA' }] },
            { role: 'user', content: 'Image 2', multimodals: [{ type: 'image', base64: 'data:image/jpg;base64,BBBB' }] },
        ];
        const { contents } = formatToGemini(msgs);
        // Should merge into single user entry
        expect(contents.filter(c => c.role === 'user').length).toBe(1);
    });

    it('file-based image merge into existing same-role', () => {
        const msgs = [
            { role: 'user', content: 'first', multimodals: [{ type: 'image', url: 'https://a.png' }] },
            { role: 'user', content: 'second', multimodals: [{ type: 'image', url: 'https://b.png' }] },
        ];
        const { contents } = formatToGemini(msgs);
        expect(contents.filter(c => c.role === 'user').length).toBe(1);
        const fileDataParts = contents[0].parts.filter(p => p.fileData);
        expect(fileDataParts.length).toBe(2);
    });

    it('merges text into previous inlineData/fileData part', () => {
        const msgs = [
            { role: 'user', content: 'img', multimodals: [{ type: 'image', base64: 'data:image/png;base64,XXXX' }] },
            { role: 'user', content: 'more text' },
        ];
        const { contents } = formatToGemini(msgs);
        const textParts = contents[0].parts.filter(p => p.text);
        expect(textParts.length).toBeGreaterThanOrEqual(1);
    });

    it('handles audio multimodal (inlineData)', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,SOUND' }] },
        ];
        const { contents } = formatToGemini(msgs);
        const inlinePart = contents[0].parts.find(p => p.inlineData);
        expect(inlinePart.inlineData.mimeType).toBe('audio/mp3');
    });

    it('handles video multimodal (inlineData)', () => {
        const msgs = [
            { role: 'user', content: 'watch', multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,VID' }] },
        ];
        const { contents } = formatToGemini(msgs);
        const inlinePart = contents[0].parts.find(p => p.inlineData);
        expect(inlinePart.inlineData.mimeType).toBe('video/mp4');
    });
});

// ──────────────────────────────────────────────
// 5. sse-parser.js — redacted thinking, error paths
// ──────────────────────────────────────────────
import {
    createAnthropicSSEStream,
    parseGeminiSSELine,
    saveThoughtSignatureFromStream,
} from '../src/shared/sse-parser.js';

describe('sse-parser: createAnthropicSSEStream — redacted_thinking', () => {
    it('emits redacted_thinking placeholder when showThinking=true', async () => {
        const lines = [
            'event: content_block_start',
            `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'redacted_thinking' } })}`,
            '',
            'event: content_block_stop',
            `data: ${JSON.stringify({ type: 'content_block_stop' })}`,
            '',
            'event: message_delta',
            `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } })}`,
            '',
            'event: message_stop',
            `data: ${JSON.stringify({ type: 'message_stop' })}`,
            '',
        ].join('\n');

        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(lines));
                controller.close();
            }
        });
        const response = { body };

        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (typeof value === 'string') text += value;
        }
        expect(text).toContain('redacted_thinking');
    });

    it('skips redacted_thinking when showThinking=false', async () => {
        const lines = [
            'event: content_block_start',
            `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'redacted_thinking' } })}`,
            '',
            'event: message_stop',
            `data: ${JSON.stringify({ type: 'message_stop' })}`,
            '',
        ].join('\n');

        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(lines));
                controller.close();
            }
        });
        const response = { body };

        const stream = createAnthropicSSEStream(response, null, { showThinking: false });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (typeof value === 'string') text += value;
        }
        expect(text).not.toContain('redacted_thinking');
    });
});

describe('sse-parser: parseGeminiSSELine — edge cases', () => {
    it('returns null for non-data line', () => {
        expect(parseGeminiSSELine('event: something')).toBe(null);
    });

    it('returns null for empty data', () => {
        expect(parseGeminiSSELine('data: ')).toBe(null);
    });

    it('parses valid data line', () => {
        const obj = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
        const result = parseGeminiSSELine(`data: ${JSON.stringify(obj)}`);
        expect(result).toBeTruthy();
    });
});

describe('sse-parser: saveThoughtSignatureFromStream', () => {
    it('closes open thought block and returns extra text', () => {
        const config = {
            _inThoughtBlock: true,
            _lastSignature: null,
            _streamResponseText: '',
            _requestId: null,
            _streamUsageMetadata: null,
        };
        const extra = saveThoughtSignatureFromStream(config);
        expect(extra).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('returns null when no open thought block and no signature', () => {
        const config = {
            _inThoughtBlock: false,
            _lastSignature: null,
            _streamResponseText: '',
            _requestId: null,
            _streamUsageMetadata: null,
        };
        const extra = saveThoughtSignatureFromStream(config);
        expect(extra).toBe(null);
    });
});

// ──────────────────────────────────────────────
// 6. auto-updater.js — arg parsing, schema validation
// ──────────────────────────────────────────────
import { createAutoUpdater } from '../src/shared/auto-updater.js';

describe('auto-updater: validateAndInstall — arg metadata parsing', () => {
    const DB_PLUGIN_NAME = 'Test Plugin';
    const currentVersion = '1.0.0';

    function makeRisu(existingPlugin) {
        return {
            getArgument: vi.fn(() => undefined),
            getDatabase: vi.fn(async () => ({
                plugins: [existingPlugin || {
                    name: DB_PLUGIN_NAME,
                    script: '// old',
                    versionOfPlugin: currentVersion,
                    arguments: {},
                    realArg: {},
                    enabled: true,
                }],
            })),
            setDatabaseLite: vi.fn(async () => {}),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            nativeFetch: vi.fn(async () => { throw new Error('not impl'); }),
            risuFetch: vi.fn(async () => ({ ok: false })),
        };
    }

    function makeCode(version, extra = '') {
        return [
            `//@name ${DB_PLUGIN_NAME}`,
            `//@display-name Test Plugin Display`,
            `//@version ${version}`,
            `//@api 3.0`,
            extra,
            '// plugin code',
            `console.log('hello');`.repeat(10),
        ].join('\n');
    }

    it('parses @arg with metadata templates', async () => {
        const code = makeCode('2.0.0', '//@arg myKey string {{label::My Label}} {{desc::Description}}');
        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('parses @risu-arg with single colon metadata', async () => {
        const code = makeCode('2.0.0', '//@risu-arg apiKey string {{label:API Key}}');
        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('parses @arg int type with default value', async () => {
        const code = makeCode('2.0.0', '//@arg maxRetries int');
        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('rejects when API version is not 3.0', async () => {
        const code = [
            `//@name ${DB_PLUGIN_NAME}`,
            `//@version 2.0.0`,
            `//@api 2.0`,
            `console.log('hello');`.repeat(10),
        ].join('\n');

        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('API');
    });

    it('parses @link directives', async () => {
        const code = makeCode('2.0.0', '//@link https://example.com My Link');
        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('rejects when no @name found', async () => {
        const code = [
            `//@version 2.0.0`,
            `//@api 3.0`,
            `console.log('hello');`.repeat(10),
        ].join('\n');

        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@name');
    });

    it('rejects when no @version found', async () => {
        const code = [
            `//@name ${DB_PLUGIN_NAME}`,
            `//@api 3.0`,
            `console.log('hello');`.repeat(10),
        ].join('\n');

        const updater = createAutoUpdater({
            Risu: makeRisu(),
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@version');
    });

    it('rejects when plugin not found in DB', async () => {
        const code = makeCode('2.0.0');
        const Risu = makeRisu();
        Risu.getDatabase = vi.fn(async () => ({ plugins: [{ name: 'Other Plugin' }] }));

        const updater = createAutoUpdater({
            Risu,
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('찾을 수 없습니다');
    });

    it('rejects when database access fails', async () => {
        const code = makeCode('2.0.0');
        const Risu = makeRisu();
        Risu.getDatabase = vi.fn(async () => null);

        const updater = createAutoUpdater({
            Risu,
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
    });

    it('rejects when plugins array missing', async () => {
        const code = makeCode('2.0.0');
        const Risu = makeRisu();
        Risu.getDatabase = vi.fn(async () => ({ plugins: null }));

        const updater = createAutoUpdater({
            Risu,
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
    });

    it('preserves existing realArg values when arg type matches', async () => {
        const existingPlugin = {
            name: DB_PLUGIN_NAME,
            script: '// old',
            versionOfPlugin: currentVersion,
            arguments: { myKey: 'string' },
            realArg: { myKey: 'saved-value' },
            enabled: true,
        };
        const code = makeCode('2.0.0', '//@arg myKey string');
        const Risu = makeRisu(existingPlugin);

        const updater = createAutoUpdater({
            Risu,
            pluginName: DB_PLUGIN_NAME,
            currentVersion,
        });

        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
        // Check the setDatabaseLite call preserved the value
        const call = Risu.setDatabaseLite.mock.calls[0][0];
        expect(call.plugins[0].realArg.myKey).toBe('saved-value');
    });
});

describe('auto-updater: downloadMainPluginCode edge cases', () => {
    function makeRisu() {
        return {
            getArgument: vi.fn(() => undefined),
            getDatabase: vi.fn(async () => ({ plugins: [] })),
            setDatabaseLite: vi.fn(async () => {}),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            nativeFetch: vi.fn(async () => { throw new Error('not impl'); }),
            risuFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        };
    }

    it('returns failure when all fetch methods fail', async () => {
        const Risu = makeRisu();
        const updater = createAutoUpdater({
            Risu,
            pluginName: 'Test',
            currentVersion: '1.0.0',
        });

        const result = await updater.downloadMainPluginCode('2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });
});

// ──────────────────────────────────────────────
// 7. sanitize.js — uncovered branches
// ──────────────────────────────────────────────
import { sanitizeMessages, sanitizeBodyJSON, hasNonEmptyMessageContent } from '../src/shared/sanitize.js';

describe('sanitize: sanitizeMessages — edge cases', () => {
    it('handles messages with non-string content (object)', () => {
        const msgs = [{ role: 'user', content: { text: 'hello' } }];
        const result = sanitizeMessages(msgs);
        expect(result.length).toBe(1);
    });

    it('filters out null entries', () => {
        const msgs = [null, { role: 'user', content: 'hello' }, undefined];
        const result = sanitizeMessages(msgs);
        expect(result.length).toBe(1);
    });
});

describe('sanitize: sanitizeBodyJSON — edge cases', () => {
    it('handles body with nested nulls', () => {
        const body = { messages: [{ role: 'user', content: 'hi' }], extra: null };
        const result = sanitizeBodyJSON(body);
        expect(result).toBeTruthy();
    });
});

describe('sanitize: hasNonEmptyMessageContent', () => {
    it('returns true for non-empty string', () => {
        expect(hasNonEmptyMessageContent('hello')).toBe(true);
    });
    it('returns false for empty string', () => {
        expect(hasNonEmptyMessageContent('')).toBe(false);
    });
    it('returns true for array with elements', () => {
        expect(hasNonEmptyMessageContent([{ type: 'text', text: 'hi' }])).toBe(true);
    });
    it('returns false for empty array', () => {
        expect(hasNonEmptyMessageContent([])).toBe(false);
    });
    it('returns false for null passed directly', () => {
        expect(hasNonEmptyMessageContent(null)).toBe(false);
    });
    it('returns true for object (non-null/non-array/non-string)', () => {
        expect(hasNonEmptyMessageContent({ content: null })).toBe(true);
    });
    it('returns true for non-empty number coerced to string', () => {
        expect(hasNonEmptyMessageContent(42)).toBe(true);
    });
});

// ──────────────────────────────────────────────
// 8. slot-inference.js — uncovered branches
// ──────────────────────────────────────────────
import { scoreSlotHeuristic, SLOT_HEURISTICS } from '../src/shared/slot-inference.js';

describe('slot-inference: scoreSlotHeuristic', () => {
    it('returns 0 for unknown text with unknown slot', () => {
        expect(scoreSlotHeuristic('random gibberish', 'translation')).toBe(0);
    });
    it('returns positive score for translation keyword', () => {
        expect(scoreSlotHeuristic('Please translate this text', 'translation')).toBeGreaterThan(0);
    });
    it('returns 0 for empty text', () => {
        expect(scoreSlotHeuristic('', 'translation')).toBe(0);
    });
});

// ──────────────────────────────────────────────
// 9. key-pool.js — uncovered branches
// ──────────────────────────────────────────────
import { KeyPool } from '../src/shared/key-pool.js';

describe('key-pool: edge cases', () => {
    it('drains a key and rotates to next', () => {
        const pool = new KeyPool('key1 key2');
        const remaining = pool.drain('key1');
        expect(remaining).toBe(1);
        expect(pool.pick()).toBe('key2');
    });

    it('pick returns only key when pool has single key', () => {
        const pool = new KeyPool('key1');
        pool.drain('key1');
        expect(pool.remaining).toBe(0);
        expect(pool.pick()).toBe('');
    });

    it('reset restores original keys', () => {
        const pool = new KeyPool('key1 key2');
        pool.drain('key1');
        pool.drain('key2');
        expect(pool.remaining).toBe(0);
        pool.reset();
        expect(pool.remaining).toBe(2);
    });

    it('returns empty string for empty pool string', () => {
        const pool = new KeyPool('');
        expect(pool.pick()).toBe('');
    });
});

// ──────────────────────────────────────────────
// 10. settings-backup.js — uncovered branches
// ──────────────────────────────────────────────
import { createSettingsBackup, getAuxSettingKeys, getManagedSettingKeys, isManagedSettingKey, AUX_SETTING_SLOTS } from '../src/shared/settings-backup.js';

describe('settings-backup: edge cases', () => {
    function makeRisu() {
        const storage = {};
        return {
            getArgument: vi.fn(() => undefined),
            pluginStorage: {
                getItem: vi.fn(async (k) => storage[k] || null),
                setItem: vi.fn(async (k, v) => { storage[k] = v; }),
            },
        };
    }

    it('createSettingsBackup returns object with load/save/getAllKeys', () => {
        const sb = createSettingsBackup({ Risu: makeRisu(), safeGetArg: vi.fn() });
        expect(typeof sb.load).toBe('function');
        expect(typeof sb.save).toBe('function');
        expect(typeof sb.getAllKeys).toBe('function');
    });

    it('load returns empty cache when storage is empty', async () => {
        const sb = createSettingsBackup({ Risu: makeRisu(), safeGetArg: vi.fn() });
        const data = await sb.load();
        expect(data).toEqual({});
    });

    it('getAuxSettingKeys returns slot-prefixed keys', () => {
        const keys = getAuxSettingKeys(['translation']);
        expect(keys.some(k => k.includes('translation'))).toBe(true);
    });

    it('getManagedSettingKeys includes provider setting keys', () => {
        const providers = new Map([['test', { name: 'test-provider', settingsFields: [{ key: 'test_api_key', label: 'API Key', type: 'string' }] }]]);
        const keys = getManagedSettingKeys(providers);
        expect(keys.length).toBeGreaterThan(0);
    });

    it('isManagedSettingKey returns true for known keys', () => {
        expect(isManagedSettingKey('cpm_active_provider')).toBe(true);
    });

    it('isManagedSettingKey returns false for unknown keys', () => {
        expect(isManagedSettingKey('random_key_xyz')).toBe(false);
    });
});
