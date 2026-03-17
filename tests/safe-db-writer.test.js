// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { validateDbPatch, safeSetDatabaseLite } from '../src/shared/safe-db-writer.js';

// ══════════════════════════════════════════════════════════════
// validateDbPatch
// ══════════════════════════════════════════════════════════════

describe('validateDbPatch', () => {
    it('rejects null / non-object', () => {
        expect(validateDbPatch(null).ok).toBe(false);
        expect(validateDbPatch(undefined).ok).toBe(false);
        expect(validateDbPatch('string').ok).toBe(false);
        expect(validateDbPatch(42).ok).toBe(false);
        expect(validateDbPatch([]).ok).toBe(false);
    });

    it('rejects empty object', () => {
        const r = validateDbPatch({});
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/no keys/);
    });

    // ── Blocked keys (XSS vectors) ──

    it('blocks guiHTML', () => {
        const r = validateDbPatch({ guiHTML: '<script>alert(1)</script>' });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/guiHTML.*blocked/);
    });

    it('blocks customCSS', () => {
        const r = validateDbPatch({ customCSS: 'body { display: none }' });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/customCSS.*blocked/);
    });

    it('blocks characters', () => {
        const r = validateDbPatch({ characters: [] });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/characters.*blocked/);
    });

    // ── Disallowed keys ──

    it('rejects unknown keys', () => {
        const r = validateDbPatch({ randomKey: 123 });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/not in the allowed list/);
    });

    // ── plugins validation ──

    it('rejects non-array plugins', () => {
        const r = validateDbPatch({ plugins: 'not-an-array' });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/must be an array/);
    });

    it('rejects empty plugins array', () => {
        const r = validateDbPatch({ plugins: [] });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/empty.*delete all/);
    });

    it('rejects plugin missing required fields', () => {
        const r = validateDbPatch({
            plugins: [{ name: 'test', version: '3.0' }]  // missing script
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/script.*missing/);
    });

    it('rejects plugin with wrong version', () => {
        const r = validateDbPatch({
            plugins: [{ name: 'test', script: 'code', version: '2.0' }]
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/version.*expected.*3\.0/);
    });

    it('rejects plugin name exceeding 200 chars', () => {
        const r = validateDbPatch({
            plugins: [{ name: 'x'.repeat(201), script: 'code', version: '3.0' }]
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/exceeds 200/);
    });

    it('rejects non-https updateURL', () => {
        const r = validateDbPatch({
            plugins: [{
                name: 'test', script: 'code', version: '3.0',
                updateURL: 'http://evil.com/plugin.js'
            }]
        });
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/only https/);
    });

    it('accepts valid plugins array', () => {
        const r = validateDbPatch({
            plugins: [
                { name: 'PluginA', script: '//@name PluginA\nconsole.log("hi")', version: '3.0' },
                { name: 'PluginB', script: 'code', version: '3.0', updateURL: 'https://example.com/p.js' },
            ]
        });
        expect(r.ok).toBe(true);
        expect(r.errors).toHaveLength(0);
    });

    it('accepts plugin with empty updateURL', () => {
        const r = validateDbPatch({
            plugins: [{ name: 'Test', script: 'code', version: '3.0', updateURL: '' }]
        });
        expect(r.ok).toBe(true);
    });

    it('reports multiple errors at once', () => {
        const r = validateDbPatch({
            guiHTML: '<evil>',
            customCSS: 'body{}',
            plugins: [{ name: '', script: '', version: '1.0' }]
        });
        expect(r.ok).toBe(false);
        expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });
});

// ══════════════════════════════════════════════════════════════
// safeSetDatabaseLite
// ══════════════════════════════════════════════════════════════

describe('safeSetDatabaseLite', () => {
    /** @returns {any} */
    function mockRisu() {
        return { setDatabaseLite: vi.fn(async () => {}) };
    }

    it('calls setDatabaseLite when validation passes', async () => {
        const risu = mockRisu();
        const patch = { plugins: [{ name: 'P', script: 'c', version: '3.0' }] };
        const result = await safeSetDatabaseLite(risu, patch);
        expect(result.ok).toBe(true);
        expect(risu.setDatabaseLite).toHaveBeenCalledWith(patch);
    });

    it('does NOT call setDatabaseLite when validation fails', async () => {
        const risu = mockRisu();
        const result = await safeSetDatabaseLite(risu, { guiHTML: '<bad>' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/guiHTML/);
        expect(risu.setDatabaseLite).not.toHaveBeenCalled();
    });

    it('returns error when setDatabaseLite throws', async () => {
        const risu = { setDatabaseLite: vi.fn(async () => { throw new Error('disk full'); }) };
        const patch = { plugins: [{ name: 'P', script: 'c', version: '3.0' }] };
        const result = await safeSetDatabaseLite(risu, patch);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/disk full/);
    });

    it('blocks XSS attack via guiHTML', async () => {
        const risu = mockRisu();
        const result = await safeSetDatabaseLite(risu, { guiHTML: '<script>document.cookie</script>' });
        expect(result.ok).toBe(false);
        expect(risu.setDatabaseLite).not.toHaveBeenCalled();
    });

    it('blocks characters manipulation', async () => {
        const risu = mockRisu();
        const result = await safeSetDatabaseLite(risu, { characters: [{ name: 'hijacked' }] });
        expect(result.ok).toBe(false);
        expect(risu.setDatabaseLite).not.toHaveBeenCalled();
    });

    it('blocks http updateURL in plugin', async () => {
        const risu = mockRisu();
        const result = await safeSetDatabaseLite(risu, {
            plugins: [{ name: 'Evil', script: 'c', version: '3.0', updateURL: 'http://evil.com/p.js' }]
        });
        expect(result.ok).toBe(false);
        expect(risu.setDatabaseLite).not.toHaveBeenCalled();
    });
});
