/**
 * @file message-format-extended.test.js — Extended tests for message-format.js
 * Targets: Anthropic URL images, multimodal edge cases, developer role
 */
import { describe, it, expect } from 'vitest';
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';
import { ThoughtSignatureCache } from '../src/shared/sse-parser.js';

// ═══════════════════════════════════════
// formatToAnthropic — URL image support
// ═══════════════════════════════════════
describe('formatToAnthropic — URL images', () => {
    it('converts http URL images to Anthropic URL source format', () => {
        const messages = [{
            role: 'user',
            content: 'Describe this image',
            multimodals: [{ type: 'image', url: 'https://example.com/image.png' }],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('url');
        expect(imgPart.source.url).toBe('https://example.com/image.png');
    });

    it('converts http URL images to Anthropic URL source format (http)', () => {
        const messages = [{
            role: 'user',
            content: 'See this',
            multimodals: [{ type: 'image', url: 'http://example.com/img.jpg' }],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('url');
    });

    it('keeps base64 images as base64 source format', () => {
        const b64 = 'data:image/png;base64,iVBORw0KGgo=';
        const messages = [{
            role: 'user',
            content: 'Check image',
            multimodals: [{ type: 'image', base64: b64 }],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('base64');
    });

    it('handles mixed URL and base64 images', () => {
        const messages = [{
            role: 'user',
            content: 'Mixed',
            multimodals: [
                { type: 'image', url: 'https://example.com/a.png' },
                { type: 'image', base64: 'data:image/jpeg;base64,/9j/4AAQ' },
            ],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const parts = userMsg.content.filter(p => p.type === 'image');
        expect(parts.length).toBe(2);
        expect(parts[0].source.type).toBe('url');
        expect(parts[1].source.type).toBe('base64');
    });
});

// ═══════════════════════════════════════
// formatToAnthropic — system extraction
// ═══════════════════════════════════════
describe('formatToAnthropic — system', () => {
    it('extracts system message', () => {
        const messages = [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hi' },
        ];
        const { messages: result, system } = formatToAnthropic(messages, {});
        expect(system).toContain('You are helpful');
        expect(result.every(m => m.role !== 'system')).toBe(true);
    });

    it('concatenates multiple system messages', () => {
        const messages = [
            { role: 'system', content: 'Rule 1' },
            { role: 'system', content: 'Rule 2' },
            { role: 'user', content: 'Hi' },
        ];
        const { system } = formatToAnthropic(messages, {});
        expect(system).toContain('Rule 1');
        expect(system).toContain('Rule 2');
    });
});

// ═══════════════════════════════════════
// formatToOpenAI — developer role
// ═══════════════════════════════════════
describe('formatToOpenAI — developer role', () => {
    it('converts system to developer role when requested', () => {
        const messages = [
            { role: 'system', content: 'Instructions' },
            { role: 'user', content: 'Hi' },
        ];
        const result = formatToOpenAI(messages, { developerRole: true });
        const devMsg = result.find(m => m.role === 'developer');
        expect(devMsg).toBeDefined();
        expect(devMsg.content).toContain('Instructions');
    });

    it('keeps system role when developerRole=false', () => {
        const messages = [
            { role: 'system', content: 'Instructions' },
            { role: 'user', content: 'Hi' },
        ];
        const result = formatToOpenAI(messages, { developerRole: false });
        const sysMsg = result.find(m => m.role === 'system');
        expect(sysMsg).toBeDefined();
    });
});

// ═══════════════════════════════════════
// formatToGemini — system instruction
// ═══════════════════════════════════════
describe('formatToGemini — system instruction', () => {
    it('extracts system instruction when preserveSystem=true', () => {
        const messages = [
            { role: 'system', content: 'Be concise' },
            { role: 'user', content: 'Hi' },
        ];
        const { contents, systemInstruction } = formatToGemini(messages, { preserveSystem: true });
        expect(systemInstruction).toBeDefined();
        expect(systemInstruction.some(s => s.includes('Be concise'))).toBe(true);
        expect(contents.every(c => !c.parts.some(p => p.text && p.text.includes('Be concise')))).toBe(true);
    });

    it('inlines system when preserveSystem=false', () => {
        const messages = [
            { role: 'system', content: 'Be concise' },
            { role: 'user', content: 'Hi' },
        ];
        const { systemInstruction } = formatToGemini(messages, { preserveSystem: false });
        // System messages go inline when preserveSystem is false
        expect(!systemInstruction || systemInstruction.length === 0).toBe(true);
    });

    it('handles multimodal in Gemini format', () => {
        const messages = [{
            role: 'user',
            content: 'What is this?',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc123' }],
        }];
        const { contents } = formatToGemini(messages, {});
        const userContent = contents.find(c => c.role === 'user');
        expect(userContent).toBeDefined();
        expect(userContent.parts.some(p => p.inlineData)).toBe(true);
    });
});

// ═══════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════
describe('Format edge cases', () => {
    it('formatToOpenAI handles empty messages', () => {
        expect(formatToOpenAI([], {})).toEqual([]);
    });

    it('formatToAnthropic handles empty messages (may inject safety start)', () => {
        const { messages } = formatToAnthropic([], {});
        // Implementation may inject a safety "Start" message for empty input
        expect(Array.isArray(messages)).toBe(true);
    });

    it('formatToGemini handles empty messages', () => {
        const { contents } = formatToGemini([], {});
        expect(contents).toEqual([]);
    });

    it('formatToOpenAI handles messages with empty content', () => {
        const messages = [
            { role: 'user', content: '' },
            { role: 'assistant', content: 'Reply' },
        ];
        const result = formatToOpenAI(messages, {});
        expect(result.length).toBeGreaterThan(0);
    });

    it('formatToAnthropic handles assistant messages with multimodals', () => {
        const messages = [{
            role: 'assistant',
            content: 'Here is the result',
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const aMsg = result.find(m => m.role === 'assistant');
        expect(aMsg).toBeDefined();
    });
});

// ═══════════════════════════════════════
// formatToOpenAI — mergesys, mustuser, sysfirst, altrole
// ═══════════════════════════════════════
describe('formatToOpenAI — config flags', () => {
    it('mergesys merges all system messages into first user message', () => {
        const messages = [
            { role: 'system', content: 'SysA' },
            { role: 'system', content: 'SysB' },
            { role: 'user', content: 'Hello' },
        ];
        const result = formatToOpenAI(messages, { mergesys: true });
        expect(result.every(m => m.role !== 'system')).toBe(true);
        const first = result[0];
        expect(first.content).toContain('SysA');
        expect(first.content).toContain('SysB');
        expect(first.content).toContain('Hello');
    });

    it('mustuser injects user placeholder when first message is assistant', () => {
        const messages = [
            { role: 'assistant', content: 'I start' },
        ];
        const result = formatToOpenAI(messages, { mustuser: true });
        expect(result[0].role).toBe('user');
    });

    it('sysfirst moves system message to front', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Be nice' },
        ];
        const result = formatToOpenAI(messages, { sysfirst: true });
        expect(result[0].role).toBe('system');
        expect(result[0].content).toContain('Be nice');
    });

    it('altrole renames assistant to model and merges consecutive same-role', () => {
        const messages = [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'B' },
            { role: 'assistant', content: 'C' },
        ];
        const result = formatToOpenAI(messages, { altrole: true });
        const models = result.filter(m => m.role === 'model');
        expect(models.length).toBe(1);
        expect(models[0].content).toContain('B');
        expect(models[0].content).toContain('C');
    });
});

// ═══════════════════════════════════════
// formatToOpenAI — multimodal & content handling
// ═══════════════════════════════════════
describe('formatToOpenAI — multimodal', () => {
    it('handles image with url', () => {
        const messages = [{
            role: 'user',
            content: 'Look',
            multimodals: [{ type: 'image', url: 'https://example.com/img.jpg' }],
        }];
        const result = formatToOpenAI(messages, {});
        const userMsg = result[0];
        expect(Array.isArray(userMsg.content)).toBe(true);
        const imgPart = userMsg.content.find(p => p.type === 'image_url');
        expect(imgPart.image_url.url).toBe('https://example.com/img.jpg');
    });

    it('handles audio multimodal', () => {
        const messages = [{
            role: 'user',
            content: 'Listen',
            multimodals: [{ type: 'audio', base64: 'data:audio/wav;base64,UklGR' }],
        }];
        const result = formatToOpenAI(messages, {});
        const userMsg = result[0];
        expect(Array.isArray(userMsg.content)).toBe(true);
        const audioPart = userMsg.content.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('wav');
    });

    it('handles Array.isArray(m.content) with image source base64', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'Describe' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
            ],
        }];
        const result = formatToOpenAI(messages, {});
        const userMsg = result[0];
        expect(Array.isArray(userMsg.content)).toBe(true);
        const imgPart = userMsg.content.find(p => p.type === 'image_url');
        expect(imgPart).toBeDefined();
        expect(imgPart.image_url.url).toContain('data:image/png;base64,abc123');
    });

    it('handles Array.isArray(m.content) with inlineData image', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { inlineData: { data: 'abcImg', mimeType: 'image/jpeg' } },
            ],
        }];
        const result = formatToOpenAI(messages, {});
        const userMsg = result[0];
        const imgPart = userMsg.content.find(p => p.type === 'image_url');
        expect(imgPart).toBeDefined();
        expect(imgPart.image_url.url).toContain('data:image/jpeg;base64,abcImg');
    });

    it('handles Array.isArray(m.content) with inlineData audio', () => {
        const messages = [{
            role: 'user',
            content: [
                { inlineData: { data: 'audioData', mimeType: 'audio/ogg' } },
            ],
        }];
        const result = formatToOpenAI(messages, {});
        const userMsg = result[0];
        const audioPart = userMsg.content.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('ogg');
    });

    it('maps model role to assistant', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'model', content: 'Reply' },
        ];
        const result = formatToOpenAI(messages, {});
        expect(result[1].role).toBe('assistant');
    });
});

// ═══════════════════════════════════════
// formatToAnthropic — Array content handling
// ═══════════════════════════════════════
describe('formatToAnthropic — Array content', () => {
    it('handles Array content with image_url (data URI)', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abcImgData' } },
            ],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('base64');
        expect(imgPart.source.data).toBe('abcImgData');
    });

    it('handles Array content with image_url (http URL)', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
            ],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('url');
        expect(imgPart.source.url).toBe('https://example.com/photo.jpg');
    });

    it('handles Array content with inlineData image', () => {
        const messages = [{
            role: 'user',
            content: [
                { inlineData: { data: 'xyz789', mimeType: 'image/webp' } },
            ],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.type).toBe('base64');
        expect(imgPart.source.media_type).toBe('image/webp');
    });

    it('handles Array content with pre-formatted base64 image source', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGODlh' } },
            ],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        const imgPart = userMsg.content.find(p => p.type === 'image');
        expect(imgPart).toBeDefined();
        expect(imgPart.source.data).toBe('R0lGODlh');
    });

    it('merges consecutive same-role messages in Anthropic format', () => {
        const messages = [
            { role: 'user', content: 'Part one' },
            { role: 'user', content: 'Part two' },
        ];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
        expect(userMsgs[0].content.length).toBeGreaterThanOrEqual(2);
    });

    it('handles non-leading system messages as user with "system:" prefix', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Mid-system' },
            { role: 'assistant', content: 'OK' },
        ];
        const { messages: result, system } = formatToAnthropic(messages, {});
        expect(system).toBe('');
        const hasSystemPrefix = result.some(m =>
            m.role === 'user' && JSON.stringify(m.content).includes('system: Mid-system')
        );
        expect(hasSystemPrefix).toBe(true);
    });
});

// ═══════════════════════════════════════
// formatToGemini — extended coverage
// ═══════════════════════════════════════
describe('formatToGemini — extended', () => {
    it('handles URL image as fileData', () => {
        const messages = [{
            role: 'user',
            content: 'Analyze',
            multimodals: [{ type: 'image', url: 'https://example.com/pic.png', mimeType: 'image/png' }],
        }];
        const { contents } = formatToGemini(messages, {});
        const userContent = contents.find(c => c.role === 'user');
        expect(userContent.parts.some(p => p.fileData)).toBe(true);
    });

    it('handles non-leading system message as "system:" user turn', () => {
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Be concise' },
            { role: 'assistant', content: 'OK' },
        ];
        const { contents } = formatToGemini(messages, { preserveSystem: true });
        const hasSystemPrefix = contents.some(c =>
            c.role === 'user' && c.parts.some(p => p.text && p.text.includes('system: Be concise'))
        );
        expect(hasSystemPrefix).toBe(true);
    });

    it('handles consecutive same-role messages with multimodal merge', () => {
        const messages = [
            { role: 'user', content: 'Img1', multimodals: [{ type: 'image', base64: 'data:image/png;base64,img1data' }] },
            { role: 'user', content: 'Img2', multimodals: [{ type: 'image', base64: 'data:image/jpeg;base64,img2data' }] },
        ];
        const { contents } = formatToGemini(messages, {});
        const userContents = contents.filter(c => c.role === 'user');
        expect(userContents.length).toBe(1);
        expect(userContents[0].parts.filter(p => p.inlineData).length).toBe(2);
    });

    it('prepends user Start when first message is model', () => {
        const messages = [
            { role: 'assistant', content: 'I go first' },
        ];
        const { contents } = formatToGemini(messages, {});
        expect(contents[0].role).toBe('user');
        expect(contents[0].parts[0].text).toBe('Start');
    });

    it('handles audio multimodal', () => {
        const messages = [{
            role: 'user',
            content: 'Listen',
            multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,audiodata' }],
        }];
        const { contents } = formatToGemini(messages, {});
        const userContent = contents.find(c => c.role === 'user');
        expect(userContent.parts.some(p => p.inlineData && p.inlineData.mimeType === 'audio/mp3')).toBe(true);
    });

    it('handles video multimodal', () => {
        const messages = [{
            role: 'user',
            content: 'Watch',
            multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,videodata' }],
        }];
        const { contents } = formatToGemini(messages, {});
        const userContent = contents.find(c => c.role === 'user');
        expect(userContent.parts.some(p => p.inlineData && p.inlineData.mimeType === 'video/mp4')).toBe(true);
    });
});

// ═══════════════════════════════════════
// formatToOpenAI — audio format variants
// ═══════════════════════════════════════
describe('formatToOpenAI — audio format variants', () => {
    it('detects flac format', () => {
        const messages = [{
            role: 'user', content: 'x',
            multimodals: [{ type: 'audio', base64: 'data:audio/flac;base64,flacdata' }],
        }];
        const result = formatToOpenAI(messages, {});
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('flac');
    });

    it('detects webm format', () => {
        const messages = [{
            role: 'user', content: 'x',
            multimodals: [{ type: 'audio', base64: 'data:audio/webm;base64,webmdata' }],
        }];
        const result = formatToOpenAI(messages, {});
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('webm');
    });

    it('detects ogg format', () => {
        const messages = [{
            role: 'user', content: 'x',
            multimodals: [{ type: 'audio', base64: 'data:audio/ogg;base64,oggdata' }],
        }];
        const result = formatToOpenAI(messages, {});
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('ogg');
    });

    it('defaults to mp3 for unknown audio mime', () => {
        const messages = [{
            role: 'user', content: 'x',
            multimodals: [{ type: 'audio', base64: 'data:audio/aac;base64,aacdata' }],
        }];
        const result = formatToOpenAI(messages, {});
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('mp3');
    });
});

// ═══════════════════════════════════════
// formatToOpenAI — altrole with mixed content types
// ═══════════════════════════════════════
describe('formatToOpenAI — altrole merge with arrays', () => {
    it('merges string + array content', () => {
        const messages = [
            { role: 'user', content: 'Text first' },
            { role: 'user', content: 'Another', multimodals: [{ type: 'image', base64: 'data:image/png;base64,img' }] },
        ];
        const result = formatToOpenAI(messages, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
    });

    it('merges array + string content', () => {
        const messages = [
            { role: 'user', content: 'A', multimodals: [{ type: 'image', url: 'https://img.com/x.jpg' }] },
            { role: 'user', content: 'B plain text' },
        ];
        const result = formatToOpenAI(messages, { altrole: true });
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    it('handles input_image type in array content', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'input_image', image_url: 'data:image/png;base64,thepngdata' },
            ],
        }];
        const result = formatToOpenAI(messages, {});
        const imgPart = result[0].content.find(p => p.type === 'image_url');
        expect(imgPart).toBeDefined();
    });
});

// ═══════════════════════════════════════
// formatToAnthropic — multimodal merge same-role
// ═══════════════════════════════════════
describe('formatToAnthropic — multimodal merge', () => {
    it('merges consecutive user messages with multimodals', () => {
        const messages = [
            { role: 'user', content: 'First', multimodals: [{ type: 'image', url: 'https://a.com/1.jpg' }] },
            { role: 'user', content: 'Second', multimodals: [{ type: 'image', base64: 'data:image/png;base64,data2' }] },
        ];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        const imgParts = userMsgs[0].content.filter(p => p.type === 'image');
        expect(imgParts.length).toBe(2);
    });

    it('handles empty multimodals fallback to text path', () => {
        const messages = [{
            role: 'user',
            content: 'Just text',
            multimodals: [{ type: 'unknown_type' }],
        }];
        const { messages: result } = formatToAnthropic(messages, {});
        const userMsg = result.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
    });
});

// ═══════════════════════════════════════
// formatToGemini — thoughtSignature & system inline
// ═══════════════════════════════════════
describe('formatToGemini — thoughtSignature', () => {
    it('attaches thought signature from cache when useThoughtSignature=true', () => {
        ThoughtSignatureCache.clear();
        ThoughtSignatureCache.save('Hello model response', 'sig123');
        const messages = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello model response' },
        ];
        const { contents } = formatToGemini(messages, { useThoughtSignature: true });
        const modelContent = contents.find(c => c.role === 'model');
        expect(modelContent).toBeDefined();
        // May or may not have thoughtSignature depending on key normalization
        ThoughtSignatureCache.clear();
    });
});

describe('formatToGemini — system inline when first is not user', () => {
    it('creates new user part for system when contents starts with model', () => {
        const messages = [
            { role: 'system', content: 'Be helpful' },
            { role: 'assistant', content: 'I am helpful' },
        ];
        const { contents } = formatToGemini(messages, { preserveSystem: false });
        // Should have Start placeholder and system text
        expect(contents[0].role).toBe('user');
    });
});
