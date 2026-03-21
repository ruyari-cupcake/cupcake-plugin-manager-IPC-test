/**
 * @file tool-mcp-bridge.test.js — Tests for Layer 1 MCP registration
 * Covers: registerCpmTools, refreshCpmTools
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ──
const mockIsToolUseEnabled = vi.fn().mockResolvedValue(true);
const mockGetActiveToolList = vi.fn().mockResolvedValue([{ name: 'calculate' }]);
const mockExecuteToolCall = vi.fn().mockResolvedValue([{ type: 'text', text: '42' }]);
const mockRegisterMCP = vi.fn().mockResolvedValue(undefined);
const mockUnregisterMCP = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/shared/tool-config.js', () => ({
    isToolUseEnabled: (...a) => mockIsToolUseEnabled(...a),
}));
vi.mock('../src/shared/tool-definitions.js', () => ({
    getActiveToolList: (...a) => mockGetActiveToolList(...a),
}));
vi.mock('../src/shared/tool-executor.js', () => ({
    executeToolCall: (...a) => mockExecuteToolCall(...a),
}));
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({
        registerMCP: mockRegisterMCP,
        unregisterMCP: mockUnregisterMCP,
    }),
}));

const { registerCpmTools, refreshCpmTools } = await import('../src/shared/tool-mcp-bridge.js');

beforeEach(() => vi.clearAllMocks());

// ══════════════════════════════════════════════════
// registerCpmTools
// ══════════════════════════════════════════════════
describe('registerCpmTools', () => {
    it('registers MCP tools when tool-use is enabled', async () => {
        mockIsToolUseEnabled.mockResolvedValue(true);
        await registerCpmTools('2.0.0');
        expect(mockRegisterMCP).toHaveBeenCalledTimes(1);
        const [info, toolsFn, execFn] = mockRegisterMCP.mock.calls[0];
        expect(info.identifier).toBe('plugin:cpm-tools');
        expect(info.name).toContain('Cupcake');
        expect(info.version).toBe('2.0.0');
        // toolsFn should be getActiveToolList
        expect(typeof toolsFn).toBe('function');
        // execFn should call executeToolCall
        expect(typeof execFn).toBe('function');
    });

    it('passes default version when none provided', async () => {
        mockIsToolUseEnabled.mockResolvedValue(true);
        await registerCpmTools();
        const [info] = mockRegisterMCP.mock.calls[0];
        expect(info.version).toBe('1.0.0');
    });

    it('does NOT register when tool-use is disabled', async () => {
        mockIsToolUseEnabled.mockResolvedValue(false);
        await registerCpmTools('1.0.0');
        expect(mockRegisterMCP).not.toHaveBeenCalled();
    });

    it('catches registerMCP errors gracefully', async () => {
        mockIsToolUseEnabled.mockResolvedValue(true);
        mockRegisterMCP.mockRejectedValue(new Error('MCP not supported'));
        // Should not throw
        await expect(registerCpmTools('1.0.0')).resolves.not.toThrow();
    });

    it('exec callback delegates to executeToolCall', async () => {
        mockIsToolUseEnabled.mockResolvedValue(true);
        await registerCpmTools('1.0.0');
        const execFn = mockRegisterMCP.mock.calls[0][2];
        const result = await execFn('calculate', { expression: '1+1' });
        expect(mockExecuteToolCall).toHaveBeenCalledWith('calculate', { expression: '1+1' });
        expect(result).toEqual([{ type: 'text', text: '42' }]);
    });
});

// ══════════════════════════════════════════════════
// refreshCpmTools
// ══════════════════════════════════════════════════
describe('refreshCpmTools', () => {
    it('unregisters before re-registering', async () => {
        mockIsToolUseEnabled.mockResolvedValue(true);
        await refreshCpmTools('2.1.0');
        expect(mockUnregisterMCP).toHaveBeenCalledWith('plugin:cpm-tools');
        expect(mockRegisterMCP).toHaveBeenCalledTimes(1);
    });

    it('handles unregister failure gracefully', async () => {
        mockUnregisterMCP.mockRejectedValue(new Error('not found'));
        mockIsToolUseEnabled.mockResolvedValue(true);
        await expect(refreshCpmTools('1.0.0')).resolves.not.toThrow();
        expect(mockRegisterMCP).toHaveBeenCalled();
    });

    it('skips re-register when tool-use is disabled', async () => {
        mockIsToolUseEnabled.mockResolvedValue(false);
        await refreshCpmTools('1.0.0');
        expect(mockUnregisterMCP).toHaveBeenCalled();
        expect(mockRegisterMCP).not.toHaveBeenCalled();
    });
});
