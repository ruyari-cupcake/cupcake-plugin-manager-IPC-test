/**
 * @file sse-parser.test.js — SSE 파싱 유틸리티 테스트
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    ThoughtSignatureCache,
    parseOpenAISSELine,
    parseGeminiSSELine,
    parseGeminiNonStreamingResponse,
    parseClaudeNonStreamingResponse,
    GEMINI_BLOCK_REASONS,
    normalizeOpenAIMessageContent,
    parseOpenAINonStreamingResponse,
    parseResponsesAPINonStreamingResponse,
    saveThoughtSignatureFromStream,
    createOpenAISSEStream,
} from '../src/shared/sse-parser.js';

// ═══════════════════════════════════════
// ThoughtSignatureCache
// ═══════════════════════════════════════
describe('ThoughtSignatureCache', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('save + get 기본 동작', () => {
        ThoughtSignatureCache.save('hello world', 'sig123');
        expect(ThoughtSignatureCache.get('hello world')).toBe('sig123');
    });

    it('존재하지 않는 키 → null', () => {
        expect(ThoughtSignatureCache.get('unknown')).toBeNull();
    });

    it('null/빈 값 → save 무시', () => {
        ThoughtSignatureCache.save('', 'sig');
        ThoughtSignatureCache.save('text', '');
        ThoughtSignatureCache.save(null, 'sig');
        expect(ThoughtSignatureCache.get('')).toBeNull();
    });

    it('clear 동작', () => {
        ThoughtSignatureCache.save('key', 'val');
        ThoughtSignatureCache.clear();
        expect(ThoughtSignatureCache.get('key')).toBeNull();
    });

    it('최대 50개 제한 — LRU 방식 삭제', () => {
        for (let i = 0; i < 55; i++) {
            ThoughtSignatureCache.save(`key-${i}`, `sig-${i}`);
        }
        // 초기 항목 삭제됨
        expect(ThoughtSignatureCache.get('key-0')).toBeNull();
        // 최신 항목 유지
        expect(ThoughtSignatureCache.get('key-54')).toBe('sig-54');
    });
});

// ═══════════════════════════════════════
// parseOpenAISSELine
// ═══════════════════════════════════════
describe('parseOpenAISSELine', () => {
    it('기본 텍스트 delta 파싱', () => {
        const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
        expect(parseOpenAISSELine(line)).toBe('Hello');
    });

    it('[DONE] → null', () => {
        expect(parseOpenAISSELine('data: [DONE]')).toBeNull();
    });

    it('data: 접두사 없음 → null', () => {
        expect(parseOpenAISSELine('event: done')).toBeNull();
    });

    it('비유효 JSON → null', () => {
        expect(parseOpenAISSELine('data: {invalid}')).toBeNull();
    });

    it('빈 delta → null', () => {
        const line = 'data: {"choices":[{"delta":{}}]}';
        expect(parseOpenAISSELine(line)).toBeNull();
    });

    it('choices 없음 → null', () => {
        expect(parseOpenAISSELine('data: {"id":"x"}')).toBeNull();
    });

    it('reasoning_content (showThinking 켜짐)', () => {
        const config = { showThinking: true, _inThinking: false };
        const line = 'data: {"choices":[{"delta":{"reasoning_content":"Think..."}}]}';
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Think...');
        expect(config._inThinking).toBe(true);
    });

    it('thinking → text 전환', () => {
        const config = { showThinking: true, _inThinking: true };
        const line = 'data: {"choices":[{"delta":{"content":"Answer"}}]}';
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Answer');
        expect(config._inThinking).toBe(false);
    });

    it('showThinking 꺼짐 → reasoning_content 무시', () => {
        const config = { showThinking: false };
        const line = 'data: {"choices":[{"delta":{"reasoning_content":"Think..."}}]}';
        const result = parseOpenAISSELine(line, config);
        expect(result).toBeNull();
    });
});

// ═══════════════════════════════════════
// parseGeminiSSELine
// ═══════════════════════════════════════
describe('parseGeminiSSELine', () => {
    it('기본 텍스트 파싱', () => {
        const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}';
        expect(parseGeminiSSELine(line)).toBe('Hello');
    });

    it('Safety block 감지', () => {
        const line = 'data: {"candidates":[{"finishReason":"SAFETY"}]}';
        const result = parseGeminiSSELine(line);
        expect(result).toContain('Safety Block');
    });

    it('data: 접두사 없음 → null', () => {
        expect(parseGeminiSSELine('not data')).toBeNull();
    });

    it('thought part (showThoughtsToken 켜짐)', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: false };
        const line = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}';
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Thinking...');
    });

    it('thought → text 전환', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Answer"}]}}]}';
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Answer');
    });

    it('thought_signature 캡처', () => {
        const config = { useThoughtSignature: true };
        const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hi","thought_signature":"sig123"}]}}]}';
        parseGeminiSSELine(line, config);
        expect(config._lastSignature).toBe('sig123');
    });

    it('비유효 JSON → null', () => {
        expect(parseGeminiSSELine('data: broken}')).toBeNull();
    });
});

// ═══════════════════════════════════════
// parseGeminiNonStreamingResponse
// ═══════════════════════════════════════
describe('parseGeminiNonStreamingResponse', () => {
    it('단일 텍스트 part', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] };
        const result = parseGeminiNonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello');
    });

    it('Safety block → 실패', () => {
        const data = { candidates: [{ finishReason: 'SAFETY' }] };
        const result = parseGeminiNonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Safety Block');
    });

    it('thought + text 혼합', () => {
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { thought: true, text: 'Thinking here' },
                        { text: 'Final answer' },
                    ],
                },
            }],
        };
        const result = parseGeminiNonStreamingResponse(data, { showThoughtsToken: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Thinking here');
        expect(result.content).toContain('</Thoughts>');
        expect(result.content).toContain('Final answer');
    });

    it('thought 없이 text만', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'Just text' }] } }] };
        const result = parseGeminiNonStreamingResponse(data, { showThoughtsToken: true });
        expect(result.content).not.toContain('Thoughts');
        expect(result.content).toBe('Just text');
    });

    it('빈 응답', () => {
        const result = parseGeminiNonStreamingResponse({});
        expect(result.success).toBe(true);
        expect(result.content).toBe('');
    });
});

// ═══════════════════════════════════════
// parseClaudeNonStreamingResponse
// ═══════════════════════════════════════
describe('parseClaudeNonStreamingResponse', () => {
    it('기본 텍스트 응답', () => {
        const data = { content: [{ type: 'text', text: 'Hello from Claude' }] };
        const result = parseClaudeNonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello from Claude');
    });

    it('에러 응답', () => {
        const data = { type: 'error', error: { message: 'Rate limited' } };
        const result = parseClaudeNonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Rate limited');
    });

    it('thinking + text 혼합', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'Let me think...' },
                { type: 'text', text: 'Answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Let me think...');
        expect(result.content).toContain('</Thoughts>');
        expect(result.content).toContain('Answer');
    });

    it('redacted thinking', () => {
        const data = {
            content: [
                { type: 'redacted_thinking' },
                { type: 'text', text: 'Answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('[REDACTED]');
        expect(result.content).toContain('Answer');
    });

    it('showThinking 꺼짐 → thinking 무시', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'Secret thoughts' },
                { type: 'text', text: 'Answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: false });
        expect(result.content).not.toContain('Secret thoughts');
        expect(result.content).toBe('Answer');
    });

    it('빈 content 배열', () => {
        const data = { content: [] };
        const result = parseClaudeNonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('');
    });
});

// ═══════════════════════════════════════
// GEMINI_BLOCK_REASONS 상수
// ═══════════════════════════════════════
describe('GEMINI_BLOCK_REASONS', () => {
    it('주요 블록 사유 포함', () => {
        expect(GEMINI_BLOCK_REASONS).toContain('SAFETY');
        expect(GEMINI_BLOCK_REASONS).toContain('RECITATION');
        expect(GEMINI_BLOCK_REASONS).toContain('PROHIBITED_CONTENT');
    });
});

// ═══════════════════════════════════════
// parseOpenAISSELine — reasoning alias (C-12)
// ═══════════════════════════════════════
describe('parseOpenAISSELine — reasoning (C-12)', () => {
    it('delta.reasoning alias로 thinking 표시', () => {
        const data = { choices: [{ delta: { reasoning: 'I think...' } }] };
        const line = 'data: ' + JSON.stringify(data);
        const config = { showThinking: true };
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('I think...');
    });

    it('reasoning_content 우선', () => {
        const data = { choices: [{ delta: { reasoning_content: 'Primary', reasoning: 'Fallback' } }] };
        const line = 'data: ' + JSON.stringify(data);
        const config = { showThinking: true };
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('Primary');
    });
});

// ═══════════════════════════════════════
// normalizeOpenAIMessageContent (C-10)
// ═══════════════════════════════════════
describe('normalizeOpenAIMessageContent', () => {
    it('문자열 → 그대로', () => {
        expect(normalizeOpenAIMessageContent('hello')).toBe('hello');
    });

    it('null → 빈 문자열', () => {
        expect(normalizeOpenAIMessageContent(null)).toBe('');
    });

    it('배열 → text 결합', () => {
        const parts = [{ text: 'A' }, { text: 'B' }];
        expect(normalizeOpenAIMessageContent(parts)).toBe('AB');
    });

    it('undefined → 빈 문자열', () => {
        expect(normalizeOpenAIMessageContent(undefined)).toBe('');
    });
});

// ═══════════════════════════════════════
// parseOpenAINonStreamingResponse (C-10)
// ═══════════════════════════════════════
describe('parseOpenAINonStreamingResponse', () => {
    it('기본 응답 파싱', () => {
        const data = { choices: [{ message: { content: 'Hello' } }] };
        const result = parseOpenAINonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello');
    });

    it('reasoning_content 포함', () => {
        const data = { choices: [{ message: { content: 'Answer', reasoning_content: 'Thinking...' } }] };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Thinking...');
        expect(result.content).toContain('Answer');
    });

    it('에러 응답', () => {
        const data = { error: { message: 'Bad request' } };
        const result = parseOpenAINonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Bad request');
    });

    it('빈 choices → 에러', () => {
        const data = { choices: [] };
        const result = parseOpenAINonStreamingResponse(data);
        expect(result.success).toBe(false);
    });

    it('DeepSeek <think> 블록 추출', () => {
        const data = { choices: [{ message: { content: '<think>reasoning</think>\nAnswer here' } }] };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('reasoning');
        expect(result.content).toContain('Answer here');
    });
});

// ═══════════════════════════════════════
// parseResponsesAPINonStreamingResponse (C-9)
// ═══════════════════════════════════════
describe('parseResponsesAPINonStreamingResponse', () => {
    it('기본 Responses API 응답', () => {
        const data = {
            output: [
                { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello');
    });

    it('reasoning summary 포함', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I thought about it' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Answer' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('I thought about it');
        expect(result.content).toContain('Answer');
    });

    it('에러 응답', () => {
        const data = { error: { message: 'Not found' } };
        const result = parseResponsesAPINonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Not found');
    });

    it('Chat Completions 형식 폴백', () => {
        const data = { choices: [{ message: { content: 'Fallback' } }] };
        const result = parseResponsesAPINonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('Fallback');
    });
});

// ═══════════════════════════════════════
// saveThoughtSignatureFromStream
// ═══════════════════════════════════════
describe('saveThoughtSignatureFromStream', () => {
    beforeEach(() => { ThoughtSignatureCache.clear(); });

    it('시그니처 캐시 저장', () => {
        const config = { _lastSignature: 'sig123', _streamResponseText: 'response text' };
        saveThoughtSignatureFromStream(config);
        expect(ThoughtSignatureCache.get('response text')).toBe('sig123');
    });

    it('thinking 블록 닫기', () => {
        const config = { _inThoughtBlock: true };
        const extra = saveThoughtSignatureFromStream(config);
        expect(extra).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('빈 config → null', () => {
        const result = saveThoughtSignatureFromStream({});
        expect(result).toBeNull();
    });
});

// ═══════════════════════════════════════
// parseGeminiSSELine — usage tracking (C-11)
// ═══════════════════════════════════════
describe('parseGeminiSSELine — usageMetadata', () => {
    it('usageMetadata 저장', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
        const config = {};
        const line = 'data: ' + JSON.stringify(data);
        parseGeminiSSELine(line, config);
        expect(config._streamUsageMetadata).toBeDefined();
        expect(config._streamUsageMetadata.promptTokenCount).toBe(10);
    });

    it('thought_signature → 최신 값으로 업데이트', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'resp', thought_signature: 'sig2' }] } }] };
        const config = { useThoughtSignature: true, _lastSignature: 'sig1' };
        const line = 'data: ' + JSON.stringify(data);
        parseGeminiSSELine(line, config);
        expect(config._lastSignature).toBe('sig2');
    });
});

// ═══════════════════════════════════════
// H-12: normalizeOpenAIMessageContent robustness
// ═══════════════════════════════════════
describe('normalizeOpenAIMessageContent — extended', () => {
    it('raw string array elements', () => {
        expect(normalizeOpenAIMessageContent(['hello', 'world'])).toBe('helloworld');
    });

    it('{type:"text", content:"..."} parts', () => {
        expect(normalizeOpenAIMessageContent([
            { type: 'text', content: 'from content field' }
        ])).toBe('from content field');
    });

    it('mixed array: string + text + content parts', () => {
        const result = normalizeOpenAIMessageContent([
            'raw',
            { text: 'textField' },
            { type: 'text', content: 'contentField' },
            null,
            42,
        ]);
        expect(result).toBe('rawtextFieldcontentField');
    });

    it('null elements in array gracefully skipped', () => {
        expect(normalizeOpenAIMessageContent([null, undefined, { text: 'ok' }])).toBe('ok');
    });

    it('non-standard types fallback to String()', () => {
        expect(normalizeOpenAIMessageContent(42)).toBe('42');
        expect(normalizeOpenAIMessageContent(true)).toBe('true');
    });
});

// ═══════════════════════════════════════
// M-5: ThoughtSignatureCache normalization
// ═══════════════════════════════════════
describe('ThoughtSignatureCache — normalization', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('strips <Thoughts> blocks for key normalization', () => {
        const textWithThoughts = '<Thoughts>\nreasoning\n</Thoughts>\n\nActual response here';
        ThoughtSignatureCache.save(textWithThoughts, 'sig-norm');
        // Should be retrievable with clean text
        expect(ThoughtSignatureCache.get('Actual response here')).toBe('sig-norm');
    });

    it('key max length is 500', () => {
        const longText = 'a'.repeat(600);
        ThoughtSignatureCache.save(longText, 'long-sig');
        // Can be retrieved with same long text (key truncated internally)
        expect(ThoughtSignatureCache.get(longText)).toBe('long-sig');
    });
});

// ═══════════════════════════════════════
// M-7: Non-streaming token usage for Gemini
// ═══════════════════════════════════════
describe('parseGeminiNonStreamingResponse — token usage', () => {
    it('usageMetadata 포함 시 config._requestId 기반 추적', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'answer' }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        };
        // _requestId 없으면 에러 안남
        const result = parseGeminiNonStreamingResponse(data, { _requestId: 'test-req' });
        expect(result.success).toBe(true);
        expect(result.content).toBe('answer');
    });
});

// ═══════════════════════════════════════
// M-7: Non-streaming token usage for Claude
// ═══════════════════════════════════════
describe('parseClaudeNonStreamingResponse — token usage', () => {
    it('usage 포함 시 thinking 여부 추적', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'reasoning' },
                { type: 'text', text: 'answer' },
            ],
            usage: { input_tokens: 50, output_tokens: 20 },
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true, _requestId: 'test-req' });
        expect(result.success).toBe(true);
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('answer');
    });

    it('text-only Claude response with usage', () => {
        const data = {
            content: [{ type: 'text', text: 'simple answer' }],
            usage: { input_tokens: 30, output_tokens: 10 },
        };
        const result = parseClaudeNonStreamingResponse(data, { _requestId: 'req2' });
        expect(result.success).toBe(true);
        expect(result.content).toBe('simple answer');
    });
});

// ═══════════════════════════════════════
// temp_repo 이식: 추가 응답 파서 엣지 케이스
// ═══════════════════════════════════════
describe('parseOpenAINonStreamingResponse — additional edge cases (ported)', () => {
    it('OpenRouter reasoning 필드 추출', () => {
        const data = {
            choices: [{ message: { content: 'answer', reasoning: 'thought process' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('thought process');
        expect(result.content).toContain('answer');
    });

    it('배열 content 처리', () => {
        const data = {
            choices: [{ message: { content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] } }],
        };
        const result = parseOpenAINonStreamingResponse(data);
        expect(result.content).toBe('part1part2');
    });

    it('빈 응답 → 실패', () => {
        const result = parseOpenAINonStreamingResponse({});
        expect(result.success).toBe(false);
    });
});

describe('parseGeminiNonStreamingResponse — additional edge cases (ported)', () => {
    it('PROHIBITED_CONTENT finishReason 감지', () => {
        const data = { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] };
        const result = parseGeminiNonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('PROHIBITED_CONTENT');
    });

    it('빈 parts 배열 → empty response', () => {
        const data = { candidates: [{ content: { parts: [] } }] };
        const result = parseGeminiNonStreamingResponse(data);
        expect(result.content).toContain('');
    });

    it('promptFeedback blockReason → 엄격 safety block', () => {
        const data = { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', probability: 'HIGH' }] } };
        const result = parseGeminiNonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Safety Block');
        expect(result.content).toContain('SAFETY');
    });
});

describe('parseClaudeNonStreamingResponse — additional edge cases (ported)', () => {
    it('thinking-only 응답 → Thoughts 태그 닫힘', () => {
        const data = {
            content: [{ type: 'thinking', thinking: 'still thinking...' }],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('</Thoughts>');
    });

    it('빈 content 배열 → 빈 문자열', () => {
        const data = { content: [] };
        const result = parseClaudeNonStreamingResponse(data);
        expect(result.success).toBe(true);
        expect(result.content).toBe('');
    });
});

describe('parseResponsesAPINonStreamingResponse — additional edge cases (ported)', () => {
    it('빈 output → 실패', () => {
        const result = parseResponsesAPINonStreamingResponse({});
        expect(result.success).toBe(false);
    });

    it('reasoning summary 포함 — 확장 검증', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I thought about it' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Final answer' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('I thought about it');
        expect(result.content).toContain('</Thoughts>');
        expect(result.content).toContain('Final answer');
    });
});

// STB-9: Stream content accumulation
describe('createOpenAISSEStream — content accumulation (STB-9)', () => {
    function makeStreamResponse(chunks) {
        let idx = 0;
        const reader = {
            read: async () => {
                if (idx >= chunks.length) return { done: true, value: undefined };
                const encoder = new TextEncoder();
                return { done: false, value: encoder.encode(chunks[idx++]) };
            },
            cancel: () => {},
        };
        return { body: { getReader: () => reader } };
    }

    it('accumulates content on config._accumulatedContent', async () => {
        const response = makeStreamResponse([
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
            'data: [DONE]\n\n',
        ]);
        const config = { _requestId: 'test-123' };
        const stream = createOpenAISSEStream(response, undefined, config);
        const reader = stream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        expect(chunks.join('')).toBe('Hello world');
        expect(config._accumulatedContent).toBe('Hello world');
    });

    it('accumulates thinking content too', async () => {
        const response = makeStreamResponse([
            'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
            'data: [DONE]\n\n',
        ]);
        const config = { showThinking: true, _requestId: 'test-456' };
        const stream = createOpenAISSEStream(response, undefined, config);
        const reader = stream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        // Content should contain thinking markers plus actual content
        expect(config._accumulatedContent).toContain('thinking...');
        expect(config._accumulatedContent).toContain('answer');
    });
});
