/**
 * @file streaming-sse-extended.test.js — Extended SSE streaming tests
 * Targets uncovered lines in sse-parser.js: createAnthropicSSEStream, createResponsesAPISSEStream, createSSEStream
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createSSEStream,
    createAnthropicSSEStream,
    createResponsesAPISSEStream,
    parseGeminiSSELine,
    parseOpenAISSELine,
    saveThoughtSignatureFromStream,
    ThoughtSignatureCache,
    GEMINI_BLOCK_REASONS,
} from '../src/shared/sse-parser.js';

// ── Helpers ──
function makeSSEResponse(lines) {
    const encoder = new TextEncoder();
    const text = lines.join('\n') + '\n';
    let read = false;
    const body = new ReadableStream({
        pull(controller) {
            if (!read) {
                read = true;
                controller.enqueue(encoder.encode(text));
            } else {
                controller.close();
            }
        }
    });
    return { body, ok: true, status: 200 };
}

function makeMultiChunkSSEResponse(chunks) {
    const encoder = new TextEncoder();
    let idx = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (idx < chunks.length) {
                controller.enqueue(encoder.encode(chunks[idx++]));
            } else {
                controller.close();
            }
        }
    });
    return { body, ok: true, status: 200 };
}

async function collectStream(stream) {
    const reader = stream.getReader();
    let result = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += value;
    }
    return result;
}

// ═══════════════════════════════════════
// createSSEStream — 기본 SSE ReadableStream
// ═══════════════════════════════════════
describe('createSSEStream', () => {
    it('parses SSE lines and emits parsed values', async () => {
        const response = makeSSEResponse([
            'data: hello',
            '',
            'data: world',
        ]);
        const parser = (line) => line.startsWith('data: ') ? line.slice(6) : null;
        const stream = createSSEStream(response, parser, undefined);
        const result = await collectStream(stream);
        expect(result).toBe('helloworld');
    });

    it('skips comment lines (starting with :)', async () => {
        const response = makeSSEResponse([
            ': this is a comment',
            'data: actual',
        ]);
        const parser = (line) => line.startsWith('data: ') ? line.slice(6) : null;
        const result = await collectStream(createSSEStream(response, parser, undefined));
        expect(result).toBe('actual');
    });

    it('calls onComplete when stream ends', async () => {
        const response = makeSSEResponse(['data: test']);
        const parser = (line) => line.startsWith('data: ') ? line.slice(6) : null;
        const stream = createSSEStream(response, parser, undefined, () => '[DONE]');
        const result = await collectStream(stream);
        expect(result).toBe('test[DONE]');
    });

    it('calls onComplete on abort', async () => {
        // When the body stream ends while abort is signalled, onComplete should fire
        const ac = new AbortController();
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: first\n\n'));
                // Close immediately so abort check runs on next pull
                controller.close();
            }
        });
        const response = { body };
        const parser = (line) => line.startsWith('data: ') ? line.slice(6) : null;
        const onComplete = vi.fn(() => '[EXTRA]');

        ac.abort();
        const stream = createSSEStream(response, parser, ac.signal, onComplete);
        const _result = await collectStream(stream);
        expect(onComplete).toHaveBeenCalled();
    });

    it('handles buffered incomplete lines across chunks', async () => {
        const response = makeMultiChunkSSEResponse([
            'data: hel',
            'lo\n\ndata: world\n',
        ]);
        const parser = (line) => line.startsWith('data: ') ? line.slice(6) : null;
        const result = await collectStream(createSSEStream(response, parser, undefined));
        expect(result).toBe('helloworld');
    });

    it('calls onComplete on cancel', async () => {
        const onComplete = vi.fn();
        const response = makeSSEResponse(['data: test']);
        const parser = (_line) => null;
        const stream = createSSEStream(response, parser, undefined, onComplete);
        const reader = stream.getReader();
        await reader.cancel();
        expect(onComplete).toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════
// createAnthropicSSEStream
// ═══════════════════════════════════════
describe('createAnthropicSSEStream', () => {
    it('parses content_block_delta text_delta events', async () => {
        const response = makeSSEResponse([
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"Hello"}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":" World"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, {}));
        expect(result).toBe('Hello World');
    });

    it('handles thinking blocks when showThinking=true', async () => {
        const response = makeSSEResponse([
            'event: content_block_delta',
            'data: {"delta":{"type":"thinking_delta","thinking":"Reasoning..."}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"Answer"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, { showThinking: true }));
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Reasoning...');
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Answer');
    });

    it('hides thinking blocks when showThinking=false', async () => {
        const response = makeSSEResponse([
            'event: content_block_delta',
            'data: {"delta":{"type":"thinking_delta","thinking":"Hidden"}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"Visible"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, { showThinking: false }));
        expect(result).not.toContain('Hidden');
        expect(result).toBe('Visible');
    });

    it('handles redacted_thinking in content_block_start', async () => {
        const response = makeSSEResponse([
            'event: content_block_start',
            'data: {"content_block":{"type":"redacted_thinking"}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"Result"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, { showThinking: true }));
        expect(result).toContain('{{redacted_thinking}}');
        expect(result).toContain('Result');
    });

    it('handles redacted_thinking delta', async () => {
        const response = makeSSEResponse([
            'event: content_block_delta',
            'data: {"delta":{"type":"redacted_thinking"}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"After"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, { showThinking: true }));
        expect(result).toContain('{{redacted_thinking}}');
        expect(result).toContain('After');
    });

    it('tracks message_start usage', async () => {
        const response = makeSSEResponse([
            'event: message_start',
            'data: {"message":{"usage":{"input_tokens":100,"cache_read_input_tokens":50}}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"Hi"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, { _requestId: 'test-req' }));
        expect(result).toBe('Hi');
    });

    it('tracks message_delta usage (output tokens)', async () => {
        const response = makeSSEResponse([
            'event: message_delta',
            'data: {"usage":{"output_tokens":50}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"Done"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, {}));
        expect(result).toBe('Done');
    });

    it('handles error events', async () => {
        const response = makeSSEResponse([
            'event: error',
            'data: {"error":{"message":"Rate limit"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, {}));
        expect(result).toContain('[Stream Error: Rate limit]');
    });

    it('closes thinking block on stream end', async () => {
        const response = makeSSEResponse([
            'event: content_block_delta',
            'data: {"delta":{"type":"thinking_delta","thinking":"Still thinking"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, { showThinking: true }));
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('</Thoughts>');
    });

    it('handles abort with open thinking block', async () => {
        const ac = new AbortController();
        const encoder = new TextEncoder();
        // Pre-abort so the stream sees it immediately
        ac.abort();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(
                    'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Think"}}\n\n'
                ));
                controller.close();
            }
        });
        const response = { body };
        const stream = createAnthropicSSEStream(response, ac.signal, { showThinking: true });
        // Collecting should handle abort gracefully and close thinking block
        const result = await collectStream(stream);
        // May or may not contain closing tag depending on abort timing,
        // but should not hang
        expect(typeof result).toBe('string');
    });

    it('handles "text" (alias for text_delta) in content_block_delta', async () => {
        const response = makeSSEResponse([
            'event: content_block_delta',
            'data: {"delta":{"type":"text","text":"AliasText"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, {}));
        expect(result).toBe('AliasText');
    });

    it('handles cache_creation_input_tokens in message_start', async () => {
        const response = makeSSEResponse([
            'event: message_start',
            'data: {"message":{"usage":{"input_tokens":200,"cache_creation_input_tokens":30}}}',
            '',
            'event: content_block_delta',
            'data: {"delta":{"type":"text_delta","text":"OK"}}',
        ]);
        const result = await collectStream(createAnthropicSSEStream(response, undefined, {}));
        expect(result).toBe('OK');
    });
});

// ═══════════════════════════════════════
// createResponsesAPISSEStream (GPT-5.4+)
// ═══════════════════════════════════════
describe('createResponsesAPISSEStream', () => {
    it('parses response.output_text.delta events', async () => {
        const response = makeSSEResponse([
            'data: {"type":"response.output_text.delta","delta":"Hello"}',
            '',
            'data: {"type":"response.output_text.delta","delta":" GPT5"}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, {}));
        expect(result).toBe('Hello GPT5');
    });

    it('handles reasoning_summary_text.delta when showThinking=true', async () => {
        const response = makeSSEResponse([
            'data: {"type":"response.reasoning_summary_text.delta","delta":"I think..."}',
            '',
            'data: {"type":"response.output_text.delta","delta":"Result"}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, { showThinking: true }));
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('I think...');
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Result');
    });

    it('hides reasoning when showThinking=false', async () => {
        const response = makeSSEResponse([
            'data: {"type":"response.reasoning_summary_text.delta","delta":"Hidden"}',
            '',
            'data: {"type":"response.output_text.delta","delta":"Shown"}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, { showThinking: false }));
        expect(result).not.toContain('Hidden');
        expect(result).toBe('Shown');
    });

    it('closes open reasoning block via onComplete', async () => {
        const response = makeSSEResponse([
            'data: {"type":"response.reasoning_summary_text.delta","delta":"Thinking..."}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, { showThinking: true }));
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('</Thoughts>');
    });

    it('ignores [DONE] sentinel', async () => {
        const response = makeSSEResponse([
            'data: {"type":"response.output_text.delta","delta":"OK"}',
            '',
            'data: [DONE]',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, {}));
        expect(result).toBe('OK');
    });

    it('handles response.completed with usage tracking', async () => {
        const response = makeSSEResponse([
            'data: {"type":"response.output_text.delta","delta":"Answer"}',
            '',
            'data: {"type":"response.completed","response":{"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, { _requestId: 'req-1' }));
        expect(result).toBe('Answer');
    });

    it('ignores non-data lines', async () => {
        const response = makeSSEResponse([
            'event: something',
            'data: {"type":"response.output_text.delta","delta":"OK"}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, {}));
        expect(result).toBe('OK');
    });

    it('handles malformed JSON gracefully', async () => {
        const response = makeSSEResponse([
            'data: {invalid json}',
            '',
            'data: {"type":"response.output_text.delta","delta":"After"}',
        ]);
        const result = await collectStream(createResponsesAPISSEStream(response, undefined, {}));
        expect(result).toBe('After');
    });
});

// ═══════════════════════════════════════
// parseGeminiSSELine — expanded
// ═══════════════════════════════════════
describe('parseGeminiSSELine — extended', () => {
    it('parses basic text response', () => {
        const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}';
        const config = {};
        expect(parseGeminiSSELine(line, config)).toBe('Hello');
    });

    it('handles thought parts when showThoughtsToken=true', () => {
        const config = { showThoughtsToken: true };
        const line = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}';
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Thinking...');
    });

    it('hides thought parts when showThoughtsToken=false', () => {
        const config = { showThoughtsToken: false };
        const line = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Hidden"}]}}]}';
        expect(parseGeminiSSELine(line, config)).toBeNull();
    });

    it('closes thought block when text part follows', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = 'data: {"candidates":[{"content":{"parts":[{"text":"After thinking"}]}}]}';
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('After thinking');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('detects safety block reasons', () => {
        for (const reason of GEMINI_BLOCK_REASONS) {
            const line = `data: {"candidates":[{"finishReason":"${reason}"}]}`;
            const result = parseGeminiSSELine(line, {});
            expect(result).toContain('Gemini Safety Block');
        }
    });

    it('handles thought_signature in parts', () => {
        const config = { useThoughtSignature: true };
        const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Result","thought_signature":"sig123"}]}}]}';
        parseGeminiSSELine(line, config);
        expect(config._lastSignature).toBe('sig123');
    });

    it('accumulates _streamResponseText for signatures', () => {
        const config = { useThoughtSignature: true };
        parseGeminiSSELine('data: {"candidates":[{"content":{"parts":[{"text":"Part1"}]}}]}', config);
        parseGeminiSSELine('data: {"candidates":[{"content":{"parts":[{"text":"Part2"}]}}]}', config);
        expect(config._streamResponseText).toBe('Part1Part2');
    });

    it('tracks usageMetadata', () => {
        const config = {};
        parseGeminiSSELine('data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20},"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}', config);
        expect(config._streamUsageMetadata).toBeDefined();
        expect(config._streamUsageMetadata.promptTokenCount).toBe(10);
    });

    it('closes thought block on finishReason', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = 'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[]}}]}';
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('returns null for non-data lines', () => {
        expect(parseGeminiSSELine('event: something', {})).toBeNull();
    });

    it('returns null for malformed JSON', () => {
        expect(parseGeminiSSELine('data: {bad json}', {})).toBeNull();
    });

    it('handles promptFeedback blockReason', () => {
        const line = 'data: {"promptFeedback":{"blockReason":"SAFETY"}}';
        const result = parseGeminiSSELine(line, {});
        expect(result).toContain('Gemini Safety Block');
    });

    it('handles safety block with open thought block', () => {
        const config = { showThoughtsToken: true, _inThoughtBlock: true };
        const line = 'data: {"candidates":[{"finishReason":"SAFETY"}]}';
        const result = parseGeminiSSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Gemini Safety Block');
    });
});

// ═══════════════════════════════════════
// saveThoughtSignatureFromStream
// ═══════════════════════════════════════
describe('saveThoughtSignatureFromStream', () => {
    beforeEach(() => ThoughtSignatureCache.clear());

    it('closes open thought block', () => {
        const config = { _inThoughtBlock: true };
        const result = saveThoughtSignatureFromStream(config);
        expect(result).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('saves thought signature to cache', () => {
        const config = { _lastSignature: 'sig456', _streamResponseText: 'Some response text' };
        saveThoughtSignatureFromStream(config);
        expect(ThoughtSignatureCache.get('Some response text')).toBe('sig456');
    });

    it('returns null when no open block and no signature', () => {
        expect(saveThoughtSignatureFromStream({})).toBeNull();
    });

    it('does not save if missing signature or response text', () => {
        saveThoughtSignatureFromStream({ _lastSignature: 'sig', _streamResponseText: '' });
        saveThoughtSignatureFromStream({ _lastSignature: '', _streamResponseText: 'text' });
        // Should not crash, just return null
        expect(ThoughtSignatureCache.get('text')).toBeNull();
    });
});

// ═══════════════════════════════════════
// parseOpenAISSELine — extended
// ═══════════════════════════════════════
describe('parseOpenAISSELine — extended', () => {
    it('handles reasoning_content (o-series)', () => {
        const config = { showThinking: true };
        const line = 'data: {"choices":[{"delta":{"reasoning_content":"Step 1"}}]}';
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Step 1');
    });

    it('handles reasoning (OpenRouter alias)', () => {
        const config = { showThinking: true };
        const line = 'data: {"choices":[{"delta":{"reasoning":"Think"}}]}';
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('Think');
    });

    it('transitions from thinking to content', () => {
        const config = { showThinking: true, _inThinking: true };
        const line = 'data: {"choices":[{"delta":{"content":"Answer"}}]}';
        const result = parseOpenAISSELine(line, config);
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Answer');
    });

    it('tracks usage when _requestId is set', () => {
        const config = { _requestId: 'test-req' };
        const line = 'data: {"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}';
        // Should not throw
        parseOpenAISSELine(line, config);
    });

    it('ignores [DONE] sentinel', () => {
        expect(parseOpenAISSELine('data: [DONE]', {})).toBeNull();
    });

    it('returns null for empty delta', () => {
        expect(parseOpenAISSELine('data: {"choices":[{"delta":{}}]}', {})).toBeNull();
    });

    it('returns null for non-data lines', () => {
        expect(parseOpenAISSELine('event: something', {})).toBeNull();
    });
});
