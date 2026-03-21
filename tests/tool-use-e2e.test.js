/**
 * @file tool-use-e2e.test.js — End-to-End integration tests for tool-use system
 *
 * Simulates realistic scenarios:
 * - Layer 1: registerMCP → tool discovery → tool execution → result return
 * - Layer 2: full tool-use loop (request → tool_call → execute → re-request → final answer)
 * - Combined: prefetch search + Layer 2 loop
 * - Edge cases: abort mid-loop, timeout, all tools disabled
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ══════════════════════════════════════════════════
// Shared mock setup
// ══════════════════════════════════════════════════
const mockGetArg = vi.fn().mockResolvedValue('');
const mockGetBoolArg = vi.fn().mockResolvedValue(false);
const mockNativeFetch = vi.fn();
const mockRegisterMCP = vi.fn().mockResolvedValue(undefined);
const mockUnregisterMCP = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/shared/helpers.js', () => ({
    safeGetArg: (...a) => mockGetArg(...a),
    safeGetBoolArg: (...a) => mockGetBoolArg(...a),
}));

vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({
        nativeFetch: mockNativeFetch,
        registerMCP: mockRegisterMCP,
        unregisterMCP: mockUnregisterMCP,
        getArgument: vi.fn().mockResolvedValue(''),
    }),
}));

// Re-import all modules (they'll use the mocks above)
const { isToolUseEnabled, isToolEnabled, getToolMaxDepth, getToolTimeout, getWebSearchConfig } = await import('../src/shared/tool-config.js');
const { getActiveToolList, getToolByName, TOOL_DATETIME, TOOL_CALCULATE, TOOL_DICE } = await import('../src/shared/tool-definitions.js');
const { getCurrentDatetime, calculate, rollDice, executeToolCall } = await import('../src/shared/tool-executor.js');
const { parseOpenAIToolCalls, parseAnthropicToolCalls, parseGeminiToolCalls, formatToolResult } = await import('../src/shared/tool-parsers.js');
const { registerCpmTools, refreshCpmTools } = await import('../src/shared/tool-mcp-bridge.js');
const { runToolLoop } = await import('../src/shared/tool-loop.js');
const { extractUserQuery, formatSearchBlock, injectPrefetchSearch } = await import('../src/shared/prefetch-search.js');

beforeEach(() => {
    vi.clearAllMocks();
    // Default: tool-use enabled, all tools enabled
    mockGetBoolArg.mockImplementation((key) => {
        if (key === 'cpm_tool_use_enabled') return Promise.resolve(true);
        if (key === 'cpm_tool_datetime') return Promise.resolve(true);
        if (key === 'cpm_tool_calculator') return Promise.resolve(true);
        if (key === 'cpm_tool_dice') return Promise.resolve(true);
        if (key === 'cpm_tool_web_search') return Promise.resolve(true);
        if (key === 'cpm_tool_fetch_url') return Promise.resolve(true);
        if (key === 'cpm_prefetch_search_enabled') return Promise.resolve(false);
        if (key === 'cpm_prefetch_search_snippet_only') return Promise.resolve(false);
        return Promise.resolve(false);
    });
    mockGetArg.mockImplementation((key) => {
        if (key === 'cpm_tool_max_depth') return Promise.resolve('20');
        if (key === 'cpm_tool_timeout') return Promise.resolve('30000');
        if (key === 'cpm_tool_websearch_provider') return Promise.resolve('brave');
        if (key === 'cpm_tool_websearch_key') return Promise.resolve('');
        return Promise.resolve('');
    });
});

// ══════════════════════════════════════════════════
// Integration: Layer 1 — MCP Registration + Tool Execution
// ══════════════════════════════════════════════════
describe('E2E: Layer 1 — MCP Registration Flow', () => {
    it('registers tools → RisuAI can discover and call them', async () => {
        await registerCpmTools('2.0.0');
        expect(mockRegisterMCP).toHaveBeenCalledTimes(1);

        // Simulate RisuAI discovering tools
        const [info, toolListFn, execFn] = mockRegisterMCP.mock.calls[0];
        expect(info.identifier).toBe('plugin:cpm-tools');

        // RisuAI calls toolListFn to get active tools
        const tools = await toolListFn();
        expect(tools.length).toBeGreaterThanOrEqual(5);
        expect(tools.find(t => t.name === 'get_current_datetime')).toBeTruthy();
        expect(tools.find(t => t.name === 'calculate')).toBeTruthy();

        // RisuAI calls execFn to execute a tool
        const result = await execFn('calculate', { expression: '2 + 3 * 4' });
        expect(result).toHaveLength(1);
        const parsed = JSON.parse(result[0].text);
        expect(parsed.result).toBe(14);
    });

    it('refreshCpmTools re-registers after settings change', async () => {
        await refreshCpmTools('2.0.1');
        expect(mockUnregisterMCP).toHaveBeenCalledWith('plugin:cpm-tools');
        expect(mockRegisterMCP).toHaveBeenCalledTimes(1);
    });

    it('does not register if tool-use is disabled', async () => {
        mockGetBoolArg.mockImplementation((key) => {
            if (key === 'cpm_tool_use_enabled') return Promise.resolve(false);
            return Promise.resolve(false);
        });
        await registerCpmTools('2.0.0');
        expect(mockRegisterMCP).not.toHaveBeenCalled();
    });
});

// ══════════════════════════════════════════════════
// Integration: Layer 2 — Full Tool-Use Loop
// ══════════════════════════════════════════════════
describe('E2E: Layer 2 — OpenAI format tool loop', () => {
    it('single round: calculate → answer', async () => {
        const fetchFn = vi.fn()
            // Round 1 re-request: final answer (no tool calls)
            .mockResolvedValueOnce({
                success: true,
                content: 'The answer is 14.',
                _rawData: {
                    choices: [{
                        message: { content: 'The answer is 14.', role: 'assistant' }
                    }]
                },
                _status: 200
            });

        const result = await runToolLoop({
            initialResult: {
                success: true,
                content: '',
                _rawData: {
                    choices: [{
                        message: {
                            content: 'Let me calculate.',
                            role: 'assistant',
                            tool_calls: [{
                                id: 'call_abc123',
                                function: { name: 'calculate', arguments: '{"expression":"2+3*4"}' }
                            }]
                        }
                    }]
                },
                _status: 200
            },
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'What is 2+3*4?' }
            ],
            config: { format: 'openai' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        expect(result.success).toBe(true);
        expect(result.content).toBe('The answer is 14.');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});

describe('E2E: Layer 2 — Anthropic format tool loop', () => {
    it('single round: datetime tool_use → answer', async () => {
        const fetchFn = vi.fn().mockResolvedValueOnce({
            success: true,
            content: 'The current time is ...',
            _rawData: {
                content: [{ type: 'text', text: 'The current time is 2026-03-21 12:00.' }]
            },
            _status: 200
        });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    content: [
                        { type: 'text', text: 'Let me check.' },
                        { type: 'tool_use', id: 'toolu_xyz', name: 'get_current_datetime', input: {} }
                    ]
                },
                _status: 200
            },
            messages: [{ role: 'user', content: 'What time is it?' }],
            config: { format: 'anthropic' },
            temp: 0.7,
            maxTokens: 1000,
            args: {},
            fetchFn
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('2026');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});

describe('E2E: Layer 2 — Gemini format tool loop', () => {
    it('single round: dice functionCall → answer', async () => {
        const fetchFn = vi.fn().mockResolvedValueOnce({
            success: true, content: 'You rolled 4.',
            _rawData: {
                candidates: [{ content: { parts: [{ text: 'You rolled 4.' }] } }]
            },
            _status: 200
        });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    candidates: [{
                        content: { parts: [
                            { functionCall: { name: 'roll_dice', args: { notation: '1d6' } } }
                        ] }
                    }]
                },
                _status: 200
            },
            messages: [{ role: 'user', content: 'Roll a die' }],
            config: { format: 'google' },
            temp: 0.7, maxTokens: 1000, args: {},
            fetchFn
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('rolled');
    });
});

// ══════════════════════════════════════════════════
// Integration: Multi-round tool loop
// ══════════════════════════════════════════════════
describe('E2E: Layer 2 — Multi-round loop', () => {
    it('two rounds of tool calls then final answer', async () => {
        const fetchFn = vi.fn()
            // Round 1 reply: another tool call
            .mockResolvedValueOnce({
                success: true, content: '',
                _rawData: {
                    choices: [{
                        message: {
                            content: '', role: 'assistant',
                            tool_calls: [{ id: 'call_2', function: { name: 'get_current_datetime', arguments: '{}' } }]
                        }
                    }]
                },
                _status: 200
            })
            // Round 2 reply: final answer
            .mockResolvedValueOnce({
                success: true, content: 'The sum is 10 and today is 2026-03-21.',
                _rawData: {
                    choices: [{ message: { content: 'The sum is 10 and today is 2026-03-21.', role: 'assistant' } }]
                },
                _status: 200
            });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    choices: [{
                        message: {
                            content: '', role: 'assistant',
                            tool_calls: [{ id: 'call_1', function: { name: 'calculate', arguments: '{"expression":"5+5"}' } }]
                        }
                    }]
                },
                _status: 200
            },
            messages: [{ role: 'user', content: 'Calculate 5+5 and tell me today\'s date.' }],
            config: { format: 'openai' },
            temp: 0.7, maxTokens: 1000, args: {},
            fetchFn
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('10');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
});

// ══════════════════════════════════════════════════
// Integration: Abort mid-loop
// ══════════════════════════════════════════════════
describe('E2E: Abort signal during tool loop', () => {
    it('respects abort signal between rounds', async () => {
        const ac = new AbortController();

        const fetchFn = vi.fn().mockImplementation(async () => {
            ac.abort(); // abort after first re-request
            return {
                success: true, content: '',
                _rawData: {
                    choices: [{
                        message: {
                            content: '', tool_calls: [{ id: 'c2', function: { name: 'calculate', arguments: '{}' } }]
                        }
                    }]
                },
                _status: 200
            };
        });

        const result = await runToolLoop({
            initialResult: {
                success: true, content: '',
                _rawData: {
                    choices: [{
                        message: {
                            tool_calls: [{ id: 'c1', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }]
                        }
                    }]
                },
                _status: 200
            },
            messages: [{ role: 'user', content: 'test' }],
            config: { format: 'openai' },
            temp: 0.7, maxTokens: 1000, args: {},
            abortSignal: ac.signal,
            fetchFn
        });

        // Should stop due to abort
        expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    });
});

// ══════════════════════════════════════════════════
// Integration: Prefetch Search + Layer 2
// ══════════════════════════════════════════════════
describe('E2E: Prefetch Search injection', () => {
    it('injects search results before tool-use loop', async () => {
        // Enable prefetch
        mockGetBoolArg.mockImplementation((key) => {
            if (key === 'cpm_prefetch_search_enabled') return Promise.resolve(true);
            if (key === 'cpm_tool_use_enabled') return Promise.resolve(true);
            if (key === 'cpm_prefetch_search_snippet_only') return Promise.resolve(false);
            return Promise.resolve(true);
        });
        mockGetArg.mockImplementation((key) => {
            if (key === 'cpm_tool_websearch_provider') return Promise.resolve('brave');
            if (key === 'cpm_tool_websearch_key') return Promise.resolve('test-key');
            if (key === 'cpm_prefetch_search_keywords') return Promise.resolve('');
            if (key === 'cpm_prefetch_search_position') return Promise.resolve('after');
            if (key === 'cpm_prefetch_search_max_results') return Promise.resolve('3');
            if (key === 'cpm_prefetch_search_snippet_only') return Promise.resolve('false');
            return Promise.resolve('');
        });

        mockNativeFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                web: { results: [
                    { title: 'Cat Facts', url: 'https://catfacts.com', description: 'Cats are great pets.' }
                ] }
            })
        });

        const messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Tell me about cats' }
        ];

        const { messages: enrichedMessages, searched } = await injectPrefetchSearch(messages);

        expect(searched).toBe(true);
        expect(enrichedMessages[0].content).toContain('[Web Search Results');
        expect(enrichedMessages[0].content).toContain('Cat Facts');
        expect(enrichedMessages[0].content).toContain('You are a helpful assistant.');
    });
});

// ══════════════════════════════════════════════════
// Integration: All tools disabled → loop returns immediately
// ══════════════════════════════════════════════════
describe('E2E: All tools disabled', () => {
    it('skips tool loop when no active tools', async () => {
        mockGetBoolArg.mockImplementation((key) => {
            if (key === 'cpm_tool_use_enabled') return Promise.resolve(true);
            // All individual tool toggles off
            if (key.startsWith('cpm_tool_')) return Promise.resolve(false);
            return Promise.resolve(false);
        });

        const fetchFn = vi.fn();

        const result = await runToolLoop({
            initialResult: { success: true, content: 'Hello!', _rawData: {}, _status: 200 },
            messages: [{ role: 'user', content: 'Hi' }],
            config: { format: 'openai' },
            temp: 0.7, maxTokens: 1000, args: {},
            fetchFn
        });

        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello!');
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

// ══════════════════════════════════════════════════
// Integration: Cross-format tool result formatting
// ══════════════════════════════════════════════════
describe('E2E: Tool result round-trip', () => {
    it('executeToolCall → parse result → formatToolResult (OpenAI)', async () => {
        const result = await executeToolCall('calculate', { expression: '100 / 4' });
        expect(result[0].type).toBe('text');
        const parsed = JSON.parse(result[0].text);
        expect(parsed.result).toBe(25);

        // Format as OpenAI tool result
        const formatted = formatToolResult({ id: 'c1', name: 'calculate' }, result[0].text, 'openai');
        expect(formatted.role).toBe('tool');
        expect(formatted.tool_call_id).toBe('c1');
        expect(formatted.content).toContain('25');
    });

    it('executeToolCall → parse result → formatToolResult (Anthropic)', async () => {
        const result = await executeToolCall('get_current_datetime', {});
        const formatted = formatToolResult({ id: 'toolu_1', name: 'get_current_datetime' }, result[0].text, 'anthropic');
        expect(formatted.role).toBe('user');
        expect(formatted.content[0].type).toBe('tool_result');
        expect(formatted.content[0].tool_use_id).toBe('toolu_1');
    });

    it('executeToolCall → parse result → formatToolResult (Gemini)', async () => {
        const result = await executeToolCall('roll_dice', { notation: '2d6' });
        const formatted = formatToolResult({ id: 'g1', name: 'roll_dice' }, result[0].text, 'google');
        expect(formatted.role).toBe('function');
        expect(formatted.parts[0].functionResponse.name).toBe('roll_dice');
    });
});
