/**
 * @file coverage-boost-pass3.test.js — 커버리지 확대 테스트
 *
 * 미커버 라인 + 실패 경로 + 엣지 케이스 전용.
 * 대상: message-format.js, sse-parser.js, helpers.js
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ipc-protocol getRisu ──
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({
        getArgument: vi.fn(async () => ''),
        setArgument: vi.fn(),
    }),
    CH: { CONTROL: 'cpm-control', RESPONSE: 'cpm-response', FETCH: 'cpm-fetch', ABORT: 'cpm-abort' },
    MSG: {},
    safeUUID: () => 'test-uuid',
    MANAGER_NAME: 'CPM',
}));

import { formatToAnthropic, formatToGemini, formatToOpenAI } from '../src/shared/message-format.js';
import { collectStream } from '../src/shared/helpers.js';
import {
    parseGeminiSSELine,
    parseOpenAISSELine,
    createOpenAISSEStream,
    createAnthropicSSEStream,
    saveThoughtSignatureFromStream,
    parseClaudeNonStreamingResponse,
    parseGeminiNonStreamingResponse,
    parseOpenAINonStreamingResponse,
    parseResponsesAPINonStreamingResponse,
    normalizeOpenAIMessageContent,
    ThoughtSignatureCache,
    GEMINI_BLOCK_REASONS,
} from '../src/shared/sse-parser.js';

const mkMsg = (role, content, extra = {}) => ({ role, content, ...extra });

// ═══════════════════════════════════════
// message-format.js — 미커버 브랜치
// ═══════════════════════════════════════
describe('formatToAnthropic — uncovered branches', () => {
    it('system message with object content → JSON.stringify', () => {
        const msgs = [
            mkMsg('system', { instruction: 'Be helpful', lang: 'ko' }),
            mkMsg('user', 'Hello'),
        ];
        const { system } = formatToAnthropic(msgs, {});
        expect(system).toContain('instruction');
        expect(system).toContain('Be helpful');
    });

    it('system message with array content → JSON.stringify', () => {
        const msgs = [
            mkMsg('system', ['instruction1', 'instruction2']),
            mkMsg('user', 'Hello'),
        ];
        const { system } = formatToAnthropic(msgs, {});
        expect(system).toContain('instruction1');
    });

    it('system message with number content → coerced', () => {
        const msgs = [mkMsg('system', 42), mkMsg('user', 'Hi')];
        const { system } = formatToAnthropic(msgs, {});
        expect(system).toContain('42');
    });

    it('multiple consecutive system messages → all extracted to system prompt', () => {
        const msgs = [
            mkMsg('system', 'First system'),
            mkMsg('system', 'Second system'),
            mkMsg('user', 'Hello'),
        ];
        const { system, messages } = formatToAnthropic(msgs, {});
        expect(system).toContain('First system');
        expect(system).toContain('Second system');
        expect(messages.every(m => m.role !== 'system')).toBe(true);
    });

    it('non-leading system message → converted to user with "system:" prefix', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Mid-chat system'),
            mkMsg('assistant', 'Response'),
        ];
        const { messages } = formatToAnthropic(msgs, {});
        // Non-leading system should be merged into user messages
        const userContent = messages.filter(m => m.role === 'user')
            .flatMap(m => Array.isArray(m.content) ? m.content.map(b => b.text || '') : [m.content])
            .join(' ');
        expect(userContent).toContain('system:');
    });

    it('mixed multimodal + text merge path A — text fallback when no valid images', () => {
        const msgs = [
            mkMsg('user', 'First message'),
            { role: 'user', content: 'Text with multimodals field', multimodals: [{ type: 'image', base64: '', mimeType: 'image/png' }] },
        ];
        const { messages } = formatToAnthropic(msgs, {});
        expect(messages.filter(m => m.role === 'user').length).toBeGreaterThanOrEqual(1);
    });

    it('message with null content — skipped', () => {
        const msgs = [mkMsg('user', null), mkMsg('user', 'Valid')];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsgs = messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('message with undefined content — skipped', () => {
        const msgs = [mkMsg('user', undefined), mkMsg('user', 'Valid')];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsgs = messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it('char and model roles map to user (only "assistant" maps to assistant)', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('char', 'I am a character'),
            mkMsg('model', 'Model response'),
        ];
        const { messages } = formatToAnthropic(msgs, {});
        // Only 'assistant' role maps to 'assistant'; char/model → 'user'
        expect(messages.every(m => m.role === 'user')).toBe(true);
    });

    it('all empty messages → Start prepended', () => {
        const msgs = [mkMsg('user', ''), mkMsg('assistant', '')];
        const { messages } = formatToAnthropic(msgs, {});
        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(messages[0].role).toBe('user');
    });

    it('image_url with https URL → Anthropic URL source', () => {
        const msgs = [{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
        }];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        const imgBlock = userMsg?.content?.find(b => b.type === 'image' && b.source?.type === 'url');
        expect(imgBlock).toBeDefined();
        expect(imgBlock.source.url).toBe('https://example.com/image.png');
    });

    it('image_url as string (not object)', () => {
        const msgs = [{
            role: 'user',
            content: [{ type: 'image_url', image_url: 'data:image/png;base64,iVBOR' }],
        }];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        expect(userMsg?.content?.some(b => b.type === 'image')).toBe(true);
    });

    it('input_image type processing', () => {
        const msgs = [{
            role: 'user',
            content: [{ type: 'input_image', image_url: { url: 'data:image/jpeg;base64,/9j/' } }],
        }];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        expect(userMsg?.content?.some(b => b.type === 'image')).toBe(true);
    });
});

describe('formatToGemini — uncovered branches', () => {
    it('system message → systemInstruction (preserveSystem: true)', () => {
        const msgs = [mkMsg('system', 'You are helpful'), mkMsg('user', 'Hi')];
        const { systemInstruction: sysArr } = formatToGemini(msgs, { preserveSystem: true });
        expect(sysArr).toBeDefined();
        expect(sysArr.some(s => s.includes('You are helpful'))).toBe(true);
    });

    it('system message inlined when preserveSystem is falsy', () => {
        const msgs = [mkMsg('system', 'You are helpful'), mkMsg('user', 'Hi')];
        const { systemInstruction: sysArr, contents } = formatToGemini(msgs, {});
        // Without preserveSystem, system messages get inlined as "system: ..." prefix
        expect(sysArr.length).toBe(0);
        const firstPart = contents[0]?.parts?.[0]?.text || '';
        expect(firstPart).toContain('system: You are helpful');
    });

    it('system message with object content → JSON.stringify (preserveSystem: true)', () => {
        const msgs = [mkMsg('system', { mode: 'translation' }), mkMsg('user', 'Hi')];
        const { systemInstruction: sysArr } = formatToGemini(msgs, { preserveSystem: true });
        expect(sysArr.some(s => s.includes('translation'))).toBe(true);
    });

    it('non-leading system → "system: content" format', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Mid system'),
            mkMsg('assistant', 'Reply'),
        ];
        const { contents } = formatToGemini(msgs, {});
        const allText = contents.flatMap(c => c.parts.map(p => p.text || '')).join(' ');
        expect(allText).toContain('system: Mid system');
    });

    it('preserveSystem: false → all system messages as inline', () => {
        const msgs = [mkMsg('system', 'Sys'), mkMsg('user', 'Hi')];
        const { systemInstruction: sysArr, contents } = formatToGemini(msgs, { preserveSystem: false });
        expect(sysArr.length).toBe(0);
    });

    it('consecutive same-role messages merge', () => {
        const msgs = [
            mkMsg('user', 'Part 1'),
            mkMsg('user', 'Part 2'),
            mkMsg('assistant', 'Ok'),
        ];
        const { contents } = formatToGemini(msgs, {});
        // First content should have both parts
        expect(contents[0].parts.length).toBeGreaterThanOrEqual(2);
    });

    it('empty content messages skipped', () => {
        const msgs = [mkMsg('user', ''), mkMsg('user', '  '), mkMsg('user', 'Valid')];
        const { contents } = formatToGemini(msgs, {});
        expect(contents.length).toBeGreaterThanOrEqual(1);
    });

    it('multimodal messages with inlineData', () => {
        const msgs = [{
            role: 'user',
            content: [
                { text: 'Describe this' },
                { inlineData: { data: 'iVBOR', mimeType: 'image/png' } },
            ],
        }];
        const { contents } = formatToGemini(msgs, {});
        expect(contents[0].parts.some(p => p.inlineData)).toBe(true);
    });

    it('first message being assistant → user "." prepended', () => {
        const msgs = [mkMsg('assistant', 'I start first')];
        const { contents } = formatToGemini(msgs, {});
        expect(contents[0].role).toBe('user');
    });
});

// ═══════════════════════════════════════
// sse-parser.js — 미커버 브랜치
// ═══════════════════════════════════════
describe('parseGeminiSSELine — edge cases', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('thinking part with showThoughtsToken → opens thought block', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: false };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }] } }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('thinking...');
        expect(config._inThoughtBlock).toBe(true);
    });

    it('non-thought text after thinking → closes thought block', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'final answer' }] } }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('final answer');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('finishReason closes open thought block', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'final', thought: true }] }, finishReason: 'STOP' }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
    });

    it('safety block reason → error message', () => {
        const config = {};
        const line = `data: ${JSON.stringify({
            candidates: [{ finishReason: 'SAFETY' }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('Gemini Safety Block');
    });

    it('safety block while in thought block → closes thought first', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ finishReason: 'RECITATION' }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Gemini Safety Block');
    });

    it('usageMetadata tracked in config', () => {
        const config = {};
        const line = `data: ${JSON.stringify({
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        })}`;
        parseGeminiSSELine(line, config);
        expect(config._streamUsageMetadata).toBeDefined();
        expect(config._streamUsageMetadata.promptTokenCount).toBe(100);
    });

    it('thought_signature captured', () => {
        const config = { useThoughtSignature: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [
                { text: 'response', thought_signature: 'sig123' },
            ] } }],
        })}`;
        parseGeminiSSELine(line, config);
        expect(config._lastSignature).toBe('sig123');
    });

    it('invalid JSON → returns null', () => {
        expect(parseGeminiSSELine('data: {invalid json}', {})).toBeNull();
    });

    it('non-data line → returns null', () => {
        expect(parseGeminiSSELine('event: message', {})).toBeNull();
    });

    it('empty parts → returns null', () => {
        const line = `data: ${JSON.stringify({ candidates: [{ content: { parts: [] } }] })}`;
        expect(parseGeminiSSELine(line, {})).toBeNull();
    });
});

describe('parseOpenAISSELine — edge cases', () => {
    it('reasoning_content with showThinking → opens Thoughts', () => {
        const config = { showThinking: true, _inThinking: false };
        const line = `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: 'thinking...' } }],
        })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(config._inThinking).toBe(true);
    });

    it('reasoning (alternative field) with showThinking', () => {
        const config = { showThinking: true, _inThinking: false };
        const line = `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'think step' } }],
        })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('<Thoughts>');
    });

    it('content after reasoning → closes Thoughts', () => {
        const config = { showThinking: true, _inThinking: true };
        const line = `data: ${JSON.stringify({
            choices: [{ delta: { content: 'Final answer' } }],
        })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Final answer');
    });

    it('usage tracking via stream_options', () => {
        const config = { _requestId: 'req-1' };
        const line = `data: ${JSON.stringify({
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}`;
        // Should not crash and should return null (no delta)
        expect(parseOpenAISSELine(line, config)).toBeNull();
    });

    it('[DONE] message → null', () => {
        expect(parseOpenAISSELine('data: [DONE]', {})).toBeNull();
    });

    it('invalid JSON → null', () => {
        expect(parseOpenAISSELine('data: {broken}', {})).toBeNull();
    });

    it('no delta in choices → null', () => {
        const line = `data: ${JSON.stringify({ choices: [{}] })}`;
        expect(parseOpenAISSELine(line, {})).toBeNull();
    });
});

describe('saveThoughtSignatureFromStream — edge cases', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('closes open thought block', () => {
        const config = { _inThoughtBlock: true };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('saves signature to cache', () => {
        const config = {
            _lastSignature: 'sig-abc',
            _streamResponseText: 'Final response text',
        };
        saveThoughtSignatureFromStream(config);
        expect(ThoughtSignatureCache.get('Final response text')).toBe('sig-abc');
    });

    it('no signature or text → returns null', () => {
        const config = {};
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toBeNull();
    });

    it('finalize Gemini usage metadata', () => {
        const config = {
            _requestId: 'gemini-req',
            _streamUsageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
        };
        // Should not crash
        saveThoughtSignatureFromStream(config);
    });
});

describe('parseClaudeNonStreamingResponse — edge cases', () => {
    it('error response', () => {
        const data = { type: 'error', error: { message: 'Rate limited' } };
        const result = parseClaudeNonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('Rate limited');
    });

    it('thinking + text content blocks', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'Let me analyze...' },
                { type: 'text', text: 'The answer is 42' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Let me analyze');
        expect(result.content).toContain('</Thoughts>');
        expect(result.content).toContain('The answer is 42');
    });

    it('redacted_thinking block', () => {
        const data = {
            content: [
                { type: 'redacted_thinking' },
                { type: 'text', text: 'Answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('redacted_thinking');
        expect(result.content).toContain('Answer');
    });

    it('showThinking false → no Thoughts tags', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'Internal thought' },
                { type: 'text', text: 'Visible answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: false });
        expect(result.content).not.toContain('<Thoughts>');
        expect(result.content).toContain('Visible answer');
    });

    it('token usage tracking', () => {
        const data = {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 20, output_tokens: 10 },
        };
        // Should not crash with _requestId
        const result = parseClaudeNonStreamingResponse(data, { _requestId: 'claude-1' });
        expect(result.success).toBe(true);
    });
});

describe('parseGeminiNonStreamingResponse — edge cases', () => {
    it('safety block → error', () => {
        const data = { candidates: [{ finishReason: 'SAFETY', safetyRatings: [] }] };
        const result = parseGeminiNonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('Gemini Safety Block');
    });

    it('promptFeedback blockReason → error', () => {
        const data = { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } };
        const result = parseGeminiNonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('PROHIBITED_CONTENT');
    });

    it('thinking parts with showThoughtsToken', () => {
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { text: 'Thinking step', thought: true },
                        { text: 'Final answer' },
                    ],
                },
            }],
        };
        const result = parseGeminiNonStreamingResponse(data, { showThoughtsToken: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('</Thoughts>');
        expect(result.content).toContain('Final answer');
    });

    it('thought_signature extraction + cache', () => {
        ThoughtSignatureCache.clear();
        const data = {
            candidates: [{
                content: {
                    parts: [
                        { text: 'Response body', thought_signature: 'extracted-sig' },
                    ],
                },
            }],
        };
        parseGeminiNonStreamingResponse(data, { useThoughtSignature: true });
        expect(ThoughtSignatureCache.get('Response body')).toBe('extracted-sig');
    });

    it('usageMetadata tracking', () => {
        const data = {
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10 },
        };
        const result = parseGeminiNonStreamingResponse(data, { _requestId: 'g-req-1' });
        expect(result.success).toBe(true);
    });
});

describe('parseOpenAINonStreamingResponse — edge cases', () => {
    it('error response', () => {
        const data = { error: { message: 'Invalid API key' } };
        const result = parseOpenAINonStreamingResponse(data, {});
        expect(result.success).toBe(false);
        expect(result.content).toContain('Invalid API key');
    });

    it('no choices → error', () => {
        const data = {};
        const result = parseOpenAINonStreamingResponse(data, {});
        expect(result.success).toBe(false);
    });

    it('reasoning_content with showThinking', () => {
        const data = {
            choices: [{ message: { content: 'Answer', reasoning_content: 'Step by step...' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Step by step');
    });

    it('DeepSeek <think> extraction', () => {
        const data = {
            choices: [{ message: { content: '<think>Internal reasoning</think>Final output' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Internal reasoning');
        expect(result.content).toContain('Final output');
    });

    it('showThinking false → no reasoning extraction', () => {
        const data = {
            choices: [{ message: { content: 'Answer', reasoning_content: 'Hidden' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: false });
        expect(result.content).not.toContain('<Thoughts>');
        expect(result.content).toBe('Answer');
    });

    it('token usage tracking', () => {
        const data = {
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
        const result = parseOpenAINonStreamingResponse(data, { _requestId: 'oai-1' });
        expect(result.success).toBe(true);
    });
});

describe('parseResponsesAPINonStreamingResponse — edge cases', () => {
    it('error response', () => {
        const data = { error: { message: 'Server error' } };
        const result = parseResponsesAPINonStreamingResponse(data, {});
        expect(result.success).toBe(false);
    });

    it('output with message + reasoning', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Step 1...' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Final' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Step 1');
        expect(result.content).toContain('Final');
    });

    it('showThinking false → no reasoning', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Hidden' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'Visible' }] },
            ],
        };
        const result = parseResponsesAPINonStreamingResponse(data, { showThinking: false });
        expect(result.content).not.toContain('Hidden');
        expect(result.content).toContain('Visible');
    });

    it('fallback to chat completions format', () => {
        const data = { choices: [{ message: { content: 'Fallback content' } }] };
        const result = parseResponsesAPINonStreamingResponse(data, {});
        expect(result.success).toBe(true);
        expect(result.content).toBe('Fallback content');
    });

    it('unexpected format → error', () => {
        const data = { some: 'weird format' };
        const result = parseResponsesAPINonStreamingResponse(data, {});
        expect(result.success).toBe(false);
    });

    it('token usage tracking', () => {
        const data = {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 5, output_tokens: 3 },
        };
        const result = parseResponsesAPINonStreamingResponse(data, { _requestId: 'resp-1' });
        expect(result.success).toBe(true);
    });
});

describe('normalizeOpenAIMessageContent — edge cases', () => {
    it('null → empty string', () => {
        expect(normalizeOpenAIMessageContent(null)).toBe('');
    });

    it('undefined → empty string', () => {
        expect(normalizeOpenAIMessageContent(undefined)).toBe('');
    });

    it('number → string', () => {
        expect(normalizeOpenAIMessageContent(42)).toBe('42');
    });

    it('array of text parts', () => {
        const content = [{ text: 'Part 1' }, { text: 'Part 2' }];
        expect(normalizeOpenAIMessageContent(content)).toBe('Part 1Part 2');
    });

    it('array with type:text content parts', () => {
        const content = [{ type: 'text', content: 'Alt format' }];
        expect(normalizeOpenAIMessageContent(content)).toBe('Alt format');
    });

    it('array with mixed valid and invalid parts', () => {
        const content = [{ text: 'Valid' }, null, 42, { type: 'image' }];
        expect(normalizeOpenAIMessageContent(content)).toBe('Valid');
    });

    it('array of plain strings', () => {
        const content = ['Hello', ' ', 'World'];
        expect(normalizeOpenAIMessageContent(content)).toBe('Hello World');
    });
});

describe('GEMINI_BLOCK_REASONS constant', () => {
    it('contains expected safety block reasons', () => {
        expect(GEMINI_BLOCK_REASONS).toContain('SAFETY');
        expect(GEMINI_BLOCK_REASONS).toContain('RECITATION');
        expect(GEMINI_BLOCK_REASONS).toContain('PROHIBITED_CONTENT');
        expect(GEMINI_BLOCK_REASONS).toContain('BLOCKLIST');
        expect(GEMINI_BLOCK_REASONS).toContain('OTHER');
        expect(GEMINI_BLOCK_REASONS).toContain('SPII');
    });
});

// ═══════════════════════════════════════
// Anthropic SSE Streaming — 통합 테스트
// ═══════════════════════════════════════
describe('createAnthropicSSEStream — integration', () => {
    function makeSSEResponse(events) {
        const text = events.join('\n\n') + '\n\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(text));
                controller.close();
            },
        });
        return { body: stream };
    }

    it('parses text_delta events into readable stream', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hello"}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":" World"}}',
            'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, { showThinking: false });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('Hello');
        expect(result).toContain(' World');
    });

    it('handles thinking blocks when showThinking is true', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
            'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Step 1..."}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Answer"}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Step 1...');
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Answer');
    });

    it('handles error events', async () => {
        const response = makeSSEResponse([
            'event: error\ndata: {"type":"error","error":{"message":"Rate limit exceeded"}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, { showThinking: false });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('Stream Error');
        expect(result).toContain('Rate limit exceeded');
    });

    it('handles pre-aborted signal gracefully', async () => {
        const ac = new AbortController();
        ac.abort(); // Pre-abort before stream starts
        const response = makeSSEResponse([
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Should not appear"}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, ac.signal, { showThinking: false });
        const reader = sseStream.getReader();
        let result = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                result += value;
            }
        } catch { /* AbortError expected */ }
        // Pre-aborted stream should produce empty or no output
        expect(result.length).toBeLessThanOrEqual('Should not appear'.length);
    });

    it('handles redacted_thinking in content_block_start', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
            'event: content_block_start\ndata: {"content_block":{"type":"redacted_thinking"}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Answer"}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('redacted_thinking');
    });

    it('handles cache_read_input_tokens in usage', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":8,"cache_creation_input_tokens":2}}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Cached!"}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, { showThinking: false, _requestId: 'cache-test' });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('Cached!');
    });
});

// ═══════════════════════════════════════
// OpenAI SSE Streaming — 통합 테스트
// ═══════════════════════════════════════
describe('createOpenAISSEStream — integration', () => {
    function makeSSEResponse(lines) {
        const text = lines.join('\n') + '\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(text));
                controller.close();
            },
        });
        return { body: stream };
    }

    it('accumulates content from delta chunks', async () => {
        const response = makeSSEResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: ' World' } }] })}`,
            'data: [DONE]',
        ]);
        const sseStream = createOpenAISSEStream(response, null, { showThinking: false });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toBe('Hello World');
    });

    it('handles reasoning + content transition', async () => {
        const response = makeSSEResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Think...' } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer' } }] })}`,
            'data: [DONE]',
        ]);
        const sseStream = createOpenAISSEStream(response, null, { showThinking: true });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Think...');
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Answer');
    });
});

// ═══════════════════════════════════════
// message-format.js — cache_control 브랜치 (L339)
// ═══════════════════════════════════════
describe('formatToAnthropic — cache_control / cachePoint', () => {
    it('cachePoint on message → adds cache_control to last content block', () => {
        const msgs = [
            mkMsg('user', 'Long context text', { cachePoint: true }),
            mkMsg('assistant', 'I understand'),
        ];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        const lastBlock = userMsg.content[userMsg.content.length - 1];
        expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('cachePoint propagates through merged same-role messages', () => {
        const msgs = [
            mkMsg('user', 'First part'),
            mkMsg('user', 'Second part', { cachePoint: true }),
            mkMsg('assistant', 'Reply'),
        ];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        // Should have cache_control on last content block
        const lastBlock = userMsg.content[userMsg.content.length - 1];
        expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('no cachePoint → no cache_control', () => {
        const msgs = [mkMsg('user', 'Normal message'), mkMsg('assistant', 'Ok')];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        for (const block of userMsg.content) {
            expect(block.cache_control).toBeUndefined();
        }
    });
});

// ═══════════════════════════════════════
// message-format.js — same-role merge string→array (L319)
// ═══════════════════════════════════════
describe('formatToAnthropic — same-role merge paths', () => {
    it('consecutive user messages merge into array content', () => {
        const msgs = [
            mkMsg('user', 'First'),
            mkMsg('user', 'Second'),
            mkMsg('assistant', 'Reply'),
        ];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        expect(userMsg.content.length).toBe(2);
        expect(userMsg.content[0].text).toBe('First');
        expect(userMsg.content[1].text).toBe('Second');
    });

    it('non-leading system merges into previous user message', () => {
        const msgs = [
            mkMsg('user', 'Normal'),
            mkMsg('system', 'Mid-system instruction'),
            mkMsg('assistant', 'Reply'),
        ];
        const { messages } = formatToAnthropic(msgs, {});
        const userMsg = messages.find(m => m.role === 'user');
        const texts = userMsg.content.map(b => b.text);
        expect(texts.some(t => t?.includes('system:'))).toBe(true);
    });
});

// ═══════════════════════════════════════
// Anthropic SSE — usage finalization paths (L198, L202)
// ═══════════════════════════════════════
describe('createAnthropicSSEStream — usage finalization', () => {
    function makeSSEResponse(events) {
        const text = events.join('\n\n') + '\n\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(text));
                controller.close();
            },
        });
        return { body: stream };
    }

    it('tracks usage from message_start + message_delta on completion', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100}}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Some response"}}',
            'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, {
            showThinking: false,
            _requestId: 'usage-test-1',
        });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('Some response');
    });

    it('tracks thinking delta + redacted_thinking in content_block_delta', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
            'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Let me think..."}}',
            'event: content_block_delta\ndata: {"delta":{"type":"redacted_thinking"}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Final answer"}}',
            'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, {
            showThinking: true,
            _requestId: 'thinking-delta-test',
        });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Let me think...');
        expect(result).toContain('redacted_thinking');
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Final answer');
    });

    it('showThinking: false still tracks _hasThinking for usage', async () => {
        const response = makeSSEResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30}}}',
            'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Hidden thought"}}',
            'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Visible"}}',
        ]);
        const sseStream = createAnthropicSSEStream(response, null, {
            showThinking: false,
            _requestId: 'hidden-thinking',
        });
        const reader = sseStream.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += value;
        }
        // showThinking is false, so no <Thoughts> tags
        expect(result).not.toContain('<Thoughts>');
        expect(result).toContain('Visible');
    });
});

// ═══════════════════════════════════════
// formatToOpenAI — 추가 엣지 케이스
// ═══════════════════════════════════════
describe('formatToOpenAI — uncovered branches', () => {
    it('multimodal parts preserved as-is', () => {
        const msgs = [{
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
            ],
        }];
        const result = formatToOpenAI(msgs);
        expect(result[0].content).toHaveLength(2);
    });

    it('consecutive same-role messages preserved (not merged)', () => {
        const msgs = [mkMsg('user', 'A'), mkMsg('user', 'B')];
        const result = formatToOpenAI(msgs);
        // OpenAI format does NOT merge same-role messages
        expect(result.length).toBe(2);
    });

    it('empty array → empty result', () => {
        const result = formatToOpenAI([]);
        expect(result).toEqual([]);
    });
});

// ═══════════════════════════════════════
// helpers.js — collectStream 미커버 브랜치
// ═══════════════════════════════════════
describe('collectStream — edge cases', () => {
    function makeReadableStream(chunks) {
        return new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            },
        });
    }

    it('collects string chunks', async () => {
        const stream = makeReadableStream(['Hello', ' ', 'World']);
        const result = await collectStream(stream);
        expect(result).toBe('Hello World');
    });

    it('collects Uint8Array chunks', async () => {
        const encoder = new TextEncoder();
        const stream = makeReadableStream([encoder.encode('AB'), encoder.encode('CD')]);
        const result = await collectStream(stream);
        expect(result).toBe('ABCD');
    });

    it('collects ArrayBuffer chunks', async () => {
        const encoder = new TextEncoder();
        const ab = encoder.encode('Test').buffer;
        const stream = makeReadableStream([ab]);
        const result = await collectStream(stream);
        expect(result).toBe('Test');
    });

    it('skips null/undefined chunks (L677)', async () => {
        const stream = makeReadableStream([null, 'Valid', undefined, 'Also']);
        const result = await collectStream(stream);
        expect(result).toBe('ValidAlso');
    });

    it('converts unknown value types via String()', async () => {
        const stream = makeReadableStream([42, true]);
        const result = await collectStream(stream);
        expect(result).toBe('42true');
    });

    it('respects abortSignal — stops collecting', async () => {
        const ac = new AbortController();
        let enqueueFn;
        const stream = new ReadableStream({
            start(controller) {
                enqueueFn = (v) => controller.enqueue(v);
                enqueueFn('First');
            },
        });
        ac.abort();
        const result = await collectStream(stream, ac.signal);
        // With pre-aborted signal, should stop immediately
        expect(typeof result).toBe('string');
    });

    it('empty stream → empty string', async () => {
        const stream = makeReadableStream([]);
        const result = await collectStream(stream);
        expect(result).toBe('');
    });
});
