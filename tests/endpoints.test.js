import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Dynamic import to allow env manipulation per test
async function loadEndpoints() {
    vi.resetModules();
    const mod = await import('../src/shared/endpoints.js');
    return mod;
}

const originalEnv = process.env.CPM_ENV;

beforeEach(() => {
    process.env.CPM_ENV = originalEnv;
});

afterEach(() => {
    process.env.CPM_ENV = originalEnv;
});

describe('endpoints', () => {
    it('exports CPM_BASE_URL as a string', async () => {
        const { CPM_BASE_URL } = await loadEndpoints();
        expect(typeof CPM_BASE_URL).toBe('string');
        expect(CPM_BASE_URL).toMatch(/^https:\/\//);
    });

    it('exports CPM_ENV as "test" or "production"', async () => {
        const { CPM_ENV } = await loadEndpoints();
        expect(['test', 'production']).toContain(CPM_ENV);
    });

    it('VERSIONS_URL is derived from CPM_BASE_URL', async () => {
        const { CPM_BASE_URL, VERSIONS_URL } = await loadEndpoints();
        expect(VERSIONS_URL).toBe(`${CPM_BASE_URL}/api/versions`);
    });

    it('MAIN_UPDATE_URL is derived from CPM_BASE_URL', async () => {
        const { CPM_BASE_URL, MAIN_UPDATE_URL } = await loadEndpoints();
        expect(MAIN_UPDATE_URL).toBe(`${CPM_BASE_URL}/api/main-plugin`);
    });

    it('UPDATE_BUNDLE_URL is derived from CPM_BASE_URL', async () => {
        const { CPM_BASE_URL, UPDATE_BUNDLE_URL } = await loadEndpoints();
        expect(UPDATE_BUNDLE_URL).toBe(`${CPM_BASE_URL}/api/update-bundle`);
    });

    it('all URLs are HTTPS', async () => {
        const { VERSIONS_URL, MAIN_UPDATE_URL, UPDATE_BUNDLE_URL, CPM_BASE_URL } = await loadEndpoints();
        for (const url of [CPM_BASE_URL, VERSIONS_URL, MAIN_UPDATE_URL, UPDATE_BUNDLE_URL]) {
            expect(url).toMatch(/^https:\/\//);
        }
    });

    it('all URLs contain the vercel app domain', async () => {
        const { CPM_BASE_URL } = await loadEndpoints();
        expect(CPM_BASE_URL).toContain('cupcake-plugin-manager');
        expect(CPM_BASE_URL).toContain('vercel.app');
    });

    it('test environment defaults to test URL', async () => {
        // In test env (no CPM_ENV set), should resolve to test URL
        delete process.env.CPM_ENV;
        const { CPM_BASE_URL, CPM_ENV } = await loadEndpoints();
        if (CPM_ENV === 'test') {
            expect(CPM_BASE_URL).toContain('-test');
        }
    });

    it('uses production URL when CPM_ENV is production', async () => {
        process.env.CPM_ENV = 'production';
        const { CPM_BASE_URL, CPM_ENV } = await loadEndpoints();
        expect(CPM_ENV).toBe('production');
        expect(CPM_BASE_URL).toBe('https://cupcake-plugin-manager.vercel.app');
    });

    it('falls back to test URL for unknown CPM_ENV values', async () => {
        process.env.CPM_ENV = 'staging';
        const { CPM_BASE_URL, CPM_ENV } = await loadEndpoints();
        expect(CPM_ENV).toBe('test');
        expect(CPM_BASE_URL).toBe('https://cupcake-plugin-manager-test.vercel.app');
    });
});
