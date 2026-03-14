import { describe, it, expect } from 'vitest';
import {
    COPILOT_CHAT_VERSION,
    VSCODE_VERSION,
    GITHUB_API_VERSION,
    GITHUB_TOKEN_API_VERSION,
    COPILOT_TOKEN_USER_AGENT,
    normalizeCopilotNodelessMode,
    shouldUseNodelessTokenHeaders,
    shouldUseLegacyCopilotRequestHeaders,
    buildCopilotTokenExchangeHeaders,
    getCopilotStaticHeaders,
} from '../src/shared/copilot-headers.js';

// ── Constants ──
describe('Copilot header constants', () => {
    it('exports non-empty version strings', () => {
        expect(COPILOT_CHAT_VERSION).toBeTruthy();
        expect(typeof COPILOT_CHAT_VERSION).toBe('string');
        expect(VSCODE_VERSION).toBeTruthy();
        expect(typeof VSCODE_VERSION).toBe('string');
        expect(GITHUB_API_VERSION).toBeTruthy();
        expect(typeof GITHUB_API_VERSION).toBe('string');
        expect(GITHUB_TOKEN_API_VERSION).toBeTruthy();
        expect(typeof GITHUB_TOKEN_API_VERSION).toBe('string');
    });

    it('COPILOT_TOKEN_USER_AGENT includes VSCODE_VERSION', () => {
        expect(COPILOT_TOKEN_USER_AGENT).toContain(VSCODE_VERSION);
    });

    it('User-Agent matches Chrome/Electron pattern', () => {
        expect(COPILOT_TOKEN_USER_AGENT).toMatch(/Chrome\/\d+/);
        expect(COPILOT_TOKEN_USER_AGENT).toMatch(/Electron\/\d+/);
    });
});

// ── normalizeCopilotNodelessMode ──
describe('normalizeCopilotNodelessMode', () => {
    it('returns "off" for null/undefined/empty string', () => {
        expect(normalizeCopilotNodelessMode(null)).toBe('off');
        expect(normalizeCopilotNodelessMode(undefined)).toBe('off');
        expect(normalizeCopilotNodelessMode('')).toBe('off');
    });

    it('returns "off" for invalid/unknown strings', () => {
        expect(normalizeCopilotNodelessMode('invalid')).toBe('off');
        expect(normalizeCopilotNodelessMode('nodeless')).toBe('off');
        expect(normalizeCopilotNodelessMode('nodeless-3')).toBe('off');
        expect(normalizeCopilotNodelessMode('on')).toBe('off');
    });

    it('returns "nodeless-1" for "nodeless-1"', () => {
        expect(normalizeCopilotNodelessMode('nodeless-1')).toBe('nodeless-1');
    });

    it('returns "nodeless-2" for "nodeless-2"', () => {
        expect(normalizeCopilotNodelessMode('nodeless-2')).toBe('nodeless-2');
    });
});

// ── shouldUseNodelessTokenHeaders ──
describe('shouldUseNodelessTokenHeaders', () => {
    it('returns false for "off"', () => {
        expect(shouldUseNodelessTokenHeaders('off')).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(shouldUseNodelessTokenHeaders(null)).toBe(false);
        expect(shouldUseNodelessTokenHeaders(undefined)).toBe(false);
    });

    it('returns true for "nodeless-1"', () => {
        expect(shouldUseNodelessTokenHeaders('nodeless-1')).toBe(true);
    });

    it('returns true for "nodeless-2"', () => {
        expect(shouldUseNodelessTokenHeaders('nodeless-2')).toBe(true);
    });

    it('returns false for invalid modes', () => {
        expect(shouldUseNodelessTokenHeaders('garbage')).toBe(false);
    });
});

// ── shouldUseLegacyCopilotRequestHeaders ──
describe('shouldUseLegacyCopilotRequestHeaders', () => {
    it('returns false for "off", null, undefined', () => {
        expect(shouldUseLegacyCopilotRequestHeaders('off')).toBe(false);
        expect(shouldUseLegacyCopilotRequestHeaders(null)).toBe(false);
        expect(shouldUseLegacyCopilotRequestHeaders(undefined)).toBe(false);
    });

    it('returns false for "nodeless-1"', () => {
        expect(shouldUseLegacyCopilotRequestHeaders('nodeless-1')).toBe(false);
    });

    it('returns true only for "nodeless-2"', () => {
        expect(shouldUseLegacyCopilotRequestHeaders('nodeless-2')).toBe(true);
    });
});

// ── buildCopilotTokenExchangeHeaders ──
describe('buildCopilotTokenExchangeHeaders', () => {
    const token = 'ghu_test_token_12345';

    it('returns full headers for default mode (off)', () => {
        const headers = buildCopilotTokenExchangeHeaders(token);
        expect(headers['Accept']).toBe('application/json');
        expect(headers['Authorization']).toBe(`Bearer ${token}`);
        expect(headers['User-Agent']).toBe(COPILOT_TOKEN_USER_AGENT);
        expect(headers['Editor-Version']).toBe(`vscode/${VSCODE_VERSION}`);
        expect(headers['Editor-Plugin-Version']).toBe(`copilot-chat/${COPILOT_CHAT_VERSION}`);
        expect(headers['X-GitHub-Api-Version']).toBe(GITHUB_TOKEN_API_VERSION);
    });

    it('returns full headers for explicit "off" mode', () => {
        const headers = buildCopilotTokenExchangeHeaders(token, 'off');
        expect(headers['Editor-Version']).toBeTruthy();
        expect(headers['Editor-Plugin-Version']).toBeTruthy();
        expect(headers['X-GitHub-Api-Version']).toBeTruthy();
    });

    it('returns minimal headers for "nodeless-1"', () => {
        const headers = buildCopilotTokenExchangeHeaders(token, 'nodeless-1');
        expect(headers['Accept']).toBe('application/json');
        expect(headers['Authorization']).toBe(`Bearer ${token}`);
        expect(headers['User-Agent']).toBe(COPILOT_TOKEN_USER_AGENT);
        // Should NOT include these in nodeless mode
        expect(headers['Editor-Version']).toBeUndefined();
        expect(headers['Editor-Plugin-Version']).toBeUndefined();
        expect(headers['X-GitHub-Api-Version']).toBeUndefined();
    });

    it('returns minimal headers for "nodeless-2"', () => {
        const headers = buildCopilotTokenExchangeHeaders(token, 'nodeless-2');
        expect(headers['Accept']).toBe('application/json');
        expect(headers['Authorization']).toBe(`Bearer ${token}`);
        // Should NOT include additional editor headers
        expect(headers['Editor-Version']).toBeUndefined();
    });

    it('uses provided token in Authorization header', () => {
        const h1 = buildCopilotTokenExchangeHeaders('abc');
        const h2 = buildCopilotTokenExchangeHeaders('xyz');
        expect(h1['Authorization']).toBe('Bearer abc');
        expect(h2['Authorization']).toBe('Bearer xyz');
    });
});

// ── getCopilotStaticHeaders ──
describe('getCopilotStaticHeaders', () => {
    it('returns full headers for default mode (off)', () => {
        const headers = getCopilotStaticHeaders();
        expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
        expect(headers['Editor-Plugin-Version']).toBe(`copilot-chat/${COPILOT_CHAT_VERSION}`);
        expect(headers['Editor-Version']).toBe(`vscode/${VSCODE_VERSION}`);
        expect(headers['User-Agent']).toContain('GitHubCopilotChat');
        expect(headers['X-Github-Api-Version']).toBe(GITHUB_API_VERSION);
        expect(headers['X-Initiator']).toBe('user');
        expect(headers['X-Interaction-Type']).toBe('conversation-panel');
        expect(headers['X-Vscode-User-Agent-Library-Version']).toBe('electron-fetch');
    });

    it('returns full headers for explicit null mode', () => {
        const headers = getCopilotStaticHeaders(null);
        expect(Object.keys(headers).length).toBeGreaterThan(3);
        expect(headers['X-Github-Api-Version']).toBeTruthy();
    });

    it('has exactly 8 keys in full mode', () => {
        const headers = getCopilotStaticHeaders('off');
        expect(Object.keys(headers)).toHaveLength(8);
    });

    it('returns minimal legacy headers for "nodeless-2"', () => {
        const headers = getCopilotStaticHeaders('nodeless-2');
        expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
        // Should only have the one integration ID header
        expect(Object.keys(headers)).toHaveLength(1);
        expect(headers['Editor-Version']).toBeUndefined();
        expect(headers['User-Agent']).toBeUndefined();
    });

    it('returns full headers for "nodeless-1" (only affects token headers, not request headers)', () => {
        const headers = getCopilotStaticHeaders('nodeless-1');
        // nodeless-1 does NOT use legacy request headers
        expect(Object.keys(headers).length).toBeGreaterThan(1);
        expect(headers['Editor-Version']).toBeTruthy();
    });
});

// ── Cross-function consistency ──
describe('Cross-function consistency', () => {
    it('nodeless-1 uses minimal token headers but full request headers', () => {
        expect(shouldUseNodelessTokenHeaders('nodeless-1')).toBe(true);
        expect(shouldUseLegacyCopilotRequestHeaders('nodeless-1')).toBe(false);
        const tokenHeaders = buildCopilotTokenExchangeHeaders('tok', 'nodeless-1');
        const staticHeaders = getCopilotStaticHeaders('nodeless-1');
        // Token: minimal (no Editor-Version)
        expect(tokenHeaders['Editor-Version']).toBeUndefined();
        // Request: full (has Editor-Version)
        expect(staticHeaders['Editor-Version']).toBeTruthy();
    });

    it('nodeless-2 uses minimal for both token and request headers', () => {
        expect(shouldUseNodelessTokenHeaders('nodeless-2')).toBe(true);
        expect(shouldUseLegacyCopilotRequestHeaders('nodeless-2')).toBe(true);
        const tokenHeaders = buildCopilotTokenExchangeHeaders('tok', 'nodeless-2');
        const staticHeaders = getCopilotStaticHeaders('nodeless-2');
        expect(tokenHeaders['Editor-Version']).toBeUndefined();
        expect(Object.keys(staticHeaders)).toHaveLength(1);
    });

    it('"off" uses full headers everywhere', () => {
        expect(shouldUseNodelessTokenHeaders('off')).toBe(false);
        expect(shouldUseLegacyCopilotRequestHeaders('off')).toBe(false);
        const tokenHeaders = buildCopilotTokenExchangeHeaders('tok', 'off');
        const staticHeaders = getCopilotStaticHeaders('off');
        expect(tokenHeaders['Editor-Version']).toBeTruthy();
        expect(staticHeaders['Editor-Version']).toBeTruthy();
    });
});
