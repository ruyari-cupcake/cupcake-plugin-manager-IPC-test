/**
 * @file sanitize.test.js — 메시지 정화 함수 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import {
    stripInternalTags,
    stripStaleAutoCaption,
    hasAttachedMultimodals,
    hasNonEmptyMessageContent,
    extractNormalizedMessagePayload,
    sanitizeMessages,
    sanitizeBodyJSON,
    stripThoughtDisplayContent,
    isInlaySceneWrapperText,
} from '../src/shared/sanitize.js';

describe('stripInternalTags', () => {
    it('<qak> 태그 제거', () => {
        expect(stripInternalTags('hello <qak>world</qak> test')).toBe('hello world test');
    });

    it('비문자열 → 입력 그대로 반환', () => {
        expect(stripInternalTags(null)).toBeNull();
        expect(stripInternalTags(42)).toBe(42);
        expect(stripInternalTags(undefined)).toBeUndefined();
    });

    it('태그 없는 문자열 → 그대로', () => {
        expect(stripInternalTags('clean text')).toBe('clean text');
    });

    it('앞뒤 공백 trim', () => {
        expect(stripInternalTags('  <qak></qak>hello  ')).toBe('hello');
    });
});

describe('stripStaleAutoCaption', () => {
    it('이미지 멀티모달 있으면 변경 없음', () => {
        const msg = { multimodals: [{ type: 'image' }] };
        expect(stripStaleAutoCaption('See the image [a nice photo]', msg)).toBe('See the image [a nice photo]');
    });

    it('이미지 키워드 + 브래킷 캡션 제거', () => {
        expect(stripStaleAutoCaption('Check this image [a beautiful sunset]', {})).toBe('Check this image');
    });

    it('이미지 키워드 없으면 변경 없음', () => {
        expect(stripStaleAutoCaption('Hello world [test caption]', {})).toBe('Hello world [test caption]');
    });

    it('비문자열 → 입력 그대로', () => {
        expect(stripStaleAutoCaption(null, {})).toBeNull();
    });
});

describe('hasAttachedMultimodals', () => {
    it('multimodals 있는 메시지 → true', () => {
        expect(hasAttachedMultimodals({ multimodals: [{ type: 'image' }] })).toBe(true);
    });

    it('빈 multimodals → false', () => {
        expect(hasAttachedMultimodals({ multimodals: [] })).toBe(false);
    });

    it('multimodals 없음 → false', () => {
        expect(hasAttachedMultimodals({})).toBe(false);
        expect(hasAttachedMultimodals(null)).toBe(false);
    });
});

describe('hasNonEmptyMessageContent', () => {
    it('문자열 content', () => {
        expect(hasNonEmptyMessageContent('hello')).toBe(true);
        expect(hasNonEmptyMessageContent('')).toBe(false);
        expect(hasNonEmptyMessageContent('   ')).toBe(false);
    });

    it('배열 content', () => {
        expect(hasNonEmptyMessageContent([{ type: 'text' }])).toBe(true);
        expect(hasNonEmptyMessageContent([])).toBe(false);
    });

    it('객체 content', () => {
        expect(hasNonEmptyMessageContent({ text: 'hi' })).toBe(true);
    });

    it('null/undefined → false', () => {
        expect(hasNonEmptyMessageContent(null)).toBe(false);
        expect(hasNonEmptyMessageContent(undefined)).toBe(false);
    });
});

describe('extractNormalizedMessagePayload', () => {
    it('문자열 content → text 추출', () => {
        const msg = { role: 'user', content: 'Hello world' };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.text).toBe('Hello world');
        expect(result.multimodals).toHaveLength(0);
    });

    it('배열 content + text parts', () => {
        const msg = { content: [{ text: 'part1' }, { text: 'part2' }] };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.text).toContain('part1');
        expect(result.text).toContain('part2');
    });

    it('배열 content + image_url', () => {
        const msg = {
            content: [{
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,abc123' },
            }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals).toHaveLength(1);
        expect(result.multimodals[0].type).toBe('image');
    });

    it('배열 content + inlineData', () => {
        const msg = {
            content: [{
                inlineData: { mimeType: 'image/jpeg', data: 'base64data' },
            }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals).toHaveLength(1);
        expect(result.multimodals[0].type).toBe('image');
    });

    it('배열 content + audio', () => {
        const msg = {
            content: [{
                type: 'input_audio',
                input_audio: { data: 'audiodata', format: 'mp3' },
            }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals).toHaveLength(1);
        expect(result.multimodals[0].type).toBe('audio');
    });

    it('배열 content + Anthropic image source', () => {
        const msg = {
            content: [{
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
            }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals).toHaveLength(1);
        expect(result.multimodals[0].type).toBe('image');
    });

    it('multimodals 필드 포함 메시지', () => {
        const msg = {
            content: 'Look at this',
            multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.text).toBe('Look at this');
        expect(result.multimodals).toHaveLength(1);
    });

    it('null 메시지 → 빈 결과', () => {
        const result = extractNormalizedMessagePayload(null);
        expect(result.text).toBe('');
        expect(result.multimodals).toHaveLength(0);
    });

    // STB-3: string-form image_url 처리
    it('배열 content + string image_url (STB-3)', () => {
        const msg = {
            content: [{
                type: 'image_url',
                image_url: 'https://example.com/photo.jpg',
            }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals).toHaveLength(1);
        expect(result.multimodals[0].type).toBe('image');
    });

    it('배열 content + input_image string image_url (STB-3)', () => {
        const msg = {
            content: [{
                type: 'input_image',
                image_url: 'data:image/png;base64,abc',
            }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals).toHaveLength(1);
        expect(result.multimodals[0].type).toBe('image');
    });
});

describe('sanitizeMessages', () => {
    it('정상 메시지 통과', () => {
        const msgs = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
        ];
        const result = sanitizeMessages(msgs);
        expect(result).toHaveLength(2);
    });

    it('null/undefined 메시지 필터링', () => {
        const msgs = [null, undefined, { role: 'user', content: 'valid' }];
        const result = sanitizeMessages(msgs);
        expect(result).toHaveLength(1);
    });

    it('role 없는 메시지 필터링', () => {
        const msgs = [{ content: 'no role' }, { role: '', content: 'empty role' }];
        const result = sanitizeMessages(msgs);
        expect(result).toHaveLength(0);
    });

    it('content 없는 메시지 필터링', () => {
        const msgs = [{ role: 'user', content: null }];
        const result = sanitizeMessages(msgs);
        expect(result).toHaveLength(0);
    });

    it('빈 content 메시지 필터링', () => {
        const msgs = [{ role: 'user', content: '' }, { role: 'user', content: '   ' }];
        const result = sanitizeMessages(msgs);
        expect(result).toHaveLength(0);
    });

    it('비배열 입력 → 빈 배열', () => {
        expect(sanitizeMessages(null)).toEqual([]);
        expect(sanitizeMessages('not array')).toEqual([]);
    });

    it('qak 태그 제거', () => {
        const msgs = [{ role: 'user', content: 'test <qak>hidden</qak> end' }];
        const result = sanitizeMessages(msgs);
        expect(result[0].content).toBe('test hidden end');
    });

    it('toJSON 프로퍼티 제거', () => {
        const msgs = [{ role: 'user', content: 'hi', toJSON: () => 'custom' }];
        const result = sanitizeMessages(msgs);
        expect(result[0]).not.toHaveProperty('toJSON');
    });
});

describe('sanitizeBodyJSON', () => {
    it('messages 배열 정화', () => {
        const body = JSON.stringify({
            messages: [
                { role: 'user', content: 'Hello' },
                null,
                { role: '', content: 'bad' },
            ],
        });
        const result = JSON.parse(sanitizeBodyJSON(body));
        expect(result.messages).toHaveLength(1);
    });

    it('유효하지 않은 JSON → 원본 반환', () => {
        expect(sanitizeBodyJSON('not json')).toBe('not json');
    });

    it('contents 배열 null 필터링', () => {
        const body = JSON.stringify({
            contents: [{ role: 'user', parts: [] }, null],
        });
        const result = JSON.parse(sanitizeBodyJSON(body));
        expect(result.contents).toHaveLength(1);
    });
});

describe('isInlaySceneWrapperText', () => {
    it('인레이 감싼 텍스트 감지', () => {
        expect(isInlaySceneWrapperText('<lb-xnai scene="test">{{inlay::data}}</lb-xnai>')).toBe(true);
        expect(isInlaySceneWrapperText('<lb-xnai scene="chapter1">{{inlayed::scene}}</lb-xnai>')).toBe(true);
        expect(isInlaySceneWrapperText('<lb-xnai scene="s1">{{inlayeddata::img}}</lb-xnai>')).toBe(true);
    });

    it('일반 텍스트 → false', () => {
        expect(isInlaySceneWrapperText('normal text')).toBe(false);
        expect(isInlaySceneWrapperText('')).toBe(false);
    });

    it('인레이 키워드가 일부만 포함 → false', () => {
        expect(isInlaySceneWrapperText('inlayScene')).toBe(false);
        expect(isInlaySceneWrapperText('@@inlayScene_wrapper start@@')).toBe(false);
    });
});

describe('stripThoughtDisplayContent', () => {
    it('<Thoughts> 블록 제거', () => {
        const input = '<Thoughts>\nthinking here\n</Thoughts>\n\nActual answer';
        const result = stripThoughtDisplayContent(input);
        expect(result).toBe('Actual answer');
    });

    it('여러 Thoughts 블록 제거', () => {
        const input = '<Thoughts>first</Thoughts>\n\n<Thoughts>second</Thoughts>\n\nFinal';
        const result = stripThoughtDisplayContent(input);
        expect(result).toBe('Final');
    });

    it('빈/null 입력 → 그대로 반환', () => {
        expect(stripThoughtDisplayContent(null)).toBeNull();
        expect(stripThoughtDisplayContent('')).toBe('');
        expect(stripThoughtDisplayContent(undefined)).toBeUndefined();
    });

    it('Thoughts 블록 없으면 원본 유지', () => {
        expect(stripThoughtDisplayContent('Just normal text')).toBe('Just normal text');
    });

    it('> [Thought Process] 마커 처리', () => {
        const input = '> [Thought Process]\n> line1\n> line2\n\n\nActual content here';
        const result = stripThoughtDisplayContent(input);
        expect(result).toContain('Actual content here');
    });
});

describe('stripInternalTags — inlay guard', () => {
    it('인레이 감싼 텍스트에서는 태그 제거 안 함', () => {
        const text = '<lb-xnai scene="test">{{inlay::data}}</lb-xnai> <qak>should stay</qak>';
        const result = stripInternalTags(text);
        // 인레이 텍스트는 그대로 반환 (trimmed)
        expect(result).toBe(text.trim());
    });
});
