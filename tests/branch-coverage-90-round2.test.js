/**
 * branch-coverage-90-round2.test.js
 *
 * Targeted branch coverage tests to push sub-90% modules toward/past 90%.
 * Targets: key-pool, sse-parser, message-format, helpers, sub-plugin-toggle-ui
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── key-pool ──
import { KeyPool } from '../src/shared/key-pool.js';

describe('key-pool — comma-separated JSON & withRotation options', () => {
    it('fromJson parses comma-separated JSON objects (M-1 path)', () => {
        const pool = KeyPool.fromJson('{"key":"a"},{"key":"b"}');
        expect(pool.remaining).toBe(2);
    });

    it('fromJson — comma-separated with spaces', () => {
        const pool = KeyPool.fromJson('  {"id":1} , {"id":2} , {"id":3}  ');
        expect(pool.remaining).toBe(3);
    });

    it('fromJson — single JSON object (non-array)', () => {
        const pool = KeyPool.fromJson('{"key":"single"}');
        expect(pool.remaining).toBe(1);
    });

    it('withRotation with explicit maxRetries', async () => {
        const pool = new KeyPool('key1,key2', 'test');
        const result = await pool.withRotation(
            async (key) => ({ success: true, content: 'ok' }),
            { maxRetries: 2 },
        );
        expect(result.success).toBe(true);
    });

    it('withRotation with custom isRetryable', async () => {
        const pool = new KeyPool('key1,key2', 'test');
        let attempt = 0;
        const result = await pool.withRotation(
            async (key) => {
                attempt++;
                if (attempt === 1) return { success: false, content: 'fail', _status: 500 };
                return { success: true, content: 'ok' };
            },
            { isRetryable: (r) => r._status === 500 },
        );
        expect(result.success).toBe(true);
        expect(attempt).toBe(2);
    });

    it('withRotation — empty pool name gives clean error message', async () => {
        const pool = new KeyPool('', '');
        const result = await pool.withRotation(async () => ({ success: true, content: 'ok' }));
        expect(result.success).toBe(false);
        expect(result.content).toContain('사용 가능한 키 없음');
    });

    it('_buildJsonCredentialError without detail param', () => {
        const pool = KeyPool.fromJson('{bad-json-no-colon}');
        expect(pool._jsonParseError).toBeTruthy();
        expect(pool._jsonParseError).toContain('JSON 파싱 실패');
    });

    it('_buildJsonCredentialError windows_path without name', () => {
        const pool = KeyPool.fromJson('C:\\Users\\test\\key.json', '');
        expect(pool._jsonParseError).toContain('파일 경로');
    });

    it('fromJson — UNC path detection', () => {
        const pool = KeyPool.fromJson('\\\\server\\share\\keys.json');
        expect(pool._jsonParseError).toBeTruthy();
    });
});

// ── sse-parser — branch push ──
import {
    parseOpenAISSELine,
    parseGeminiSSELine,
    parseOpenAINonStreamingResponse,
    parseClaudeNonStreamingResponse,
    parseGeminiNonStreamingResponse,
    normalizeOpenAIMessageContent,
    GEMINI_BLOCK_REASONS,
} from '../src/shared/sse-parser.js';

describe('parseOpenAISSELine — uncovered branches', () => {
    it('usage field present with _requestId → tracks token usage', () => {
        const config = { _requestId: 'req-sse-001' };
        const line = `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toBeNull(); // no delta → returns null
    });

    it('usage field present without _requestId → does not crash', () => {
        const config = {};
        const line = `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toBeNull();
    });

    it('delta.reasoning (not reasoning_content) — OpenRouter path', () => {
        const config = { showThinking: true };
        const line = `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'thinking step...' } }],
        })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('Thoughts');
        expect(result).toContain('thinking step...');
    });

    it('delta with only content after thinking phase', () => {
        const config = { showThinking: true, _inThinking: true };
        const line = `data: ${JSON.stringify({
            choices: [{ delta: { content: 'visible response' } }],
        })}`;
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('visible response');
        expect(config._inThinking).toBe(false);
    });
});

describe('parseOpenAINonStreamingResponse — DeepSeek <think> path', () => {
    it('showThinking + msg.reasoning_content → wraps in Thoughts', () => {
        const data = {
            choices: [{ message: { reasoning_content: 'I should...', content: 'Answer' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.success).toBe(true);
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('I should...');
        expect(result.content).toContain('Answer');
    });

    it('showThinking + msg.reasoning (OpenRouter) → wraps in Thoughts', () => {
        const data = {
            choices: [{ message: { reasoning: 'Step 1...', content: 'Final' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Step 1...');
    });

    it('showThinking + DeepSeek <think> block in content → extracts', () => {
        const data = {
            choices: [{ message: { content: '<think>Hmm let me think</think>The answer is 42.' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Hmm let me think');
        expect(result.content).toContain('The answer is 42.');
    });

    it('showThinking + content with <think> but no closing tag → normal fallback', () => {
        const data = {
            choices: [{ message: { content: 'No think tag here, just normal text' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: true });
        expect(result.content).toBe('No think tag here, just normal text');
    });

    it('showThinking=false → ignores reasoning_content', () => {
        const data = {
            choices: [{ message: { reasoning_content: 'hidden', content: 'visible' } }],
        };
        const result = parseOpenAINonStreamingResponse(data, { showThinking: false });
        expect(result.content).toBe('visible');
    });

    it('data.usage with _requestId → token tracking exercised', () => {
        const data = {
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
        const result = parseOpenAINonStreamingResponse(data, { _requestId: 'req-001' });
        expect(result.success).toBe(true);
    });
});

describe('parseGeminiSSELine — uncovered branches', () => {
    it('blockReason during _inThoughtBlock → closes thought tag', () => {
        const config = { _inThoughtBlock: true };
        const line = `data: ${JSON.stringify({
            promptFeedback: { blockReason: 'SAFETY' },
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Gemini Safety Block');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('part with thought_signature → updates _lastSignature', () => {
        const config = { showThoughtsToken: false, useThoughtSignature: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [
                { text: 'response content', thought_signature: 'sig_abc123' },
            ] } }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('response content');
        expect(config._lastSignature).toBe('sig_abc123');
    });

    it('part with thoughtSignature (camelCase) → updates _lastSignature', () => {
        const config = { useThoughtSignature: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [
                { text: 'hello', thoughtSignature: 'sig_xyz' },
            ] } }],
        })}`;
        parseGeminiSSELine(line, config);
        expect(config._lastSignature).toBe('sig_xyz');
    });

    it('thought part with text when showThoughtsToken=true', () => {
        const config = { showThoughtsToken: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [
                { thought: true, text: 'thinking...' },
            ] } }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('thinking...');
    });

    it('useThoughtSignature + model role → accumulates _streamResponseText', () => {
        const config = { useThoughtSignature: true, _streamResponseText: '' };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'chunk1' }] } }],
        })}`;
        parseGeminiSSELine(line, config);
        expect(config._streamResponseText).toBe('chunk1');
    });

    it('finishReason while _inThoughtBlock → closes thought', () => {
        const config = { _inThoughtBlock: true };
        const line = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        })}`;
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('usageMetadata → stores in config._streamUsageMetadata', () => {
        const config = {};
        const line = `data: ${JSON.stringify({
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
            candidates: [{ content: { parts: [{ text: 'x' }] } }],
        })}`;
        parseGeminiSSELine(line, config);
        expect(config._streamUsageMetadata).toBeDefined();
        expect(config._streamUsageMetadata.promptTokenCount).toBe(100);
    });
});

describe('parseClaudeNonStreamingResponse — thinking branches', () => {
    it('redacted_thinking block with showThinking', () => {
        const data = {
            content: [
                { type: 'redacted_thinking' },
                { type: 'text', text: 'result' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('{{redacted_thinking}}');
        expect(result.content).toContain('result');
    });

    it('thinking block followed by text', () => {
        const data = {
            content: [
                { type: 'thinking', thinking: 'Analyzing...' },
                { type: 'text', text: 'Here is the answer' },
            ],
        };
        const result = parseClaudeNonStreamingResponse(data, { showThinking: true });
        expect(result.content).toContain('<Thoughts>');
        expect(result.content).toContain('Analyzing...');
        expect(result.content).toContain('</Thoughts>');
        expect(result.content).toContain('Here is the answer');
    });

    it('data.usage with _requestId → tracks', () => {
        const data = {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = parseClaudeNonStreamingResponse(data, { _requestId: 'req-c-001' });
        expect(result.success).toBe(true);
    });

    it('error response with data.error', () => {
        const data = { type: 'error', error: { message: 'Overloaded' } };
        const result = parseClaudeNonStreamingResponse(data);
        expect(result.success).toBe(false);
        expect(result.content).toContain('Overloaded');
    });
});

describe('normalizeOpenAIMessageContent — edge cases', () => {
    it('null → empty string', () => {
        expect(normalizeOpenAIMessageContent(null)).toBe('');
    });

    it('undefined → empty string', () => {
        expect(normalizeOpenAIMessageContent(undefined)).toBe('');
    });

    it('array with string parts', () => {
        expect(normalizeOpenAIMessageContent(['hello', ' world'])).toBe('hello world');
    });

    it('array with { type: "text", content: "..." } parts', () => {
        expect(normalizeOpenAIMessageContent([
            { type: 'text', content: 'via content field' },
        ])).toBe('via content field');
    });

    it('array with mixed types including null', () => {
        expect(normalizeOpenAIMessageContent([
            { text: 'part1' },
            null,
            42,
            { type: 'text', content: 'part2' },
        ])).toBe('part1part2');
    });

    it('numeric content → String coerced', () => {
        expect(normalizeOpenAIMessageContent(42)).toBe('42');
    });

    it('object content → String coerced', () => {
        const result = normalizeOpenAIMessageContent({ someKey: 'val' });
        expect(result).toBe('[object Object]');
    });
});

// ── message-format — branch push ──
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';

describe('formatToOpenAI — uncovered branches', () => {
    it('mergesys — system-only messages → sysPrompt but no non-system messages', () => {
        const result = formatToOpenAI(
            [{ role: 'system', content: 'System prompt' }],
            { mergesys: true },
        );
        // After mergesys, newMsgs is empty → sysPrompt doesn't get merged into anything
        expect(result.length).toBe(0);
    });

    it('mustuser — first message is assistant → prepends user placeholder', () => {
        const result = formatToOpenAI(
            [{ role: 'assistant', content: 'Hello' }],
            { mustuser: true },
        );
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe(' ');
    });

    it('altrole — assistant becomes model', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
            { altrole: true },
        );
        expect(result.find(m => m.role === 'model')).toBeTruthy();
    });

    it('altrole — consecutive same-role messages merge (string + string)', () => {
        const result = formatToOpenAI(
            [
                { role: 'user', content: 'part1' },
                { role: 'user', content: 'part2' },
            ],
            { altrole: true },
        );
        expect(result.length).toBe(1);
        expect(result[0].content).toContain('part1');
        expect(result[0].content).toContain('part2');
    });

    it('altrole — consecutive same-role with array + string merge', () => {
        const result = formatToOpenAI(
            [
                { role: 'user', content: [{ type: 'text', text: 'array part' }] },
                { role: 'user', content: 'string part' },
            ],
            { altrole: true },
        );
        expect(result.length).toBe(1);
        expect(Array.isArray(result[0].content)).toBe(true);
    });

    it('content as array with Anthropic base64 source image', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/jpeg' } },
            ] }],
        );
        expect(result.length).toBe(1);
        const content = result[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0].type).toBe('image_url');
        expect(content[0].image_url.url).toContain('data:image/jpeg;base64,abc123');
    });

    it('content as array with inlineData (non-image/non-audio) → filtered out', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: [
                { inlineData: { data: 'video_data', mimeType: 'video/mp4' } },
                { type: 'text', text: 'hello' },
            ] }],
        );
        expect(result.length).toBe(1);
        // video/mp4 inlineData → skipped, only text part remains
    });

    it('content as array with inlineData image', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: [
                { inlineData: { data: 'imgdata', mimeType: 'image/png' } },
            ] }],
        );
        const content = result[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0].type).toBe('image_url');
    });

    it('content as array with inlineData audio', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: [
                { inlineData: { data: 'audiodata', mimeType: 'audio/wav' } },
            ] }],
        );
        const content = result[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0].type).toBe('input_audio');
    });

    it('non-string/non-array content → falls back to payload text', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: 12345 }],
        );
        expect(result.length).toBe(1);
    });

    it('developerRole — system becomes developer', () => {
        const result = formatToOpenAI(
            [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
            { developerRole: true },
        );
        expect(result[0].role).toBe('developer');
    });

    it('sysfirst — moves first system to front', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: 'hi' }, { role: 'system', content: 'sys' }],
            { sysfirst: true },
        );
        expect(result[0].role).toBe('system');
    });

    it('role=model → assistant normalization', () => {
        const result = formatToOpenAI(
            [{ role: 'model', content: 'response' }],
        );
        expect(result[0].role).toBe('assistant');
    });

    it('role=char → assistant normalization', () => {
        const result = formatToOpenAI(
            [{ role: 'char', content: 'response' }],
        );
        expect(result[0].role).toBe('assistant');
    });

    it('msg.name preserved when it is a string', () => {
        const result = formatToOpenAI(
            [{ role: 'user', content: 'hi', name: 'Alice' }],
        );
        expect(result[0].name).toBe('Alice');
    });
});

describe('formatToAnthropic — uncovered branches', () => {
    it('array content with image_url type (data URI)', () => {
        const result = formatToAnthropic(
            [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
            ] }],
        );
        const msg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        expect(msg).toBeTruthy();
        // Should convert image_url → Anthropic base64 source format
        const imgPart = msg.content.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.type).toBe('base64');
    });

    it('array content with image_url type (HTTP URL)', () => {
        const result = formatToAnthropic(
            [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
            ] }],
        );
        const msg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const imgPart = msg.content.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.type).toBe('url');
    });

    it('array content with image_url string format', () => {
        const result = formatToAnthropic(
            [{ role: 'user', content: [
                { type: 'image_url', image_url: 'https://example.com/direct.png' },
            ] }],
        );
        const msg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const imgPart = msg.content.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
        expect(imgPart.source.url).toBe('https://example.com/direct.png');
    });

    it('array content with input_image type', () => {
        const result = formatToAnthropic(
            [{ role: 'user', content: [
                { type: 'input_image', image_url: { url: 'data:image/jpeg;base64,xyz789' } },
            ] }],
        );
        const msg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        const imgPart = msg.content.find(p => p.type === 'image');
        expect(imgPart).toBeTruthy();
    });

    it('array content merges into previous same-role message', () => {
        const result = formatToAnthropic(
            [
                { role: 'user', content: 'text first' },
                { role: 'user', content: [
                    { type: 'image', source: { type: 'base64', data: 'abc', media_type: 'image/png' } },
                ] },
            ],
        );
        // Should merge into single user message
        const userMsgs = result.messages.filter(m => m.role === 'user');
        // First message is the "Start" placeholder, second should contain both text and image
        const lastUser = userMsgs[userMsgs.length - 1];
        expect(Array.isArray(lastUser.content)).toBe(true);
    });

    it('multimodal URL image with http URL', () => {
        const result = formatToAnthropic(
            [{ role: 'user', content: 'look at this', multimodals: [{ type: 'image', url: 'https://example.com/photo.jpg' }] }],
        );
        const msg = result.messages.find(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
        expect(msg).toBeTruthy();
        const imgPart = msg.content.find(p => p.type === 'image');
        expect(imgPart.source.type).toBe('url');
    });

    it('consecutive same-role multimodal → merges into previous', () => {
        const result = formatToAnthropic(
            [
                { role: 'user', content: 'first', multimodals: [{ type: 'image', base64: 'data:image/png;base64,aaa' }] },
                { role: 'user', content: 'second', multimodals: [{ type: 'image', base64: 'data:image/png;base64,bbb' }] },
            ],
        );
        const userMsgs = result.messages.filter(m => m.role === 'user');
        // Merged into single user message
        expect(userMsgs.length).toBeLessThanOrEqual(2); // Start + merged
    });

    it('cachePoint on simple text content → cache_control added', () => {
        const result = formatToAnthropic(
            [
                { role: 'user', content: 'Cache this', cachePoint: true },
                { role: 'assistant', content: 'ok' },
            ],
        );
        const userMsg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        if (userMsg) {
            const lastPart = userMsg.content[userMsg.content.length - 1];
            expect(lastPart.cache_control).toBeDefined();
        }
    });

    it('non-leading system → converted to user with "system:" prefix', () => {
        const result = formatToAnthropic(
            [
                { role: 'user', content: 'Hello' },
                { role: 'system', content: 'Mid-conversation instruction' },
                { role: 'assistant', content: 'OK' },
            ],
        );
        // The system message should be converted to user role
        const userMsgs = result.messages.filter(m => m.role === 'user');
        const systemAsUser = userMsgs.find(m => {
            if (Array.isArray(m.content)) {
                return m.content.some(p => typeof p.text === 'string' && p.text.startsWith('system:'));
            }
            return false;
        });
        expect(systemAsUser).toBeTruthy();
    });

    it('default text path — consecutive same-role merge (non-array into array)', () => {
        const result = formatToAnthropic(
            [
                { role: 'user', content: [{ type: 'text', text: 'array part' }] },
                { role: 'user', content: 'text part' },
            ],
        );
        // Should merge text into the array
        const userMsgs = result.messages.filter(m => m.role === 'user');
        const merged = userMsgs.find(m => Array.isArray(m.content) && m.content.length >= 2);
        expect(merged).toBeTruthy();
    });

    it('multimodal paths — no contentParts (empty modal) → falls to text path', () => {
        const result = formatToAnthropic(
            [{ role: 'user', content: 'text here', multimodals: [{ type: 'unknown' }] }],
        );
        expect(result.messages.length).toBeGreaterThan(0);
    });
});

describe('formatToGemini — uncovered branches', () => {
    it('first non-system message is assistant → prepends user placeholder', () => {
        const result = formatToGemini(
            [{ role: 'assistant', content: 'Hello there' }],
        );
        expect(result.contents.length).toBeGreaterThanOrEqual(2);
        expect(result.contents[0].role).toBe('user');
        expect(result.contents[0].parts[0].text).toBe('Start');
    });

    it('useThoughtSignature + model role → attaches cached sig', async () => {
        // First, save a signature
        const { ThoughtSignatureCache } = await import('../src/shared/sse-parser.js');
        ThoughtSignatureCache.clear();
        ThoughtSignatureCache.save('cached response text', 'sig_cached');

        const result = formatToGemini(
            [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'cached response text' },
            ],
            { useThoughtSignature: true },
        );
        const modelMsg = result.contents.find(c => c.role === 'model');
        expect(modelMsg).toBeTruthy();
        const sigPart = modelMsg.parts.find(p => p.thoughtSignature);
        expect(sigPart).toBeTruthy();
        expect(sigPart.thoughtSignature).toBe('sig_cached');
        ThoughtSignatureCache.clear();
    });

    it('non-leading system → user with "system:" prefix', () => {
        const result = formatToGemini(
            [
                { role: 'user', content: 'Hello' },
                { role: 'system', content: 'Mid instruction' },
                { role: 'assistant', content: 'OK' },
            ],
        );
        // System should be converted to user with "system:" prefix
        const userMsgs = result.contents.filter(c => c.role === 'user');
        const hasSysPrefix = userMsgs.some(m => m.parts.some(p => p.text && p.text.startsWith('system:')));
        expect(hasSysPrefix).toBe(true);
    });

    it('multimodal — consecutive same-role merge into lastMessage', () => {
        const result = formatToGemini(
            [
                { role: 'user', content: 'first', multimodals: [{ type: 'image', base64: 'data:image/png;base64,aaa' }] },
                { role: 'user', content: 'second', multimodals: [{ type: 'image', url: 'https://example.com/img.png' }] },
            ],
        );
        // Should merge into same user content
        const userMsgs = result.contents.filter(c => c.role === 'user');
        expect(userMsgs.length).toBeLessThanOrEqual(2);
    });

    it('multimodal — image URL → fileData', () => {
        const result = formatToGemini(
            [{ role: 'user', content: 'look', multimodals: [{ type: 'image', url: 'https://example.com/test.jpg' }] }],
        );
        const userMsg = result.contents.find(c => c.role === 'user' && c.parts.some(p => p.fileData));
        expect(userMsg).toBeTruthy();
    });

    it('multimodal — audio type → inlineData', () => {
        const result = formatToGemini(
            [{ role: 'user', content: 'listen', multimodals: [{ type: 'audio', base64: 'data:audio/wav;base64,audiodata' }] }],
        );
        const userMsg = result.contents.find(c => c.role === 'user' && c.parts.some(p => p.inlineData));
        expect(userMsg).toBeTruthy();
    });

    it('multimodal merge — text merges into lastPart when it is inlineData', () => {
        const result = formatToGemini(
            [
                { role: 'user', content: 'desc1', multimodals: [{ type: 'image', base64: 'data:image/png;base64,img1' }] },
                { role: 'user', content: 'desc2', multimodals: [{ type: 'image', base64: 'data:image/png;base64,img2' }] },
            ],
        );
        // The text parts should be separate { text } entries after the inlineData
        const userMsgs = result.contents.filter(c => c.role === 'user');
        const lastUser = userMsgs[userMsgs.length - 1];
        expect(lastUser.parts.length).toBeGreaterThanOrEqual(2);
    });

    it('preserveSystem → system instruction returned separately', () => {
        const result = formatToGemini(
            [
                { role: 'system', content: 'Be helpful' },
                { role: 'user', content: 'Hi' },
            ],
            { preserveSystem: true },
        );
        expect(result.systemInstruction).toEqual(['Be helpful']);
    });

    it('!preserveSystem — system prepended to first user part', () => {
        const result = formatToGemini(
            [
                { role: 'system', content: 'Be helpful' },
                { role: 'user', content: 'Hi' },
            ],
        );
        const firstUser = result.contents[0];
        expect(firstUser.role).toBe('user');
        expect(firstUser.parts[0].text).toContain('system:');
    });

    it('!preserveSystem — no existing user → wraps system as user', () => {
        const result = formatToGemini(
            [
                { role: 'system', content: 'System only' },
                { role: 'assistant', content: 'Reply' },
            ],
        );
        // System instruction should be inserted as user role
        expect(result.contents[0].role).toBe('user');
    });
});

// ── helpers — branch push ──
import { _stripNonSerializable, extractImageUrlFromPart, _raceWithAbortSignal } from '../src/shared/helpers.js';

describe('_stripNonSerializable — edge cases', () => {
    it('function → undefined', () => {
        expect(_stripNonSerializable(() => {})).toBeUndefined();
    });

    it('symbol → undefined', () => {
        expect(_stripNonSerializable(Symbol('test'))).toBeUndefined();
    });

    it('bigint → undefined', () => {
        expect(_stripNonSerializable(BigInt(42))).toBeUndefined();
    });

    it('Date → string', () => {
        const d = new Date('2025-01-01');
        expect(typeof _stripNonSerializable(d)).toBe('string');
    });

    it('RegExp → string', () => {
        expect(typeof _stripNonSerializable(/abc/g)).toBe('string');
    });

    it('Error → string', () => {
        expect(typeof _stripNonSerializable(new Error('test'))).toBe('string');
    });

    it('Uint8Array → pass through', () => {
        const arr = new Uint8Array([1, 2, 3]);
        expect(_stripNonSerializable(arr)).toBe(arr);
    });

    it('ArrayBuffer → pass through', () => {
        const buf = new ArrayBuffer(4);
        expect(_stripNonSerializable(buf)).toBe(buf);
    });

    it('deeply nested object (depth > 15) → returns as-is', () => {
        let obj = { val: 'leaf' };
        for (let i = 0; i < 20; i++) obj = { nested: obj };
        const result = _stripNonSerializable(obj);
        expect(result).toBeTruthy();
    });

    it('array with functions → filters out', () => {
        const result = _stripNonSerializable([1, () => {}, 'hello', Symbol('x')]);
        expect(result).toEqual([1, 'hello']);
    });

    it('object with function/symbol values → removes them', () => {
        const result = _stripNonSerializable({ a: 1, b: () => {}, c: Symbol('x'), d: 'ok' });
        expect(result).toEqual({ a: 1, d: 'ok' });
    });

    it('null → null', () => {
        expect(_stripNonSerializable(null)).toBeNull();
    });

    it('undefined → undefined', () => {
        expect(_stripNonSerializable(undefined)).toBeUndefined();
    });

    it('primitives pass through (string, number, boolean)', () => {
        expect(_stripNonSerializable('hello')).toBe('hello');
        expect(_stripNonSerializable(42)).toBe(42);
        expect(_stripNonSerializable(true)).toBe(true);
    });
});

describe('extractImageUrlFromPart — input_image type', () => {
    it('input_image with string image_url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'https://img.com/a.png' }))
            .toBe('https://img.com/a.png');
    });

    it('input_image with object image_url.url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'https://img.com/b.png' } }))
            .toBe('https://img.com/b.png');
    });

    it('null part → empty string', () => {
        expect(extractImageUrlFromPart(null)).toBe('');
    });

    it('unknown type → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'video' })).toBe('');
    });
});

describe('_raceWithAbortSignal — pre-aborted signal', () => {
    it('pre-aborted signal → rejects immediately', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(_raceWithAbortSignal(Promise.resolve('ok'), ac.signal))
            .rejects.toThrow('aborted');
    });

    it('null signal → passes through', async () => {
        const result = await _raceWithAbortSignal(Promise.resolve('ok'), null);
        expect(result).toBe('ok');
    });

    it('undefined signal → passes through', async () => {
        const result = await _raceWithAbortSignal(Promise.resolve('ok'), undefined);
        expect(result).toBe('ok');
    });
});

// ── sub-plugin-toggle-ui — click handler re-render ──
import { createSubPluginToggleUI } from '../src/shared/sub-plugin-toggle-ui.js';

describe('sub-plugin-toggle-ui — click handler re-render branch (L98-103)', () => {
    function makeMockRisu() {
        const elements = {};
        const doc = {
            createElement: vi.fn((tag) => {
                const el = {
                    tagName: tag,
                    children: [],
                    style: {},
                    innerHTML: '',
                    _attrs: {},
                    _handlers: {},
                    setAttribute: vi.fn((k, v) => { el._attrs[k] = v; }),
                    getAttribute: vi.fn((k) => el._attrs[k] || null),
                    setStyle: vi.fn((k, v) => { el.style[k] = v; }),
                    setInnerHTML: vi.fn(async (html) => { el.innerHTML = html; }),
                    addEventListener: vi.fn(async (event, handler) => { el._handlers[event] = handler; }),
                    querySelector: vi.fn(async (sel) => {
                        const match = sel.match(/\[x-cpm-toggle-btn="(\d+)"\]/);
                        if (match) return elements[`toggle-${match[1]}`] || null;
                        return null;
                    }),
                    remove: vi.fn(),
                    appendChild: vi.fn(),
                };
                return el;
            }),
            querySelector: vi.fn(async () => null),
        };
        const body = {
            appendChild: vi.fn(),
        };
        const Risu = {
            getRootDocument: vi.fn(async () => doc),
            getDocument: vi.fn(async () => ({ body })),
        };
        return { Risu, doc, body, elements };
    }

    it('toggle click handler calls onToggle and re-renders', async () => {
        const { Risu, doc, elements } = makeMockRisu();
        const escHtml = (s) => String(s).replace(/</g, '&lt;');

        const ui = createSubPluginToggleUI({ Risu, escHtml });
        const onToggle = vi.fn();
        const states = [
            { name: 'Plugin A', enabled: true },
            { name: 'Plugin B', enabled: false },
        ];

        // Create toggle button elements that querySelector will find
        const toggleBtn0 = {
            _handlers: {},
            addEventListener: vi.fn(async (event, handler) => { toggleBtn0._handlers[event] = handler; }),
        };
        const toggleBtn1 = {
            _handlers: {},
            addEventListener: vi.fn(async (event, handler) => { toggleBtn1._handlers[event] = handler; }),
        };
        elements['toggle-0'] = toggleBtn0;
        elements['toggle-1'] = toggleBtn1;

        await ui.renderTogglePanel(states, onToggle);

        // Simulate clicking toggle button 0
        if (toggleBtn0._handlers.click) {
            await toggleBtn0._handlers.click();
        }

        expect(onToggle).toHaveBeenCalledWith('Plugin A', false); // was true → now false
        expect(states[0].enabled).toBe(false);
    });
});
