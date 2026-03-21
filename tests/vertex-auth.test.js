/**
 * Tests for src/shared/vertex-auth.js
 * Covers: parseServiceAccountJson, looksLikeServiceAccountJson,
 *         getVertexBearerToken, invalidateTokenCache, clearAllTokenCaches
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ipc-protocol before importing
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({
        nativeFetch: vi.fn(),
    }),
}));

const { getRisu } = await import('../src/shared/ipc-protocol.js');

const {
    parseServiceAccountJson,
    looksLikeServiceAccountJson,
    getVertexBearerToken,
    invalidateTokenCache,
    clearAllTokenCaches
} = await import('../src/shared/vertex-auth.js');

// Valid SA JSON for testing
const VALID_SA = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'test@test-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n'
});

describe('parseServiceAccountJson', () => {
    it('parses valid SA JSON', () => {
        const result = parseServiceAccountJson(VALID_SA);
        expect(result.client_email).toBe('test@test-project.iam.gserviceaccount.com');
        expect(result.project_id).toBe('test-project');
        expect(result.private_key).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('throws on empty string', () => {
        expect(() => parseServiceAccountJson('')).toThrow('비어 있습니다');
    });

    it('throws on null/undefined', () => {
        expect(() => parseServiceAccountJson(null)).toThrow('비어 있습니다');
        expect(() => parseServiceAccountJson(undefined)).toThrow('비어 있습니다');
    });

    it('throws on Windows file path', () => {
        expect(() => parseServiceAccountJson('C:\\Users\\key.json')).toThrow('파일 경로가 아닌');
    });

    it('throws on UNC path', () => {
        expect(() => parseServiceAccountJson('\\\\server\\share\\key.json')).toThrow('파일 경로가 아닌');
    });

    it('throws on invalid JSON', () => {
        expect(() => parseServiceAccountJson('not-json')).toThrow('JSON 파싱 오류');
    });

    it('throws on JSON array', () => {
        expect(() => parseServiceAccountJson('[1,2,3]')).toThrow('JSON 객체 형식');
    });

    it('throws on missing client_email', () => {
        const noEmail = JSON.stringify({ private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----' });
        expect(() => parseServiceAccountJson(noEmail)).toThrow('client_email 또는 private_key');
    });

    it('throws on missing private_key', () => {
        const noKey = JSON.stringify({ client_email: 'a@b.com' });
        expect(() => parseServiceAccountJson(noKey)).toThrow('client_email 또는 private_key');
    });

    it('throws on invalid PEM format', () => {
        const badPem = JSON.stringify({ client_email: 'a@b.com', private_key: 'not-a-pem-key' });
        expect(() => parseServiceAccountJson(badPem)).toThrow('PEM 형식');
    });

    it('handles Bad Unicode escape error hint', () => {
        // Simulate by passing a string that causes a JSON parse error with "Bad Unicode escape"
        // We can test this by checking the error path
        const badJson = '{"key": "\\u00zz"}';
        expect(() => parseServiceAccountJson(badJson)).toThrow('JSON 파싱 오류');
    });

    it('trims whitespace', () => {
        const result = parseServiceAccountJson('  ' + VALID_SA + '  ');
        expect(result.client_email).toBe('test@test-project.iam.gserviceaccount.com');
    });
});

describe('looksLikeServiceAccountJson', () => {
    it('returns true for valid SA JSON', () => {
        expect(looksLikeServiceAccountJson(VALID_SA)).toBe(true);
    });

    it('returns false for null', () => {
        expect(looksLikeServiceAccountJson(null)).toBe(false);
    });

    it('returns false for number', () => {
        expect(looksLikeServiceAccountJson(123)).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(looksLikeServiceAccountJson('')).toBe(false);
    });

    it('returns false for non-JSON string', () => {
        expect(looksLikeServiceAccountJson('hello')).toBe(false);
    });

    it('returns false for JSON without type field', () => {
        const noType = JSON.stringify({ client_email: 'a@b.com', private_key: 'k' });
        expect(looksLikeServiceAccountJson(noType)).toBe(false);
    });

    it('returns false for wrong type', () => {
        const wrongType = JSON.stringify({ type: 'user', client_email: 'a@b.com', private_key: 'k' });
        expect(looksLikeServiceAccountJson(wrongType)).toBe(false);
    });

    it('returns false for string not starting with {', () => {
        expect(looksLikeServiceAccountJson('["array"]')).toBe(false);
    });
});

describe('getVertexBearerToken', () => {
    beforeEach(() => {
        clearAllTokenCaches();
    });

    it('throws on invalid SA JSON', async () => {
        await expect(getVertexBearerToken('')).rejects.toThrow('비어 있습니다');
    });

    it('throws on missing credentials', async () => {
        await expect(getVertexBearerToken('{"foo":"bar"}')).rejects.toThrow('client_email 또는 private_key');
    });
});

describe('invalidateTokenCache', () => {
    it('does not throw on valid SA JSON', () => {
        expect(() => invalidateTokenCache(VALID_SA)).not.toThrow();
    });

    it('does not throw on invalid SA JSON', () => {
        expect(() => invalidateTokenCache('invalid')).not.toThrow();
    });

    it('does not throw on empty string', () => {
        expect(() => invalidateTokenCache('')).not.toThrow();
    });
});

describe('clearAllTokenCaches', () => {
    it('does not throw when empty', () => {
        expect(() => clearAllTokenCaches()).not.toThrow();
    });

    it('clears after previous operations', () => {
        // Just ensure no error
        clearAllTokenCaches();
        clearAllTokenCaches();
    });
});
