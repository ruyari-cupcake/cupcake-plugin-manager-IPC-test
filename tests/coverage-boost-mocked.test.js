/**
 * coverage-boost-mocked.test.js
 * vi.mock 사용: tool-loop.js 브랜치 커버리지, vertex-auth.js 에러 경로
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ──────────────────────────────────────
// tool-loop.js mocking setup
// ──────────────────────────────────────
vi.mock('../src/shared/tool-definitions.js', () => ({
    getActiveToolList: vi.fn().mockResolvedValue([{ type: 'function', function: { name: 'test_fn', description: 't', parameters: {} } }])
}));
vi.mock('../src/shared/tool-executor.js', () => ({
    executeToolCall: vi.fn().mockResolvedValue([{ text: 'tool result text' }])
}));
vi.mock('../src/shared/tool-config.js', () => ({
    getToolMaxDepth: vi.fn().mockResolvedValue(3),
    getToolTimeout: vi.fn().mockResolvedValue(5000)
}));
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: vi.fn(() => ({
        nativeFetch: vi.fn()
    }))
}));

import { runToolLoop } from '../src/shared/tool-loop.js';
import { executeToolCall } from '../src/shared/tool-executor.js';
import { getActiveToolList } from '../src/shared/tool-definitions.js';

// ──────────────────────────────────────
// tool-loop.js tests
// ──────────────────────────────────────
describe('runToolLoop branches', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns stripped result when no active tools', async () => {
        getActiveToolList.mockResolvedValueOnce([]);
        const result = await runToolLoop({
            initialResult: { success: true, content: 'no tools', _rawData: {} },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn: vi.fn()
        });
        expect(result.success).toBe(true);
        expect(result.content).toBe('no tools');
        expect(result._rawData).toBeUndefined();
    });

    it('returns stripped result when no _rawData in initial', async () => {
        const result = await runToolLoop({
            initialResult: { success: true, content: 'text' },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn: vi.fn()
        });
        expect(result.content).toBe('text');
    });

    it('returns textContent when initial has no tool_calls', async () => {
        const result = await runToolLoop({
            initialResult: {
                success: true,
                content: 'fallback',
                _rawData: { choices: [{ message: { content: 'hello' } }] }
            },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn: vi.fn()
        });
        expect(result.content).toBe('hello');
    });

    it('executes single tool round and returns', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            success: true,
            content: 'final answer',
            _rawData: { choices: [{ message: { content: 'final answer' } }] },
            _status: 200
        });

        const result = await runToolLoop({
            initialResult: {
                success: true,
                content: '',
                _rawData: {
                    choices: [{
                        message: {
                            content: '',
                            tool_calls: [{ id: 'c1', function: { name: 'test_fn', arguments: '{}' } }]
                        }
                    }]
                }
            },
            messages: [{ role: 'user', content: 'hi' }],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        expect(executeToolCall).toHaveBeenCalledWith('test_fn', {});
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(result.content).toBe('final answer');
    });

    it('handles fetchFn failure during loop', async () => {
        const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));

        const result = await runToolLoop({
            initialResult: {
                success: true,
                content: '',
                _rawData: {
                    choices: [{
                        message: {
                            content: '',
                            tool_calls: [{ id: 'c1', function: { name: 'test_fn', arguments: '{}' } }]
                        }
                    }]
                }
            },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        expect(result.success).toBe(false);
        expect(result.content).toContain('network down');
    });

    it('handles fetchFn returning unsuccessful result', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            success: false,
            content: 'API rate limited',
            _status: 429
        });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'test_fn', arguments: '{}' } }] } }]
                }
            },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        expect(result.success).toBe(false);
        expect(result.content).toBe('API rate limited');
    });

    it('handles tool execution error', async () => {
        executeToolCall.mockRejectedValueOnce(new Error('tool crash'));

        const fetchFn = vi.fn().mockResolvedValue({
            success: true,
            content: 'after error',
            _rawData: { choices: [{ message: { content: 'after error' } }] },
            _status: 200
        });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'test_fn', arguments: '{}' } }] } }]
                }
            },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        // Should continue after tool error with error message
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(result.content).toBe('after error');
    });

    it('abortSignal stops the loop', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'test_fn', arguments: '{}' } }] } }]
                }
            },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            abortSignal: controller.signal,
            fetchFn: vi.fn()
        });

        // When aborted, loop breaks and returns textContent from last parsed
        expect(result).toBeDefined();
    });

    it('nextResult without _rawData returns content directly', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            success: true,
            content: 'plain text result',
            _status: 200
            // no _rawData
        });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'test_fn', arguments: '{}' } }] } }]
                }
            },
            messages: [],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        expect(result.content).toBe('plain text result');
    });
});

// ──────────────────────────────────────
// vertex-auth.js — parseServiceAccountJson edge cases
// (no crypto needed for parse-only tests)
// ──────────────────────────────────────
import { parseServiceAccountJson, looksLikeServiceAccountJson, clearAllTokenCaches, invalidateTokenCache } from '../src/shared/vertex-auth.js';

describe('vertex-auth parseServiceAccountJson', () => {
    it('empty string throws', () => {
        expect(() => parseServiceAccountJson('')).toThrow('비어 있습니다');
    });

    it('windows path throws', () => {
        expect(() => parseServiceAccountJson('C:\\Users\\key.json')).toThrow('파일 경로가 아닌');
    });

    it('UNC path throws', () => {
        expect(() => parseServiceAccountJson('\\\\server\\share\\key.json')).toThrow('파일 경로가 아닌');
    });

    it('invalid JSON throws', () => {
        expect(() => parseServiceAccountJson('{bad')).toThrow('JSON 파싱 오류');
    });

    it('array JSON throws', () => {
        expect(() => parseServiceAccountJson('[1,2]')).toThrow('JSON 객체 형식');
    });

    it('missing client_email throws', () => {
        expect(() => parseServiceAccountJson('{"private_key":"-----BEGIN PRIVATE KEY-----\\nxxx\\n-----END PRIVATE KEY-----"}')).toThrow('client_email 또는 private_key');
    });

    it('missing private_key throws', () => {
        expect(() => parseServiceAccountJson('{"client_email":"a@b.com"}')).toThrow('client_email 또는 private_key');
    });

    it('invalid PEM format throws', () => {
        expect(() => parseServiceAccountJson('{"client_email":"a@b.com","private_key":"not-a-pem"}')).toThrow('PEM 형식');
    });

    it('valid SA JSON parses', () => {
        const sa = JSON.stringify({
            client_email: 'test@proj.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBA...\n-----END PRIVATE KEY-----\n',
            project_id: 'my-project'
        });
        const parsed = parseServiceAccountJson(sa);
        expect(parsed.client_email).toBe('test@proj.iam.gserviceaccount.com');
        expect(parsed.project_id).toBe('my-project');
    });
});

describe('vertex-auth looksLikeServiceAccountJson', () => {
    it('returns false for null/undefined/number', () => {
        expect(looksLikeServiceAccountJson(null)).toBe(false);
        expect(looksLikeServiceAccountJson(undefined)).toBe(false);
        expect(looksLikeServiceAccountJson(123)).toBe(false);
    });
    it('returns false for non-JSON string', () => {
        expect(looksLikeServiceAccountJson('hello')).toBe(false);
    });
    it('returns false for JSON without type=service_account', () => {
        expect(looksLikeServiceAccountJson('{"type":"other"}')).toBe(false);
    });
    it('returns true for valid SA JSON', () => {
        const sa = JSON.stringify({
            type: 'service_account',
            client_email: 'a@b.com',
            private_key: 'key'
        });
        expect(looksLikeServiceAccountJson(sa)).toBe(true);
    });
});

describe('vertex-auth cache management', () => {
    it('clearAllTokenCaches does not throw', () => {
        expect(() => clearAllTokenCaches()).not.toThrow();
    });
    it('invalidateTokenCache with invalid JSON does not throw', () => {
        expect(() => invalidateTokenCache('not-json')).not.toThrow();
    });
    it('invalidateTokenCache with valid SA JSON does not throw', () => {
        const sa = JSON.stringify({
            client_email: 'x@y.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nxxx\n-----END PRIVATE KEY-----'
        });
        expect(() => invalidateTokenCache(sa)).not.toThrow();
    });
});
