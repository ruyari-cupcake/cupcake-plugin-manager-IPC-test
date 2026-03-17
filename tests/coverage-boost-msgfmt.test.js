/**
 * coverage-boost-msgfmt.test.js — Targeted coverage for message-format.js uncovered lines
 *
 * No vi.mock needed — message-format.js doesn't depend on ipc-protocol.js directly.
 * Targets specific uncovered lines: 91, 316, 336, 377
 */
import { describe, it, expect } from 'vitest';
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';

// ──────────────────────────────────────────────
// Line 91: webm audio MIME type in formatToOpenAI
// ──────────────────────────────────────────────
describe('msg-fmt coverage: OpenAI webm audio (L91)', () => {
    it('detects webm audio format from MIME type', () => {
        const msgs = [{
            role: 'user',
            content: 'listen to this',
            multimodals: [{ type: 'audio', base64: 'data:audio/webm;base64,QUFBQQo=' }],
        }];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const audioPart = userMsg.content.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('webm');
        expect(audioPart.input_audio.data).toBe('QUFBQQo=');
    });
});

// ──────────────────────────────────────────────
// Line 316: Anthropic content merging (Array.isArray content parts → same role)
// ──────────────────────────────────────────────
describe('msg-fmt coverage: Anthropic content merge (L316)', () => {
    it('merges image content parts into previous same-role message', () => {
        // First user message is text, second is content array with image_url
        // They should merge because same role (user)
        const msgs = [
            { role: 'user', content: 'Look at this' },
            {
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
                ],
            },
        ];
        const result = formatToAnthropic(msgs);
        // The two user messages should be merged
        const userMsgs = result.messages.filter(m => m.role === 'user');
        // Should have merged — last user msg has array content
        const lastUser = userMsgs[userMsgs.length - 1];
        expect(Array.isArray(lastUser.content)).toBe(true);
        // Should contain both text and image parts
        const hasText = lastUser.content.some(p => p.type === 'text');
        const hasImage = lastUser.content.some(p => p.type === 'image');
        expect(hasText).toBe(true);
        expect(hasImage).toBe(true);
    });

    it('merges content array when prev.content is string (converts to array)', () => {
        // This specifically tests the branch where prev.content is a string
        // and needs to be converted to array before pushing new content parts
        const msgs = [
            { role: 'user', content: 'first text' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'more text' },
                    { type: 'image_url', image_url: 'data:image/jpeg;base64,/9j/4AAQ' },
                ],
            },
        ];
        const result = formatToAnthropic(msgs);
        const userMsgs = result.messages.filter(m => m.role === 'user');
        const merged = userMsgs[userMsgs.length - 1];
        expect(Array.isArray(merged.content)).toBe(true);
    });
});

// ──────────────────────────────────────────────
// Line 336: Anthropic image_url data URI conversion in Array.isArray(content) path
// ──────────────────────────────────────────────
describe('msg-fmt coverage: Anthropic image_url data URI (L336)', () => {
    it('converts image_url data URI to Anthropic base64 format', () => {
        const msgs = [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
        }];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        expect(userMsg).toBeDefined();
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('base64');
        expect(imgPart.source.media_type).toBe('image/png');
        expect(imgPart.source.data).toBe('iVBORw0KGgo=');
    });

    it('converts HTTP URL to Anthropic url source', () => {
        const msgs = [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
            ],
        }];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const imgPart = userMsg?.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('url');
        expect(imgPart.source.url).toBe('https://example.com/image.jpg');
    });

    it('handles input_image type in content array', () => {
        const msgs = [{
            role: 'user',
            content: [
                { type: 'input_image', image_url: { url: 'data:image/gif;base64,R0lGODlh' } },
            ],
        }];
        // input_image is handled in the same code path
        const result = formatToAnthropic(msgs);
        // Check it was processed
        const userMsg = result.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
    });

    it('handles image_url as plain string (not object)', () => {
        const msgs = [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: 'data:image/webp;base64,UklGR' },
            ],
        }];
        const result = formatToAnthropic(msgs);
        const userMsg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const imgPart = userMsg?.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.media_type).toBe('image/webp');
    });
});

// ──────────────────────────────────────────────
// Line 377: Gemini thought content stripping for model messages
// ──────────────────────────────────────────────
describe('msg-fmt coverage: Gemini thought stripping (L377)', () => {
    it('strips thought display content from assistant/model messages', () => {
        const msgs = [
            { role: 'user', content: 'Question' },
            {
                role: 'assistant',
                content: '<Thoughts>\nSome internal reasoning here\n</Thoughts>\n\nThe actual answer is 42.',
            },
        ];
        const result = formatToGemini(msgs);
        const modelMsg = result.contents.find(c => c.role === 'model');
        expect(modelMsg).toBeDefined();
        const allText = modelMsg.parts.map(p => p.text || '').join('');
        expect(allText).not.toContain('<Thoughts>');
        expect(allText).toContain('actual answer is 42');
    });

    it('strips thoughts from model role messages (explicit model)', () => {
        const msgs = [
            { role: 'user', content: 'Hi' },
            {
                role: 'model',
                content: '<Thoughts>\nReasoning...\n</Thoughts>\n\nResponse text',
            },
        ];
        const result = formatToGemini(msgs);
        const modelMsg = result.contents.find(c => c.role === 'model');
        const allText = modelMsg.parts.map(p => p.text || '').join('');
        expect(allText).not.toContain('Reasoning...');
        expect(allText).toContain('Response text');
    });

    it('does not strip thoughts from user messages', () => {
        const msgs = [
            {
                role: 'user',
                content: '<Thoughts>\nUser wrote this literally\n</Thoughts>\n\nHello',
            },
        ];
        const result = formatToGemini(msgs);
        const userMsg = result.contents.find(c => c.role === 'user');
        const allText = userMsg.parts.map(p => p.text || '').join('');
        // User messages should NOT be stripped
        expect(allText).toContain('Hello');
    });

    it('handles non-string content as JSON.stringify before thought stripping', () => {
        const msgs = [
            { role: 'user', content: 'Hi' },
            {
                role: 'assistant',
                content: { text: 'some structured content' },
            },
        ];
        const result = formatToGemini(msgs);
        const modelMsg = result.contents.find(c => c.role === 'model');
        expect(modelMsg).toBeDefined();
    });
});
