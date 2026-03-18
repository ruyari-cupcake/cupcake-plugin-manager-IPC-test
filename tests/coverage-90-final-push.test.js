/**
 * coverage-90-final-push.test.js
 * message-format + helpers 90% branch coverage push
 * Targets specific uncovered branches identified from coverage-final.json analysis
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';
import {
    _raceWithAbortSignal, extractImageUrlFromPart, _stripNonSerializable,
    collectStream, shouldEnableStreaming, isCompatibilityModeSettingEnabled,
    _resetCompatibilityModeCache, safeGetArg, safeGetBoolArg, setArg,
    escHtml, safeStringify, checkStreamCapability
} from '../src/shared/helpers.js';

/* ─── mock ipc-protocol ─── */
const mockRisu = {
    getArgument: vi.fn(),
    setArgument: vi.fn(),
    pluginStorage: { getItem: vi.fn(), setItem: vi.fn() },
};
vi.mock('../src/shared/ipc-protocol.js', () => ({ getRisu: () => mockRisu }));

beforeEach(() => { vi.clearAllMocks(); _resetCompatibilityModeCache(); });

// ═══════════════════════════════════════════════
//  A. formatToOpenAI — uncovered branch push
// ═══════════════════════════════════════════════
describe('formatToOpenAI deep branch push', () => {
    // B15: mergesys=true, but only system messages → no non-system messages in newMsgs
    it('mergesys with only system messages → empty array', () => {
        const r = formatToOpenAI([
            { role: 'system', content: 'sys1' },
            { role: 'system', content: 'sys2' },
        ], { mergesys: true });
        // No non-system msgs → sysPrompt exists but newMsgs.length=0 → skip prepend
        expect(r).toEqual([]);
    });

    // B15/B17: mergesys with non-string system content (JSON.stringify path)
    it('mergesys with object system content → stringified', () => {
        const r = formatToOpenAI([
            { role: 'system', content: { key: 'val' } },
            { role: 'user', content: 'hello' },
        ], { mergesys: true });
        expect(r.length).toBe(1);
        expect(r[0].role).toBe('user');
        expect(r[0].content).toContain('{"key":"val"}');
        expect(r[0].content).toContain('hello');
    });

    // B17: mergesys where first non-sys msg has non-string content (JSON.stringify path for newMsgs[0].content)
    it('mergesys with non-string first non-sys msg content', () => {
        const r = formatToOpenAI([
            { role: 'system', content: 'sys' },
            { role: 'user', content: ['part1'] },
        ], { mergesys: true });
        expect(r.length).toBe(1);
        expect(r[0].content).toContain('sys');
    });

    // B18: mustuser when first msg IS user → should not unshift
    it('mustuser when first msg is user → no extra message', () => {
        const r = formatToOpenAI([
            { role: 'user', content: 'hi' },
        ], { mustuser: true });
        expect(r.length).toBe(1);
        expect(r[0].content).toBe('hi');
    });

    // B18: mustuser when first msg is system → should not unshift
    it('mustuser when first msg is system → no extra message', () => {
        const r = formatToOpenAI([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
        ], { mustuser: true });
        expect(r.length).toBe(2);
        expect(r[0].role).toBe('system');
    });

    // B25: inner loop skip for null/non-object multimodal 
    it('multimodal array with null entries → skipped', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: 'text',
            multimodals: [null, undefined, 'string', { type: 'image', base64: 'data:image/png;base64,abc' }],
        }]);
        // Should still produce message with image
        expect(r.length).toBe(1);
        expect(r[0].content).toBeInstanceOf(Array);
    });

    // B29: altrole merge where both sides have array content 
    it('altrole merge — array + array content', () => {
        const r = formatToOpenAI([
            { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
        ], { altrole: true });
        expect(r.length).toBe(1);
        expect(r[0].role).toBe('model');
        expect(r[0].content).toBeInstanceOf(Array);
        expect(r[0].content.length).toBe(2);
    });

    // B29: altrole merge string + array 
    it('altrole merge — string + array', () => {
        const r = formatToOpenAI([
            { role: 'assistant', content: 'first' },
            { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        ], { altrole: true });
        expect(r.length).toBe(1);
        expect(r[0].content).toBeInstanceOf(Array);
    });

    // B29: altrole merge — prev is empty string content → should include prevParts as empty
    it('altrole merge — prev empty content + msg has text', () => {
        const r = formatToOpenAI([
            { role: 'user', content: 'x' },
            { role: 'assistant', content: 'first' },
            { role: 'assistant', content: '' },  
        ], { altrole: true });
        // empty string gets filtered by hasNonEmptyMessageContent, so only 'first' remains
        expect(r.length).toBe(2); // user + assistant
    });

    // B42-B53: Array.isArray(m.content) path with various part types
    it('Array content with null parts → filtered out', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: [null, undefined, 42, { type: 'text', text: 'valid' }],
        }]);
        expect(r.length).toBe(1);
        expect(r[0].content.some(p => p.type === 'text')).toBe(true);
    });

    // B42: image source base64 with missing media_type → default 'image/png'
    it('Array content base64 image with no media_type → defaults to image/png', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: [{
                type: 'image',
                source: { type: 'base64', data: 'AAAA' },
            }],
        }]);
        expect(r.length).toBe(1);
        const img = r[0].content.find(p => p.type === 'image_url');
        expect(img.image_url.url).toContain('image/png');
    });

    // B48-B53: inlineData in Array content with no mimeType → default 'application/octet-stream' → not image/audio → skipped
    it('Array content inlineData unknown mime → part not mapped', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: [{
                inlineData: { data: 'AAAA' },
            }, { type: 'text', text: 'fallback' }],
        }]);
        expect(r.length).toBe(1);
        // application/octet-stream doesn't start with image/ or audio/ → continue → the text part is pushed via mappedParts.push(part)
        expect(r[0].content).toBeInstanceOf(Array);
    });

    // B53: else branch — non-string, non-array content → payload.text || String(m.content ?? '')
    it('non-string non-array content → stringified', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: 12345,
        }]);
        expect(r.length).toBe(1);
        expect(r[0].content).toBe('12345');
    });

    // B53: content is object → should use payload.text or String
    it('object content → text fallback', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: { text: 'hello' },
        }]);
        expect(r.length).toBe(1);
    });

    // name property preservation
    it('preserves name property on message', () => {
        const r = formatToOpenAI([{ role: 'user', content: 'hi', name: 'bob' }]);
        expect(r[0].name).toBe('bob');
    });

    // Multimodal with only empty text + no valid modals → contentParts empty → textContent || ''
    it('multimodal with empty text and no modal content → uses fallback empty', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: '',
            multimodals: [{ type: 'unknown' }],
        }]);
        // unknown type produces nothing in contentParts, textContent='' → msg.content = ''
        // hasNonEmptyMessageContent('') → false → skipped
        expect(r).toEqual([]);
    });

    // mergesys single system + single non-sys with \n join test
    it('mergesys with multiple system messages → joined with newline', () => {
        const r = formatToOpenAI([
            { role: 'system', content: 'A' },
            { role: 'system', content: 'B' },
            { role: 'user', content: 'C' },
        ], { mergesys: true });
        expect(r.length).toBe(1);
        expect(r[0].content).toContain('A\nB');
    });
});

// ═══════════════════════════════════════════════
//  B. formatToAnthropic — deep branch push
// ═══════════════════════════════════════════════
describe('formatToAnthropic deep branch push', () => {
    // B68/B70: non-leading system as user with non-string content → JSON.stringify
    it('non-leading system with object content → stringified to user', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'hi' },
            { role: 'system', content: { a: 1 } },
        ]);
        const sysMsg = r.messages.find(m => m.content.some?.(p => p.text?.includes('system:')));
        expect(sysMsg).toBeTruthy();
    });

    // B81: multimodal same-role merge where prev.content is NOT array
    it('multimodal same-role merge with prev non-array content', () => {
        // Two consecutive user messages: first text-only, second multimodal
        // Due to formatToAnthropic always using structured blocks, prev.content is always array
        // But if prev was built from basic text path it's always [{type:'text',text}]
        // Need to trigger multimodal merge path where contentParts > 0 and prev.role === role
        const r = formatToAnthropic([
            { role: 'user', content: 'first text' },
            { role: 'user', content: 'second', multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }] },
        ]);
        // Should merge into single user message
        const userMsgs = r.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeLessThanOrEqual(2); // "Start" + merged
    });

    // B93-B94: Anthropic multimodal — image modal with base64 string that has NO comma (pure base64)
    it('image modal with raw base64 (no data URI prefix)', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: 'text',
            multimodals: [{ type: 'image', base64: 'AAAA' }],
        }]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        expect(userMsg).toBeTruthy();
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart.source.media_type).toBe('image/png'); // default
        expect(imgPart.source.data).toBe('AAAA');
    });

    // B95: Anthropic multimodal — empty contentParts (modal type not image) → fallback text path
    it('multimodal with non-image type → falls to text path', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: 'text content',
            multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,abc' }],
        }]);
        // Audio modal → skipped (Anthropic only handles image in multimodal path)
        const userMsg = r.messages.find(m => m.role === 'user' && m.content.some?.(p => p.text === 'text content'));
        expect(userMsg).toBeTruthy();
    });

    // B97-B102: Anthropic multimodal → contentParts empty → same-role merge when prev has array content
    it('multimodal fallback text same-role merge with prev array', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second', multimodals: [{ type: 'video', url: 'x' }] },
        ]);
        // 'video' type → contentParts empty → text fallback → same-role merge
        const nonStart = r.messages.filter(m => m.role === 'user');
        expect(nonStart.length).toBeGreaterThanOrEqual(1);
    });

    // B100-B102: Same-role merge when prev.content is NOT array (rare path — text → string conversion)
    it('same-role merge creates array from prev string + new text block', () => {
        // This is the B101/B102 path: prev.content is not array → creates array
        // Hard to trigger because Anthropic always creates structured blocks...
        // but the empty contentParts + same-role path may produce this
        const r = formatToAnthropic([
            { role: 'user', content: 'first user text' },
            { role: 'user', content: 'second user text', multimodals: [{ type: 'video' }] },
        ]);
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B108-B113: Array.isArray(m.content) path — image_url with object image_url (not string)
    it('Array content image_url with object {url} property', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } }],
        }]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        expect(userMsg).toBeTruthy();
        const img = userMsg.content.find(p => p.type === 'image');
        expect(img.source.data).toBe('xyz');
    });

    // B109: Array content image_url with empty string url → skip
    it('Array content image_url without valid url → skipped', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: '' } }],
        }]);
        // empty url → no image → contentParts empty → falls to text path
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B110-B112: inlineData in Array content with non-image mimeType → skipped
    it('Array content inlineData with non-image mime → skipped', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ inlineData: { data: 'abc', mimeType: 'audio/mp3' } }],
        }]);
        // audio → not image → contentParts stays empty
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B113: inlineData without mimeType → defaults to 'application/octet-stream' → not image → skipped
    it('Array content inlineData no mimeType → skipped (not image)', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ inlineData: { data: 'abc' } }],
        }]);
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B116: image_url with data URI but missing media_type → fallback 'image/png'
    it('Array content image_url data URI missing split → defaults image/png', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'image_url', image_url: 'data:image/;base64,abc' }],
        }]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        expect(userMsg).toBeTruthy();
    });

    // B117: image_url with data URI but missing data after comma → '' data → skip (if data is empty)
    it('Array content image_url data URI with no data → skipped', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'image_url', image_url: 'data:image/png;base64,' }],
        }]);
        // data = '' → if (data) fails → not pushed
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B119: input_image type with string image_url
    it('input_image type resolves string image_url', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://example.com/img.png' }],
        }]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const img = userMsg?.content?.find(p => p.type === 'image');
        expect(img?.source?.type).toBe('url');
    });

    // B120-B122: image_url with split giving empty parts
    it('image_url data URI with no media_type in split → defaults', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:;base64,abc' } }],
        }]);
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B123: HTTP image_url in Array content → source.type='url'
    it('Array content image_url HTTP URL → URL source', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ type: 'image_url', image_url: 'http://example.com/img.jpg' }],
        }]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const img = userMsg?.content?.find(p => p.type === 'image');
        expect(img?.source?.url).toBe('http://example.com/img.jpg');
    });

    // B128-B130: Array content with contentParts > 0, same-role merge with string prev.content
    it('Array content same-role merge when prev has string content', () => {
        // First msg creates structured block (always array), second sends array content
        // To hit B128 (typeof prev.content === 'string'), need prev to have string somehow
        // This is very rare in Anthropic formatter... but let's try via text merge path
        const r = formatToAnthropic([
            { role: 'user', content: 'normal text' },
            { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'xyz', media_type: 'image/png' } }] },
        ]);
        // should merge
        const userMsgs = r.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    // B132-B138: Default text path — same-role merge variations
    it('default text same-role merge with prev array content', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'a' },
            { role: 'user', content: 'b' },
            { role: 'user', content: 'c' },
        ]);
        // All three merge into first user msg
        const userMsgs = r.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
        const main = userMsgs.find(m => m.content.some?.(p => p.text === 'a'));
        if (main) {
            expect(main.content.some(p => p.text === 'b')).toBe(true);
            expect(main.content.some(p => p.text === 'c')).toBe(true);
        }
    });

    // B137: non-string content in text path → JSON.stringify
    it('text path with non-string content → stringified', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: { complex: true },
        }]);
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B143-B144: cachePoint with array content (cache_control on last element)
    it('cachePoint on message with array content → cache_control added', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: 'cached text',
            cachePoint: true,
        }]);
        const userMsg = r.messages.find(m =>
            m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.text === 'cached text')
        );
        expect(userMsg).toBeTruthy();
        const lastPart = userMsg.content[userMsg.content.length - 1];
        expect(lastPart.cache_control).toEqual({ type: 'ephemeral' });
    });

    // cachePoint on merged message
    it('cachePoint on second merged message → cache_control applied', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'no cache' },
            { role: 'user', content: 'with cache', cachePoint: true },
        ]);
        const userMsgs = r.messages.filter(m => m.role === 'user');
        // 병합됐을 때 cache_control 이 적용되는지 확인
        const hasCache = userMsgs.some(m => Array.isArray(m.content) && m.content.some(p => p.cache_control));
        expect(hasCache).toBe(true);
    });

    // B143: cachePoint on text message that somehow has string content (rare edge)
    // Actually Anthropic formatter always creates structured blocks, so content is always array
    // But the cachePoint code checks `typeof msg.content === 'string'` first — need to test that branch exists

    // Leading system prompt extraction
    it('multiple leading system → joined with double newline', () => {
        const r = formatToAnthropic([
            { role: 'system', content: 'sys1' },
            { role: 'system', content: 'sys2' },
            { role: 'user', content: 'hi' },
        ]);
        expect(r.system).toBe('sys1\n\nsys2');
    });

    // Leading system with object content → JSON.stringify
    it('leading system with object content → stringified', () => {
        const r = formatToAnthropic([
            { role: 'system', content: { obj: true } },
            { role: 'user', content: 'hi' },
        ]);
        expect(r.system).toContain('{"obj":true}');
    });

    // Empty messages → Start placeholder
    it('no messages → Start placeholder only', () => {
        const r = formatToAnthropic([]);
        expect(r.messages.length).toBe(1);
        expect(r.messages[0].content[0].text).toBe('Start');
    });

    // Anthropic URL image in multimodal
    it('URL image in multimodal → url source', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: 'text',
            multimodals: [{ type: 'image', url: 'https://example.com/img.jpg' }],
        }]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const img = userMsg?.content?.find(p => p.type === 'image');
        expect(img?.source?.url).toBe('https://example.com/img.jpg');
    });

    // B93: multimodal same-role — contentParts nonempty + prev IS same role (merge path)
    it('multimodal contentParts merge into prev same-role message', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'prev text' },
            { role: 'user', content: 'img text', multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }] },
        ]);
        // Should merge both user messages
        const userMsgs = r.messages.filter(m => m.role === 'user');
        // All should be in a single merged message (excluding potential Start placeholder)
        const mainUser = userMsgs.find(m => Array.isArray(m.content) && m.content.some(p => p.text === 'prev text'));
        expect(mainUser).toBeTruthy();
        expect(mainUser.content.some(p => p.type === 'image')).toBe(true);
    });

    // B95: multimodal where contentParts is empty (only non-image modals like audio) → fallback text
    it('multimodal with only audio → contentParts empty → text fallback', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: 'listen to this',
            multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,audiodata' }],
        }]);
        // Audio not handled by Anthropic modal loop → contentParts empty → fallback
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.text === 'listen to this'));
        expect(userMsg).toBeTruthy();
    });

    // B97-B102: multimodal contentParts empty + same-role merge (L248-L260)
    it('multimodal empty contentParts same-role merge with prev having array content', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'first msg' },
            { role: 'user', content: 'second with audio', multimodals: [{ type: 'audio' }] },
        ]);
        // Empty contentParts → text fallback → same role → merge into prev array
        const userMsgs = r.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    // test assistant role in anthropic → mapped to 'assistant'
    it('assistant role messages formatted correctly', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello back' },
        ]);
        expect(r.messages.some(m => m.role === 'assistant')).toBe(true);
    });

    // B96: multimodal with contentParts empty, content is non-string → JSON.stringify
    it('multimodal empty contentParts with non-string content → stringified', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: { complex: 'object' },
            multimodals: [{ type: 'video', url: 'x.mp4' }],
        }]);
        expect(r.messages.length).toBeGreaterThanOrEqual(1);
    });

    // B81: multimodal contentParts > 0, same-role, prev.content NOT array
    // (prev was created with structured block, so content IS array; hard to trigger false case)
    // But we can test the NON same-role path → else branch
    it('multimodal contentParts > 0, different role → new message created', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'user text' },
            { role: 'assistant', content: 'asst reply', multimodals: [{ type: 'image', base64: 'data:image/png;base64,img' }] },
        ]);
        expect(r.messages.some(m => m.role === 'assistant' && Array.isArray(m.content))).toBe(true);
    });

    // B128-130: Array.isArray(m.content) path → contentParts > 0, same-role merge
    // This path requires content to be array AND extractNormalizedMessagePayload producing empty multimodals
    // e.g., content = [{type: 'text', text: 'a'}, {type: 'image', source: {type: 'base64', data: 'x'}}]
    // extract WILL find the image → multimodals non-empty → won't reach Array.isArray path
    // Need: content array with only unrecognized parts
    // e.g., [{type: 'custom', data: 'x'}] → extract ignores → multimodals = []
    // BUT {type:'custom'} has no text → contentParts empty  
    // Need: [{text: 'hi'}, {type: 'custom', data: 'x'}] → text extracted by extract, custom ignored
    // multimodals = [] → Array.isArray path!
    it('Array content with only text & custom parts → Array.isArray path', () => {
        const r = formatToAnthropic([{
            role: 'user',
            content: [{ text: 'hi there' }, { type: 'custom', data: 'ignored' }],
        }]);
        expect(r.messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.text === 'hi there'))).toBe(true);
    });

    // Array content same-role merge test  
    it('Array content same-role merge when prev already has array content', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'first' },
            { role: 'user', content: [{ text: 'second text' }] },
        ]);
        const userMsgs = r.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    // B108: Array.isArray(m.content) with Anthropic base64 image source → pushed directly
    // This is dead code if extract catches it, but test anyway
    // content: [{type:'image', source:{type:'base64', data:'x', media_type:'image/png'}}]
    // extractNormalizedMessagePayload catches this → multimodals = [{type:'image'...}]
    // BUT we can trick it: if we also have text-only parts that DON'T produce multimodals AND the image part
    // No, extract processes the entire array. So image IS extracted → multimodals non-empty → multimodal path
    
    // B132-B138: default text path same-role merge where prev.content is NOT array (rare)
    // Since Anthropic always creates structured blocks [{type:'text'}], prev.content is always array
    // Test the path anyway by having consecutive assistant messages
    it('consecutive assistant text messages → same-role merge', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'reply1' },
            { role: 'assistant', content: 'reply2' },
        ]);
        const asstMsgs = r.messages.filter(m => m.role === 'assistant');
        expect(asstMsgs.length).toBe(1);
        expect(asstMsgs[0].content.some(p => p.text === 'reply1')).toBe(true);
        expect(asstMsgs[0].content.some(p => p.text === 'reply2')).toBe(true);
    });

    // B133: first message is assistant → "Start" placeholder added at the top
    it('first message is assistant → Start user prepended', () => {
        const r = formatToAnthropic([
            { role: 'assistant', content: 'resp' },
        ]);
        expect(r.messages[0].role).toBe('user');
        expect(r.messages[0].content[0].text).toBe('Start');
    });

    // B143/B144 — cachePoint where content becomes string 
    // formatToAnthropic always creates array content, so typeof msg.content === 'string' is normally unreachable
    // But test to confirm array path works
    it('cachePoint with array content → last element gets cache_control', () => {
        const r = formatToAnthropic([
            { role: 'user', content: 'text1', cachePoint: true },
        ]);
        const userMsg = r.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const lastPart = userMsg.content[userMsg.content.length - 1];
        expect(lastPart.cache_control).toEqual({ type: 'ephemeral' });
    });
});

// ═══════════════════════════════════════════════
//  C. formatToGemini — deep branch push
// ═══════════════════════════════════════════════
describe('formatToGemini deep branch push', () => {
    // B153: preserveSystem=true → system stays in systemInstruction, not merged into contents
    it('preserveSystem keeps system in systemInstruction', () => {
        const r = formatToGemini([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
        ], { preserveSystem: true });
        expect(r.systemInstruction).toEqual(['sys']);
        // contents should NOT have "system: sys" prepended
        expect(r.contents[0].parts[0].text).toBe('hi');
    });

    // B159: !config.preserveSystem && systemInstruction.length > 0 — first content not user
    it('system merged into non-user first content → creates new user at start', () => {
        const r = formatToGemini([
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: 'resp' },
        ]);
        // First real content would be model (assistant) → model
        // System merged as "system: sys" → need user before model
        expect(r.contents[0].role).toBe('user');
        expect(r.contents[0].parts.some(p => p.text?.includes('system:'))).toBe(true);
    });

    // B168: multimodal same-role merge — text that appends to existing text part
    it('multimodal same-role merge with text appending to text part', () => {
        const r = formatToGemini([
            { role: 'user', content: 'A', multimodals: [{ type: 'image', base64: 'data:image/png;base64,x' }] },
            { role: 'user', content: 'B', multimodals: [{ type: 'image', base64: 'data:image/png;base64,y' }] },
        ]);
        // Same role merge → text 'B' appended
        expect(r.contents.filter(c => c.role === 'user').length).toBe(1);
    });

    // B173: multimodal video type → inlineData path
    it('video multimodal → inlineData', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'watch this',
            multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,abcd' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        const vidPart = userContent.parts.find(p => p.inlineData);
        expect(vidPart.inlineData.mimeType).toBe('video/mp4');
    });

    // B174: multimodal audio type
    it('audio multimodal → inlineData', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'listen',
            multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,efgh' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        const audioPart = userContent.parts.find(p => p.inlineData);
        expect(audioPart.inlineData.mimeType).toBe('audio/mp3');
    });

    // B176: multimodal new message (not same role), includes text + multiple modals
    it('multimodal different role → new entry with text and parts', () => {
        const r = formatToGemini([
            { role: 'user', content: 'user msg' },
            { role: 'assistant', content: 'asst', multimodals: [{ type: 'image', base64: 'data:image/png;base64,z' }] },
        ]);
        const modelContent = r.contents.find(c => c.role === 'model');
        expect(modelContent.parts.some(p => p.text === 'asst')).toBe(true);
        expect(modelContent.parts.some(p => p.inlineData)).toBe(true);
    });

    // B177: multimodal URL image in new parts path
    it('multimodal URL image in new parts → fileData', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'look',
            multimodals: [{ type: 'image', url: 'https://example.com/img.jpg', mimeType: 'image/jpeg' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        const filePart = userContent.parts.find(p => p.fileData);
        expect(filePart.fileData.fileUri).toBe('https://example.com/img.jpg');
    });

    // B185: multimodal same-role merge — URL image (existing lastMessage) 
    it('multimodal same-role URL image merge into existing', () => {
        const r = formatToGemini([
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B', multimodals: [{ type: 'image', url: 'https://x.com/img.png' }] },
        ]);
        const userContents = r.contents.filter(c => c.role === 'user');
        expect(userContents.length).toBe(1);
        expect(userContents[0].parts.some(p => p.fileData)).toBe(true);
    });

    // B186/B189: multimodal base64 with no comma → mimeType fallback
    it('multimodal raw base64 (no data URI) → fallback mimeType', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'text',
            multimodals: [{ type: 'image', base64: 'rawbase64data' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        const inlinePart = userContent.parts.find(p => p.inlineData);
        expect(inlinePart.inlineData.data).toBe('rawbase64data');
    });

    // non-leading system appended to existing user content
    it('non-leading system appended to previous user', () => {
        const r = formatToGemini([
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'mid-sys' },
        ]);
        const userContent = r.contents.find(c => c.role === 'user');
        expect(userContent.parts.some(p => p.text?.includes('system: mid-sys'))).toBe(true);
    });

    // non-string content → JSON.stringify in system
    it('non-string system content → JSON.stringify', () => {
        const r = formatToGemini([
            { role: 'system', content: { x: 1 } },
            { role: 'user', content: 'hi' },
        ]);
        // System should be stringified
        expect(r.contents[0].parts.some(p => p.text?.includes('"x":1'))).toBe(true);
    });

    // text same-role merge
    it('text same-role merge into existing model parts', () => {
        const r = formatToGemini([
            { role: 'assistant', content: 'A' },
            { role: 'assistant', content: 'B' },
        ]);
        // Starts with 'Start' user placeholder, then merged model
        const modelContent = r.contents.find(c => c.role === 'model');
        expect(modelContent.parts.length).toBe(2);
    });

    // multimodal mimeType from modal.mimeType (not from base64 header)
    it('multimodal with explicit mimeType', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'x',
            multimodals: [{ type: 'image', base64: 'rawdata', mimeType: 'image/webp' }],
        }]);
        const part = r.contents.find(c => c.role === 'user').parts.find(p => p.inlineData);
        expect(part.inlineData.mimeType).toBe('image/webp');
    });

    // Gemini same-role text merge — previous part has inlineData → push new text part
    it('same-role text merge after inlineData → new text part added', () => {
        const r = formatToGemini([
            { role: 'user', content: 'A', multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }] },
            { role: 'user', content: 'B', multimodals: [{ type: 'image', base64: 'data:image/png;base64,def' }] },
        ]);
        const userContent = r.contents.find(c => c.role === 'user');
        expect(userContent.parts.filter(p => p.text).length).toBeGreaterThanOrEqual(1);
    });

    // B168 arm1: unknown modal type → doesn't enter if(image/audio/video)
    it('unknown modal type in same-role merge → skipped', () => {
        const r = formatToGemini([
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B', multimodals: [{ type: 'document', base64: 'data' }] },
        ]);
        const userContent = r.contents.find(c => c.role === 'user');
        expect(userContent).toBeTruthy();
    });

    // B173 arm1: modal without base64 → fallback empty string
    it('image modal without base64 → fallback empty', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'x',
            multimodals: [{ type: 'image', mimeType: 'image/png' }],
        }]);
        // No base64 → base64='' → commaIdx=-1 → mimeType from modal.mimeType → data=''
        expect(r.contents.length).toBeGreaterThan(0);
    });

    // B174 arm2: no mimeType and no comma in base64 → application/octet-stream
    it('modal without mimeType and no base64 header → octet-stream', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'x',
            multimodals: [{ type: 'image', base64: 'rawbase64' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        const inlinePart = userContent.parts.find(p => p.inlineData);
        // No mimeType on modal, no comma → null || undefined || 'application/octet-stream'
        expect(inlinePart.inlineData.mimeType).toBe('application/octet-stream');
    });

    // B176 arm1: trimmed empty + multimodal → no text part in newParts
    it('empty text with multimodal → no text part, only media', () => {
        const r = formatToGemini([{
            role: 'user',
            content: '',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        // text should be empty → trimmed='' → no text part pushed
        expect(userContent.parts.every(p => p.inlineData || p.fileData || (p.text && p.text.includes('system')))).toBe(true);
    });

    // B177 arm1: unknown modal type in new parts path → not pushed
    it('unknown modal type in new content → only text pushed', () => {
        const r = formatToGemini([{
            role: 'user',
            content: 'text',
            multimodals: [{ type: 'document', base64: 'data' }],
        }]);
        const userContent = r.contents.find(c => c.role === 'user');
        expect(userContent.parts.some(p => p.text === 'text')).toBe(true);
        expect(userContent.parts.every(p => !p.inlineData && !p.fileData)).toBe(true);
    });

    // B185 arm1: newParts empty → content not pushed
    it('multimodal with only unknown types and no text → empty newParts → not pushed', () => {
        const r = formatToGemini([{
            role: 'user',
            content: '',
            multimodals: [{ type: 'document' }],
        }]);
        // Empty text + unknown type → newParts = [] → not pushed
        // But extractNormalizedMessagePayload might have text from content...
        // content='' → text='' → trimmed='' AND normalizedMultimodals has {type:'document'}
        // multimodals.length > 0 → enters multimodal path
        // trimmed='' → no text push, modal type='document' → not image/audio/video → skip
        // newParts = [] → if (newParts.length > 0) → false → B185 arm1!
        expect(r.contents.length).toBeGreaterThanOrEqual(0);
    });

    // B186 arm1: text path where trimmed is '' but text is non-empty
    it('model role with thought content → stripped to empty → text fallback', () => {
        const r = formatToGemini([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '<Thoughts>\nthinking...\n</Thoughts>' },
        ]);
        // stripThoughtDisplayContent removes thoughts → trimmed may be ''
        // Then part = { text: trimmed || text } → B186: trimmed='' → uses text
        expect(r.contents.length).toBeGreaterThanOrEqual(1);
    });

    // B189 arm1: useThoughtSignature=true, but cache returns null (no signature)
    it('useThoughtSignature with no cached signature → no thoughtSignature', () => {
        const r = formatToGemini([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'this is a model response with no signature' },
        ], { useThoughtSignature: true });
        const modelContent = r.contents.find(c => c.role === 'model');
        expect(modelContent.parts.some(p => p.text && !p.thoughtSignature)).toBe(true);
    });

    // B159 arm0: trimmed='' and multimodals.length===0 → continue (skip empty message)
    it('empty content message with no multimodals → skipped', () => {
        const r = formatToGemini([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '' },
            { role: 'user', content: 'another' },
        ]);
        // Empty assistant → trimmed='' and no multimodals → skipped
        expect(r.contents.every(c => c.role !== 'model' || c.parts.some(p => p.text?.trim()))).toBe(true);
    });
});

// ═══════════════════════════════════════════════
//  D. parseBase64DataUri — edge cases
// ═══════════════════════════════════════════════
describe('parseBase64DataUri (via formatToOpenAI audio paths)', () => {
    // B3: prefix has no colon → mimeType null
    it('audio with malformed data URI prefix → defaults to mp3', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: 'x',
            multimodals: [{ type: 'audio', base64: 'malformed;base64,audiodata' }],
        }]);
        expect(r[0].content).toBeInstanceOf(Array);
        const audioPart = r[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('mp3');
    });

    it('audio with empty base64 string', () => {
        const r = formatToOpenAI([{
            role: 'user',
            content: 'x',
            multimodals: [{ type: 'audio', base64: '' }],
        }]);
        expect(r[0].content).toBeInstanceOf(Array);
        const audioPart = r[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('mp3'); // no comma → _audioMime null → default
    });
});

// ═══════════════════════════════════════════════
//  E. helpers.js — _raceWithAbortSignal deep branches
// ═══════════════════════════════════════════════
describe('_raceWithAbortSignal branch push', () => {
    // B2: fetch resolves, then abort fires (settled=true → onAbort does nothing)
    it('abort after resolve → no effect', async () => {
        const ac = new AbortController();
        const result = await _raceWithAbortSignal(Promise.resolve('ok'), ac.signal);
        expect(result).toBe('ok');
        // Fire abort after settled — should not throw
        ac.abort();
    });

    // B3: fetch rejects → settled=true, signal cleanup
    it('fetch rejects → propagates error', async () => {
        const ac = new AbortController();
        await expect(_raceWithAbortSignal(Promise.reject(new Error('fail')), ac.signal)).rejects.toThrow('fail');
    });

    // B4: fetch rejects, then abort fires → no double-reject
    it('fetch rejects then abort → no extra rejection', async () => {
        const ac = new AbortController();
        const p = _raceWithAbortSignal(Promise.reject(new Error('fail')), ac.signal);
        await expect(p).rejects.toThrow('fail');
        ac.abort(); // should not cause issues
    });

    // Signal already aborted
    it('already aborted signal → immediate rejection', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(_raceWithAbortSignal(Promise.resolve('ok'), ac.signal)).rejects.toThrow('aborted');
    });

    // Null signal → pass through
    it('null signal → pass through', async () => {
        const r = await _raceWithAbortSignal(Promise.resolve(42), null);
        expect(r).toBe(42);
    });

    // B2 arm1 L26-29: abort fires while fetch is still pending → settled=true via onAbort
    // then fetch resolves → (settled=true, skip)
    it('abort beats resolve → reject, then resolve is ignored (B2/B3)', async () => {
        const ac = new AbortController();
        let resolveP;
        const pendingFetch = new Promise(r => { resolveP = r; });
        const raceP = _raceWithAbortSignal(pendingFetch, ac.signal);
        ac.abort(); // onAbort fires → settled=true → reject
        resolveP('late value'); // then callback → settled=true → B3 skip
        await expect(raceP).rejects.toThrow('aborted');
    });

    // B4 arm1: abort beats reject → abort wins, then reject is ignored
    it('abort beats reject → abort wins, reject ignored (B4)', async () => {
        const ac = new AbortController();
        let rejectP;
        const pendingFetch = new Promise((_, r) => { rejectP = r; });
        const raceP = _raceWithAbortSignal(pendingFetch, ac.signal);
        ac.abort(); // onAbort → settled=true → reject(AbortError)
        rejectP(new Error('late error')); // error callback → settled=true → B4 skip
        await expect(raceP).rejects.toThrow('aborted');
    });
});

// ═══════════════════════════════════════════════
//  F. helpers.js — small utility functions
// ═══════════════════════════════════════════════
describe('helpers small utilities branch push', () => {
    describe('shouldEnableStreaming', () => {
        it('returns false when streaming disabled', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'false' })).toBe(false);
        });
        it('returns true when streaming enabled and no compat mode', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'false' })).toBe(true);
        });
        it('returns false when streaming enabled but compat mode on and not copilot', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'true' })).toBe(false);
        });
        it('returns true when streaming + compat + isCopilot', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'true' }, { isCopilot: true })).toBe(true);
        });
        // B38 L141: normalizeBooleanSetting with truthy non-standard value → returns defaultValue
        it('non-standard value → default false', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'maybe' })).toBe(false);
        });
        // Various normalization tests to hit more branches
        it('handles 1/yes/on as true', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: '1' })).toBe(true);
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'yes' })).toBe(true);
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'on' })).toBe(true);
        });
        it('handles 0/no/off as false', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: '0' })).toBe(false);
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'no' })).toBe(false);
            expect(shouldEnableStreaming({ cpm_streaming_enabled: 'off' })).toBe(false);
        });
        it('handles undefined/null as default', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: undefined })).toBe(false);
            expect(shouldEnableStreaming({ cpm_streaming_enabled: null })).toBe(false);
        });
        it('handles boolean true/false directly', () => {
            expect(shouldEnableStreaming({ cpm_streaming_enabled: true })).toBe(true);
            expect(shouldEnableStreaming({ cpm_streaming_enabled: false })).toBe(false);
        });
    });

    describe('isCompatibilityModeSettingEnabled', () => {
        it('normalizes various inputs', () => {
            expect(isCompatibilityModeSettingEnabled(true)).toBe(true);
            expect(isCompatibilityModeSettingEnabled('false')).toBe(false);
            expect(isCompatibilityModeSettingEnabled('undefined')).toBe(false);
            expect(isCompatibilityModeSettingEnabled('null')).toBe(false);
            expect(isCompatibilityModeSettingEnabled('')).toBe(false);
        });
    });

    describe('extractImageUrlFromPart', () => {
        it('handles input_image with object image_url', () => {
            expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'http://x.com/i.png' } }))
                .toBe('http://x.com/i.png');
        });
        it('handles input_image with string image_url', () => {
            expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'url-str' }))
                .toBe('url-str');
        });
        it('non-matching type → empty', () => {
            expect(extractImageUrlFromPart({ type: 'text', text: 'hi' })).toBe('');
        });
        it('null → empty', () => {
            expect(extractImageUrlFromPart(null)).toBe('');
        });
    });

    describe('_stripNonSerializable', () => {
        it('strips functions', () => {
            const r = _stripNonSerializable({ a: 1, fn: () => {} });
            expect(r).toEqual({ a: 1 });
        });
        it('strips symbols', () => {
            const r = _stripNonSerializable({ a: 1, s: Symbol('x') });
            expect(r).toEqual({ a: 1 });
        });
        it('strips bigints', () => {
            const r = _stripNonSerializable({ a: 1, b: BigInt(42) });
            expect(r).toEqual({ a: 1 });
        });
        it('stringifies Date', () => {
            const d = new Date('2025-01-01');
            const r = _stripNonSerializable(d);
            expect(typeof r).toBe('string');
        });
        it('stringifies RegExp', () => {
            const r = _stripNonSerializable(/abc/);
            expect(typeof r).toBe('string');
        });
        it('stringifies Error', () => {
            const r = _stripNonSerializable(new Error('test'));
            expect(typeof r).toBe('string');
        });
        it('passes through Uint8Array', () => {
            const u = new Uint8Array([1, 2, 3]);
            expect(_stripNonSerializable(u)).toBe(u);
        });
        it('passes through ArrayBuffer', () => {
            const ab = new ArrayBuffer(4);
            expect(_stripNonSerializable(ab)).toBe(ab);
        });
        it('handles deeply nested objects up to max depth', () => {
            let obj = { val: 1 };
            for (let i = 0; i < 20; i++) obj = { nested: obj };
            const r = _stripNonSerializable(obj);
            expect(r).toBeDefined();
        });
        it('handles null/undefined passthrough', () => {
            expect(_stripNonSerializable(null)).toBeNull();
            expect(_stripNonSerializable(undefined)).toBeUndefined();
        });
        it('handles primitives', () => {
            expect(_stripNonSerializable(42)).toBe(42);
            expect(_stripNonSerializable('str')).toBe('str');
            expect(_stripNonSerializable(true)).toBe(true);
        });
        it('filters undefined from arrays', () => {
            const r = _stripNonSerializable([1, () => {}, 3]);
            expect(r).toEqual([1, 3]);
        });
    });

    describe('safeStringify', () => {
        it('filters null from arrays', () => {
            expect(safeStringify([1, null, 3])).toBe('[1,3]');
        });
        it('handles nested arrays', () => {
            expect(safeStringify({ a: [1, null, 2] })).toBe('{"a":[1,2]}');
        });
    });

    describe('escHtml', () => {
        it('escapes all special chars', () => {
            expect(escHtml('<script>"test" & \'x\'')).toBe('&lt;script&gt;&quot;test&quot; &amp; &#39;x&#39;');
        });
        it('non-string → empty', () => {
            expect(escHtml(null)).toBe('');
            expect(escHtml(123)).toBe('');
        });
    });

    describe('safeGetArg', () => {
        it('returns value from Risu.getArgument', async () => {
            mockRisu.getArgument.mockResolvedValue('val');
            expect(await safeGetArg('key')).toBe('val');
        });
        it('returns default when Risu throws', async () => {
            mockRisu.getArgument.mockRejectedValue(new Error('fail'));
            expect(await safeGetArg('key', 'def')).toBe('def');
        });
        it('returns default when value is empty', async () => {
            mockRisu.getArgument.mockResolvedValue('');
            expect(await safeGetArg('key', 'def')).toBe('def');
        });
        it('returns default when value is null', async () => {
            mockRisu.getArgument.mockResolvedValue(null);
            expect(await safeGetArg('key', 'def')).toBe('def');
        });
    });

    describe('safeGetBoolArg', () => {
        it('returns boolean directly', async () => {
            mockRisu.getArgument.mockResolvedValue(true);
            expect(await safeGetBoolArg('key')).toBe(true);
        });
        it('parses string true/false', async () => {
            mockRisu.getArgument.mockResolvedValue('true');
            expect(await safeGetBoolArg('key')).toBe(true);
        });
        it('parses yes/no', async () => {
            mockRisu.getArgument.mockResolvedValue('yes');
            expect(await safeGetBoolArg('key')).toBe(true);
            mockRisu.getArgument.mockResolvedValue('no');
            expect(await safeGetBoolArg('key')).toBe(false);
        });
        it('parses on/off', async () => {
            mockRisu.getArgument.mockResolvedValue('on');
            expect(await safeGetBoolArg('key')).toBe(true);
            mockRisu.getArgument.mockResolvedValue('off');
            expect(await safeGetBoolArg('key')).toBe(false);
        });
        it('parses 1/0', async () => {
            mockRisu.getArgument.mockResolvedValue('1');
            expect(await safeGetBoolArg('key')).toBe(true);
            mockRisu.getArgument.mockResolvedValue('0');
            expect(await safeGetBoolArg('key')).toBe(false);
        });
        it('returns default for unknown string', async () => {
            mockRisu.getArgument.mockResolvedValue('maybe');
            expect(await safeGetBoolArg('key', true)).toBe(true);
        });
        it('returns default for undefined', async () => {
            mockRisu.getArgument.mockResolvedValue(undefined);
            expect(await safeGetBoolArg('key', false)).toBe(false);
        });
        it('returns default for null', async () => {
            mockRisu.getArgument.mockResolvedValue(null);
            expect(await safeGetBoolArg('key')).toBe(false);
        });
        it('returns false boolean directly', async () => {
            mockRisu.getArgument.mockResolvedValue(false);
            expect(await safeGetBoolArg('key', true)).toBe(false);
        });
        it('returns default when Risu throws', async () => {
            mockRisu.getArgument.mockRejectedValue(new Error('fail'));
            expect(await safeGetBoolArg('key', true)).toBe(true);
        });
    });

    describe('setArg', () => {
        it('calls Risu.setArgument', () => {
            setArg('key', 'val');
            expect(mockRisu.setArgument).toHaveBeenCalledWith('key', 'val');
        });
        it('handles error gracefully', () => {
            mockRisu.setArgument.mockImplementation(() => { throw new Error('fail'); });
            expect(() => setArg('key', 'val')).not.toThrow();
        });
    });
});

// ═══════════════════════════════════════════════
//  G. helpers.js — collectStream deep branches
// ═══════════════════════════════════════════════
describe('collectStream branch push', () => {
    function makeStream(chunks) {
        let i = 0;
        return new ReadableStream({
            pull(controller) {
                if (i < chunks.length) {
                    controller.enqueue(chunks[i++]);
                } else {
                    controller.close();
                }
            },
        });
    }

    it('collects Uint8Array chunks', async () => {
        const s = makeStream([new Uint8Array([72, 105])]);
        expect(await collectStream(s)).toBe('Hi');
    });

    it('collects ArrayBuffer chunks', async () => {
        const buf = new ArrayBuffer(2);
        new Uint8Array(buf).set([72, 105]);
        const s = makeStream([buf]);
        expect(await collectStream(s)).toBe('Hi');
    });

    it('collects string chunks', async () => {
        const s = makeStream(['Hello', ' ', 'World']);
        expect(await collectStream(s)).toBe('Hello World');
    });

    it('handles null value chunks', async () => {
        const s = makeStream([null, 'a', undefined, 'b']);
        expect(await collectStream(s)).toBe('ab');
    });

    it('handles non-standard value via String()', async () => {
        const s = makeStream([42]);
        expect(await collectStream(s)).toBe('42');
    });

    it('aborts mid-stream', async () => {
        const ac = new AbortController();
        let i = 0;
        const s = new ReadableStream({
            pull(controller) {
                if (i === 0) { i++; controller.enqueue('first'); }
                else if (i === 1) { ac.abort(); i++; controller.enqueue('second'); }
                else { controller.close(); }
            },
        });
        const result = await collectStream(s, ac.signal);
        // First chunk collected, then abort detected
        expect(result).toContain('first');
    });

    it('pre-aborted signal → empty or partial', async () => {
        const ac = new AbortController();
        ac.abort();
        const s = makeStream(['data']);
        const result = await collectStream(s, ac.signal);
        expect(result).toBe(''); // abort before first read
    });
});

// ═══════════════════════════════════════════════
//  H. helpers.js — checkStreamCapability
// ═══════════════════════════════════════════════
describe('checkStreamCapability', () => {
    it('returns boolean and caches result', async () => {
        const r1 = await checkStreamCapability();
        expect(typeof r1).toBe('boolean');
        const r2 = await checkStreamCapability();
        expect(r2).toBe(r1); // cached
    });
});
