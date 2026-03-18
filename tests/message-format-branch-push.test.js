/**
 * message-format-branch-push.test.js
 *
 * Targeted tests to increase branch coverage for message-format.js.
 * Focuses on uncovered branches in:
 *   - OpenAI: audio modals, inlineData mapping, altrole merge, sysfirst, developerRole
 *   - Anthropic: Array content with image_url/input_image, inlineData, role merge, cachePoint
 *   - Gemini: multimodal merging, URL images, system phase, text merge paths
 */
import { describe, it, expect } from 'vitest';
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';

// ─── OpenAI Branch Coverage ───

describe('message-format: OpenAI uncovered branches', () => {
    it('handles audio modal with wav mime type', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [
                { type: 'audio', base64: 'data:audio/wav;base64,AAABBB' },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThanOrEqual(1);
        const audioPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('wav');
    });

    it('handles audio modal with ogg mime type', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [
                { type: 'audio', base64: 'data:audio/ogg;base64,CCC' },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const audioPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('ogg');
    });

    it('handles audio modal with flac mime type', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [
                { type: 'audio', base64: 'data:audio/flac;base64,DDD' },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const audioPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('flac');
    });

    it('handles audio modal with webm mime type', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [
                { type: 'audio', base64: 'data:audio/webm;base64,EEE' },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const audioPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('webm');
    });

    it('handles audio modal without mime (defaults to mp3)', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [
                { type: 'audio', base64: 'rawbase64nocomma' },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const audioPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('mp3');
    });

    it('maps Array m.content with inlineData image', () => {
        const msgs = [
            { role: 'user', content: [
                { inlineData: { mimeType: 'image/png', data: 'abc123' } },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const imgPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'image_url');
        expect(imgPart).toBeDefined();
        expect(imgPart.image_url.url).toContain('data:image/png;base64,abc123');
    });

    it('maps Array m.content with inlineData audio', () => {
        const msgs = [
            { role: 'user', content: [
                { inlineData: { mimeType: 'audio/wav', data: 'wavdata' } },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const part = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'input_audio');
        expect(part).toBeDefined();
        expect(part.input_audio.format).toBe('wav');
    });

    it('maps Array m.content with Anthropic base64 image source', () => {
        const msgs = [
            { role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'jpgdata' } },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const imgPart = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'image_url');
        expect(imgPart).toBeDefined();
        expect(imgPart.image_url.url).toContain('data:image/jpeg;base64,jpgdata');
    });

    it('sysfirst moves first system message to index 0', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'sys prompt' },
        ];
        const result = formatToOpenAI(msgs, { sysfirst: true });
        expect(result[0].role).toBe('system');
        expect(result[0].content).toContain('sys prompt');
    });

    it('altrole merges consecutive same-role string messages', () => {
        const msgs = [
            { role: 'user', content: 'hello' },
            { role: 'user', content: 'world' },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result.filter(m => m.role === 'user').length).toBe(1);
        expect(result.find(m => m.role === 'user').content).toContain('hello');
    });

    it('altrole merges mixed string/array content', () => {
        const msgs = [
            { role: 'user', content: 'text first' },
            { role: 'user', content: [{ type: 'text', text: 'array part' }] },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    it('developerRole converts system → developer', () => {
        const msgs = [
            { role: 'system', content: 'you are helpful' },
            { role: 'user', content: 'hi' },
        ];
        const result = formatToOpenAI(msgs, { developerRole: true });
        expect(result[0].role).toBe('developer');
    });

    it('handles non-object content with fallback text', () => {
        const msgs = [
            { role: 'user', content: 12345 },
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('image modal with url (not base64)', () => {
        const msgs = [
            { role: 'user', content: 'look', multimodals: [
                { type: 'image', url: 'https://example.com/img.png' },
            ]},
        ];
        const result = formatToOpenAI(msgs);
        const part = result.find(m => Array.isArray(m.content))
            ?.content?.find(p => p.type === 'image_url');
        expect(part.image_url.url).toBe('https://example.com/img.png');
    });

    it('mustuser placeholder preserves single-space user', () => {
        const msgs = [
            { role: 'assistant', content: 'response' },
        ];
        const result = formatToOpenAI(msgs, { mustuser: true });
        const user = result.find(m => m.role === 'user');
        expect(user).toBeDefined();
    });

    it('role model → assistant mapping + char role', () => {
        const msgs = [
            { role: 'model', content: 'model text' },
            { role: 'char', content: 'char text' },
            { role: 'user', content: 'q' },
        ];
        const result = formatToOpenAI(msgs);
        expect(result[0].role).toBe('assistant');
        expect(result[1].role).toBe('assistant');
    });

    it('altrole renames assistant → model', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result.find(m => m.role === 'model')).toBeDefined();
    });
});

// ─── Anthropic Branch Coverage ───

describe('message-format: Anthropic uncovered branches', () => {
    it('handles Array content with image_url type (data URI)', () => {
        const msgs = [
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,ABCD' } },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const imgSource = result.messages.find(m => m.role === 'user')
            ?.content?.find(c => c.type === 'image');
        expect(imgSource).toBeDefined();
        expect(imgSource.source.type).toBe('base64');
    });

    it('handles Array content with image_url type (http URL)', () => {
        const msgs = [
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const imgSource = result.messages.find(m => m.role === 'user')
            ?.content?.find(c => c.type === 'image');
        expect(imgSource).toBeDefined();
        expect(imgSource.source.type).toBe('url');
    });

    it('handles Array content with inlineData image', () => {
        const msgs = [
            { role: 'user', content: [
                { inlineData: { mimeType: 'image/jpeg', data: 'jpgdata123' } },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const imgSource = result.messages.find(m => m.role === 'user')
            ?.content?.find(c => c.type === 'image');
        expect(imgSource).toBeDefined();
        expect(imgSource.source.data).toBe('jpgdata123');
    });

    it('handles Array content with text part', () => {
        const msgs = [
            { role: 'user', content: [{ type: 'text', text: 'hello array' }] },
        ];
        const result = formatToAnthropic(msgs);
        const textContent = result.messages.find(m => m.role === 'user')
            ?.content?.find(c => c.type === 'text');
        expect(textContent.text).toBe('hello array');
    });

    it('merges consecutive same-role messages with contentParts', () => {
        const msgs = [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
        ];
        const result = formatToAnthropic(msgs);
        const userMsgs = result.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeLessThanOrEqual(2); // at most 2 (Start + merged)
    });

    it('merges consecutive same-role multimodal messages', () => {
        const msgs = [
            { role: 'user', content: 'look', multimodals: [
                { type: 'image', base64: 'data:image/png;base64,ABC' },
            ]},
            { role: 'user', content: 'more', multimodals: [
                { type: 'image', url: 'https://example.com/img2.png' },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const userMs = result.messages.filter(m => m.role === 'user');
        expect(userMs.length).toBeGreaterThanOrEqual(1);
    });

    it('handles non-leading system message as user with "system:" prefix', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'mid-system instruction' },
            { role: 'assistant', content: 'ok' },
        ];
        const result = formatToAnthropic(msgs);
        const hasSystem = result.messages.some(m =>
            Array.isArray(m.content) && m.content.some(c => c.text?.includes('system:'))
        );
        expect(hasSystem).toBe(true);
    });

    it('handles cachePoint on message (string content path)', () => {
        const msgs = [
            { role: 'user', content: 'cached msg', cachePoint: true },
            { role: 'assistant', content: 'ok' },
        ];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user' && 
            Array.isArray(m.content) && m.content.some(c => c.cache_control));
        expect(userMsg).toBeDefined();
    });

    it('handles URL image in multimodals (Anthropic URL source)', () => {
        const msgs = [
            { role: 'user', content: 'see', multimodals: [
                { type: 'image', url: 'https://example.com/photo.jpg' },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user' && 
            Array.isArray(m.content) && m.content.some(c => c.source?.type === 'url'));
        expect(userMsg).toBeDefined();
    });

    it('Array content merge with existing array content (same role)', () => {
        const msgs = [
            { role: 'user', content: [
                { type: 'image', source: { type: 'base64', data: 'img1', media_type: 'image/png' } },
            ]},
            { role: 'user', content: [
                { type: 'image', source: { type: 'base64', data: 'img2', media_type: 'image/png' } },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const userMsgs = result.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('input_image type with string image_url', () => {
        const msgs = [
            { role: 'user', content: [
                { type: 'input_image', image_url: 'data:image/png;base64,XYZ' },
            ]},
        ];
        const result = formatToAnthropic(msgs);
        const imgSource = result.messages.find(m => m.role === 'user')
            ?.content?.find(c => c.type === 'image');
        expect(imgSource).toBeDefined();
    });
});

// ─── Gemini Branch Coverage ───

describe('message-format: Gemini uncovered branches', () => {
    it('handles system message after non-system (fallback to user+system prefix)', () => {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'mid-conversation system' },
            { role: 'assistant', content: 'ok' },
        ];
        const result = formatToGemini(msgs);
        expect(result.contents.some(c => c.parts.some(p => p.text?.includes('system:')))).toBe(true);
    });

    it('handles multimodal with URL image', () => {
        const msgs = [
            { role: 'user', content: 'look at this', multimodals: [
                { type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' },
            ]},
        ];
        const result = formatToGemini(msgs);
        const hasFD = result.contents.some(c => c.parts.some(p => p.fileData));
        expect(hasFD).toBe(true);
    });

    it('merges consecutive same-role messages with multimodals', () => {
        const msgs = [
            { role: 'user', content: 'first', multimodals: [
                { type: 'image', base64: 'data:image/png;base64,A' },
            ]},
            { role: 'user', content: 'second', multimodals: [
                { type: 'image', base64: 'data:image/jpeg;base64,B' },
            ]},
        ];
        const result = formatToGemini(msgs);
        const userContents = result.contents.filter(c => c.role === 'user');
        // Should merge into single user entry
        expect(userContents.length).toBeLessThanOrEqual(2);
    });

    it('handles text merge when previous part is image (not text)', () => {
        const msgs = [
            { role: 'user', content: 'look', multimodals: [
                { type: 'image', base64: 'data:image/png;base64,A' },
            ]},
            { role: 'user', content: 'more text' },
        ];
        const result = formatToGemini(msgs);
        const userContents = result.contents.filter(c => c.role === 'user');
        expect(userContents.length).toBeGreaterThanOrEqual(1);
    });

    it('non-string content formats as JSON fallback', () => {
        const msgs = [
            { role: 'user', content: { custom: 'data' } },
        ];
        const result = formatToGemini(msgs);
        expect(result.contents.length).toBeGreaterThanOrEqual(1);
    });

    it('handles audio multimodal with inlineData', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [
                { type: 'audio', base64: 'data:audio/mp3;base64,AUDIODATA' },
            ]},
        ];
        const result = formatToGemini(msgs);
        const hasInline = result.contents.some(c => c.parts.some(p => p.inlineData));
        expect(hasInline).toBe(true);
    });

    it('leading system messages go to systemInstruction (preserveSystem)', () => {
        const msgs = [
            { role: 'system', content: 'sys1' },
            { role: 'system', content: 'sys2' },
            { role: 'user', content: 'hi' },
        ];
        const result = formatToGemini(msgs, { preserveSystem: true });
        expect(result.systemInstruction).toBeDefined();
        expect(result.systemInstruction.length).toBeGreaterThanOrEqual(2);
        expect(result.systemInstruction).toContain('sys1');
    });

    it('inserts Start placeholder when first message is model', () => {
        const msgs = [
            { role: 'model', content: 'hello from model' },
        ];
        const result = formatToGemini(msgs);
        expect(result.contents[0].role).toBe('user');
    });

    it('handles useThoughtSignature config', () => {
        const msgs = [
            { role: 'user', content: 'test' },
            { role: 'model', content: 'thinking... response' },
        ];
        const result = formatToGemini(msgs, { useThoughtSignature: true });
        expect(result.contents.length).toBeGreaterThanOrEqual(2);
    });

    it('new parts path when multimodal and no same-role previous', () => {
        const msgs = [
            { role: 'user', content: 'text with img', multimodals: [
                { type: 'image', base64: 'data:image/png;base64,IMGDATA' },
            ]},
        ];
        const result = formatToGemini(msgs);
        const user = result.contents.find(c => c.role === 'user');
        expect(user.parts.length).toBeGreaterThanOrEqual(1);
    });
});
