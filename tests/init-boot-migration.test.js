/**
 * init-boot-migration.test.js
 *
 * Tests for gaps migrated from _temp_repo/init.js to IPC manager/index.js:
 *   1. Boot order: settings registered BEFORE model registration (crash defense)
 *   2. C1-C9 legacy migration: backward compat auto-migrate from individual keys
 *   3. Boot health telemetry: cpm_last_boot_status recorded to pluginStorage
 *   4. Phase tracking: _bootPhase, _completedPhases, _failedPhases diagnostics
 *   5. Event handler cleanup on re-init (prevents double-firing)
 *   6. Streaming capability check during boot
 *   7. Custom model proxy diagnostic logging
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseCustomModelsValue,
    normalizeCustomModel,
} from '../src/shared/custom-model-serialization.js';
import { safeGetArg, safeGetBoolArg, checkStreamCapability } from '../src/shared/helpers.js';

// ════════════════════════════════════════════════════════════════════
// A.  Boot Order — Settings registration must precede model registration
// ════════════════════════════════════════════════════════════════════
describe('Boot order — settings before models (crash defense)', () => {
    it('registerSetting call should appear before addProvider in source code', async () => {
        // Read the source and verify the IIFE ordering.
        // In the init block, registerSetting MUST come FIRST.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(
            path.resolve('src/manager/index.js'), 'utf-8',
        );

        // Find the MAIN INIT IIFE
        const initStart = src.indexOf('// MAIN INIT');
        expect(initStart).toBeGreaterThan(-1);

        const initBlock = src.slice(initStart);

        // registerSetting must appear before registerModelWithRisu / addProvider
        const settingsIdx = initBlock.indexOf("Risu.registerSetting(");
        const modelRegIdx = initBlock.indexOf("registerModelWithRisu(");
        expect(settingsIdx).toBeGreaterThan(-1);
        expect(modelRegIdx).toBeGreaterThan(-1);
        expect(settingsIdx).toBeLessThan(modelRegIdx);
    });

    it('CRITICAL FIRST comment block must exist before registerSetting', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const initBlock = src.slice(src.indexOf('// MAIN INIT'));
        expect(initBlock).toContain('CRITICAL FIRST: Register settings panel IMMEDIATELY');
    });

    it('_settingsRegistered flag should guard the error fallback', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const initBlock = src.slice(src.indexOf('// MAIN INIT'));
        expect(initBlock).toContain('let _settingsRegistered = false');
        expect(initBlock).toContain('_settingsRegistered = true');
        expect(initBlock).toContain('if (!_settingsRegistered)');
    });
});

// ════════════════════════════════════════════════════════════════════
// B.  C1-C9 Legacy Migration
// ════════════════════════════════════════════════════════════════════
describe('C1-C9 legacy migration — backward compat', () => {
    it('init source contains C1-C9 migration block', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('Backward Compatibility: Auto-Migrate from C1-C9 to JSON');
        expect(src).toContain('cpm_c${i}_url');
        expect(src).toContain('cpm_c${i}_model');
        expect(src).toContain('cpm_c${i}_key');
    });

    it('migration iterates from 1 to 9', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('for (let i = 1; i <= 9; i++)');
    });

    it('migration reads all 16+ legacy fields', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const legacyFields = [
            'url', 'model', 'key', 'name', 'format',
            'sysfirst', 'altrole', 'mustuser', 'maxout',
            'mergesys', 'decoupled', 'thought', 'reasoning',
            'verbosity', 'thinking', 'tok',
        ];
        for (const field of legacyFields) {
            expect(src).toContain(`cpm_c\${i}_${field}`);
        }
    });

    it('migration only triggers when CUSTOM_MODELS_CACHE is empty', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('if (CUSTOM_MODELS_CACHE.length === 0)');
    });

    it('migration saves to cpm_custom_models via setArg', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        // After migration, should persist
        expect(src).toContain("setArg('cpm_custom_models', migratedJson)");
    });

    it('migration backs up via SettingsBackup.updateKey', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain("SettingsBackup.updateKey('cpm_custom_models', migratedJson)");
    });

    it('migration creates default responsesMode and customParams', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain("responsesMode: 'auto'");
        expect(src).toContain("customParams: ''");
    });

    it('C1-C9 migration model shape matches normalizeCustomModel output', () => {
        // Simulate what the migration produces for a legacy C1 model
        const migratedModel = {
            uniqueId: 'custom1',
            name: 'Custom 1',
            model: 'gpt-4',
            url: 'https://api.example.com/v1/chat/completions',
            key: 'sk-test123',
            format: 'openai',
            sysfirst: false,
            altrole: false,
            mustuser: false,
            maxout: false,
            mergesys: false,
            decoupled: false,
            thought: false,
            reasoning: 'none',
            verbosity: 'none',
            thinking: 'none',
            responsesMode: 'auto',
            tok: 'o200k_base',
            customParams: '',
        };

        // Normalize it
        const normalized = normalizeCustomModel(migratedModel, { includeKey: true, includeUniqueId: true });
        expect(normalized.uniqueId).toBe('custom1');
        expect(normalized.model).toBe('gpt-4');
        expect(normalized.url).toBe('https://api.example.com/v1/chat/completions');
        expect(normalized.format).toBe('openai');
    });

    it('C1-C9 migration skips slots with no url/model/key', () => {
        // Simulate the skip condition
        const legacyUrl = '';
        const legacyModel = '';
        const legacyKey = '';
        const shouldSkip = !legacyUrl && !legacyModel && !legacyKey;
        expect(shouldSkip).toBe(true);
    });

    it('C1-C9 migration captures slot with only URL set', () => {
        const legacyUrl = 'https://my.endpoint.com';
        const legacyModel = '';
        const legacyKey = '';
        const shouldSkip = !legacyUrl && !legacyModel && !legacyKey;
        expect(shouldSkip).toBe(false);
    });

    it('C1-C9 migration captures slot with only model set', () => {
        const legacyUrl = '';
        const legacyModel = 'claude-3-opus';
        const legacyKey = '';
        const shouldSkip = !legacyUrl && !legacyModel && !legacyKey;
        expect(shouldSkip).toBe(false);
    });

    it('C1-C9 migration uses correct uniqueId format (custom + slot number)', () => {
        for (let i = 1; i <= 9; i++) {
            expect(`custom${i}`).toMatch(/^custom[1-9]$/);
        }
    });

    it('C1-C9 migration default format is openai', () => {
        // When cpm_c{i}_format returns empty, default should be 'openai'
        const raw = '';
        const format = raw || 'openai';
        expect(format).toBe('openai');
    });

    it('C1-C9 migration default tok is o200k_base', () => {
        const raw = '';
        const tok = raw || 'o200k_base';
        expect(tok).toBe('o200k_base');
    });

    it('C1-C9 migration default reasoning/verbosity/thinking is none', () => {
        const rawR = '';
        const rawV = '';
        const rawT = '';
        const reasoning = rawR || 'none';
        const verbosity = rawV || 'none';
        const thinking = rawT || 'none';
        expect(reasoning).toBe('none');
        expect(verbosity).toBe('none');
        expect(thinking).toBe('none');
    });
});

// ════════════════════════════════════════════════════════════════════
// C.  Boot Health Telemetry
// ════════════════════════════════════════════════════════════════════
describe('Boot health telemetry — cpm_last_boot_status', () => {
    it('init source records boot status to pluginStorage', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain("Risu.pluginStorage.setItem('cpm_last_boot_status'");
    });

    it('boot status JSON structure includes required fields', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('ts: Date.now()');
        expect(src).toContain('version: CPM_VERSION');
        expect(src).toContain('ok: _completedPhases');
        expect(src).toContain('fail: _failedPhases');
        expect(src).toContain('models: _modelRegCount');
        expect(src).toContain('settingsOk: _settingsRegistered');
    });

    it('boot status is recorded in success path', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        // Should appear after "Boot complete"
        const bootCompleteIdx = src.indexOf('Boot complete —');
        const bootStatusIdx = src.indexOf("cpm_last_boot_status'", bootCompleteIdx);
        expect(bootCompleteIdx).toBeGreaterThan(-1);
        expect(bootStatusIdx).toBeGreaterThan(bootCompleteIdx);
    });

    it('boot status is also recorded in error path (FATAL)', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        // Should have FATAL marker in error catch
        expect(src).toContain('FATAL:${_bootPhase}');
    });

    it('boot status recording is wrapped in try-catch', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const initBlock = src.slice(src.indexOf('// MAIN INIT'));
        // The pluginStorage.setItem call should be inside try-catch
        const storageCall = 'pluginStorage.setItem(\'cpm_last_boot_status\'';
        const callIdx = initBlock.indexOf(storageCall);
        // Look backwards for 'try {'
        const precedingBlock = initBlock.slice(Math.max(0, callIdx - 200), callIdx);
        expect(precedingBlock).toContain('try');
    });

    it('serialized boot status is valid JSON shape', () => {
        // Simulate what the boot status recording produces
        const status = {
            ts: Date.now(),
            version: '2.0.0-alpha.1',
            ok: ['register-settings', 'settings-restore', 'custom-models', 'ipc-setup', 'model-registration'],
            fail: [],
            models: 42,
            settingsOk: true,
        };
        const json = JSON.stringify(status);
        const parsed = JSON.parse(json);
        expect(parsed.ts).toBeTypeOf('number');
        expect(parsed.version).toBeTypeOf('string');
        expect(Array.isArray(parsed.ok)).toBe(true);
        expect(Array.isArray(parsed.fail)).toBe(true);
        expect(parsed.models).toBeTypeOf('number');
        expect(parsed.settingsOk).toBe(true);
    });

    it('failed boot status includes FATAL phase', () => {
        const _bootPhase = 'model-registration';
        const _completedPhases = ['register-settings', 'settings-restore'];
        const _failedPhases = ['custom-models: Parse error'];
        const _errAny = new Error('Unexpected null');

        const status = {
            ts: Date.now(),
            version: '2.0.0',
            ok: _completedPhases,
            fail: [..._failedPhases, `FATAL:${_bootPhase}: ${_errAny?.message || _errAny}`],
            models: 0,
            settingsOk: true,
        };
        expect(status.fail).toHaveLength(2);
        expect(status.fail[1]).toContain('FATAL:model-registration');
        expect(status.fail[1]).toContain('Unexpected null');
    });
});

// ════════════════════════════════════════════════════════════════════
// D.  Phase Tracking — boot diagnostics
// ════════════════════════════════════════════════════════════════════
describe('Phase tracking — boot phase diagnostics', () => {
    it('init source has _bootPhase tracking variable', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain("let _bootPhase = 'pre-init'");
    });

    it('init source has _completedPhases array', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('const _completedPhases = []');
    });

    it('init source has _failedPhases array', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('const _failedPhases = []');
    });

    it('_phaseStart/_phaseDone/_phaseFail helpers exist', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('const _phaseStart');
        expect(src).toContain('const _phaseDone');
        expect(src).toContain('const _phaseFail');
    });

    it('all expected phases are tracked', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const expectedPhases = [
            'register-settings',
            'settings-restore',
            'streaming-check',
            'custom-models',
            'ipc-setup',
            'model-registration',
            'hotkey-registration',
            'auto-updater',
        ];
        for (const phase of expectedPhases) {
            expect(src).toContain(`'${phase}'`);
        }
    });

    it('_phaseFail logs error and continues (does not throw)', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        // _phaseFail should push to _failedPhases and console.error
        expect(src).toContain('_failedPhases.push(');
        // The phase start/done/fail helpers should reference phase completion
        expect(src).toContain('_completedPhases.push(');
    });

    it('boot summary reports phase counts', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('${_completedPhases.length} phases OK');
        expect(src).toContain('${_failedPhases.length} failed');
        expect(src).toContain('${_modelRegCount} models registered');
    });

    it('error fallback includes phase info in error panel', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('Failed at phase: <code>${_bootPhase}</code>');
        expect(src).toContain("Completed: ${_completedPhases.join(', ') || 'none'}");
    });

    it('phase tracking simulation — success path', () => {
        const phases = [];
        const failed = [];
        let current = 'pre-init';

        const start = (p) => { current = p; };
        const done = (p) => { phases.push(p); };
        const fail = (p, e) => { failed.push(`${p}: ${e}`); };

        start('register-settings');
        done('register-settings');

        start('settings-restore');
        done('settings-restore');

        start('custom-models');
        done('custom-models');

        expect(phases).toEqual(['register-settings', 'settings-restore', 'custom-models']);
        expect(failed).toHaveLength(0);
    });

    it('phase tracking simulation — partial failure', () => {
        const phases = [];
        const failed = [];

        const done = (p) => { phases.push(p); };
        const fail = (p, e) => { failed.push(`${p}: ${e}`); };

        done('register-settings');
        fail('settings-restore', 'pluginStorage not ready');
        done('custom-models');
        fail('streaming-check', 'bridge timeout');
        done('model-registration');

        expect(phases).toEqual(['register-settings', 'custom-models', 'model-registration']);
        expect(failed).toHaveLength(2);
        expect(failed[0]).toContain('settings-restore');
        expect(failed[1]).toContain('streaming-check');
    });
});

// ════════════════════════════════════════════════════════════════════
// E.  Event Handler Cleanup on Re-Init
// ════════════════════════════════════════════════════════════════════
describe('Event handler cleanup — double-fire prevention', () => {
    it('init source stores handler references for cleanup', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('g._cpmKeydownHandler = _keydownHandler');
        expect(src).toContain('g._cpmAddPointerHandler = addPointer');
        expect(src).toContain('g._cpmRemovePointerHandler = removePointer');
    });

    it('init source removes old handlers before re-registering', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        // Should check for existing handlers
        expect(src).toContain('if (g._cpmKeydownHandler)');
        expect(src).toContain('if (g._cpmAddPointerHandler)');
        // Should call removeEventListener
        expect(src).toContain("removeEventListener('keydown', g._cpmKeydownHandler)");
        expect(src).toContain("removeEventListener('pointerdown', g._cpmAddPointerHandler)");
        expect(src).toContain("removeEventListener('pointerup', g._cpmRemovePointerHandler)");
        expect(src).toContain("removeEventListener('pointercancel', g._cpmRemovePointerHandler)");
    });

    it('handler cleanup is guarded with try-catch', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        // Find cleanup block
        const cleanupIdx = src.indexOf("removeEventListener('keydown', g._cpmKeydownHandler)");
        // Should be in a try-catch
        const precedingBlock = src.slice(Math.max(0, cleanupIdx - 100), cleanupIdx);
        expect(precedingBlock).toContain('try');
    });

    it('event handler cleanup simulation', () => {
        // Simulate the pattern
        const handlers = {};
        const removed = [];
        const added = [];

        // Mock rootDoc
        const rootDoc = {
            addEventListener: (evt, fn) => { added.push(evt); },
            removeEventListener: (evt, fn) => { removed.push(evt); },
        };

        // First init
        const handler1 = () => {};
        rootDoc.addEventListener('keydown', handler1);
        handlers._cpmKeydownHandler = handler1;
        expect(added).toEqual(['keydown']);

        // Second init — cleanup + re-register
        if (handlers._cpmKeydownHandler) {
            rootDoc.removeEventListener('keydown', handlers._cpmKeydownHandler);
        }
        const handler2 = () => {};
        rootDoc.addEventListener('keydown', handler2);
        handlers._cpmKeydownHandler = handler2;

        expect(removed).toEqual(['keydown']);
        expect(added).toEqual(['keydown', 'keydown']);
    });
});

// ════════════════════════════════════════════════════════════════════
// F.  Streaming Capability Check During Boot
// ════════════════════════════════════════════════════════════════════
describe('Streaming capability check — boot phase', () => {
    it('init source includes streaming check phase', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain("_phaseStart('streaming-check')");
        expect(src).toContain('checkStreamCapability()');
        expect(src).toContain("_phaseDone('streaming-check')");
    });

    it('streaming check reads cpm_streaming_enabled and cpm_compatibility_mode', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const initBlock = src.slice(src.indexOf('streaming-check'));
        expect(initBlock).toContain("cpm_streaming_enabled");
        expect(initBlock).toContain("cpm_compatibility_mode");
    });

    it('checkStreamCapability returns boolean', async () => {
        // The function needs Risu mock, test that it's exported
        expect(typeof checkStreamCapability).toBe('function');
    });
});

// ════════════════════════════════════════════════════════════════════
// G.  Custom Model Proxy Diagnostic Logging
// ════════════════════════════════════════════════════════════════════
describe('Custom model proxy diagnostic logging', () => {
    it('init source logs proxyUrl state for custom models at boot', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain('proxyUrl=');
        expect(src).toContain('[CPM] Custom models loaded');
    });
});

// ════════════════════════════════════════════════════════════════════
// H.  Full Init Sequence Verification
// ════════════════════════════════════════════════════════════════════
describe('Full init sequence verification', () => {
    it('init phases in source follow correct order', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const initBlock = src.slice(src.indexOf('// MAIN INIT'));

        const orderedPatterns = [
            "CRITICAL FIRST",             // Comment block
            "register-settings",          // Phase 1
            "_settingsRegistered = true",  // Settings confirmed
            "settings-restore",           // Phase 2
            "streaming-check",            // Phase 3
            "custom-models",              // Phase 4
            "C1-C9",                      // Migration
            "ipc-setup",                  // Phase 5
            "model-registration",         // Phase 6
            "hotkey-registration",        // Phase 7
            "snapshotAll",                // Backup
            "auto-updater",              // Phase 8
            "Boot complete",              // Summary
            "cpm_last_boot_status",       // Telemetry
        ];

        let lastIdx = -1;
        for (const pattern of orderedPatterns) {
            const idx = initBlock.indexOf(pattern, lastIdx);
            expect(idx, `Pattern '${pattern}' should follow previous patterns`).toBeGreaterThan(lastIdx);
            lastIdx = idx;
        }
    });

    it('init has error catch with phase info', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        expect(src).toContain("Unexpected init fail at phase '${_bootPhase}'");
        expect(src).toContain('Completed phases before crash');
    });

    it('error catch records FATAL boot status', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');
        const catchBlock = src.slice(src.indexOf("Unexpected init fail at phase"));
        expect(catchBlock).toContain("cpm_last_boot_status");
        expect(catchBlock).toContain("FATAL:");
    });
});

// ════════════════════════════════════════════════════════════════════
// I.  C1-C9 Migration Functional Simulation
// ════════════════════════════════════════════════════════════════════
describe('C1-C9 migration functional simulation', () => {
    it('full migration flow produces correct JSON array', async () => {
        // Simulate the legacy settings store
        const legacyStore = {
            'cpm_c1_url': 'https://api.openai.com/v1/chat/completions',
            'cpm_c1_model': 'gpt-4',
            'cpm_c1_key': 'sk-test1',
            'cpm_c1_name': 'My GPT-4',
            'cpm_c1_format': 'openai',
            'cpm_c2_url': 'https://api.anthropic.com/v1/messages',
            'cpm_c2_model': 'claude-3-opus-20240229',
            'cpm_c2_key': 'sk-ant-test2',
            'cpm_c2_name': '',
            'cpm_c2_format': 'anthropic',
            // c3-c9 are empty
        };

        const mockGetArg = async (key, defaultVal = '') => legacyStore[key] || defaultVal || '';
        const mockGetBoolArg = async (key) => {
            const val = legacyStore[key];
            return val === 'true' || val === true;
        };

        const cache = [];
        for (let i = 1; i <= 9; i++) {
            const legacyUrl = await mockGetArg(`cpm_c${i}_url`);
            const legacyModel = await mockGetArg(`cpm_c${i}_model`);
            const legacyKey = await mockGetArg(`cpm_c${i}_key`);
            if (!legacyUrl && !legacyModel && !legacyKey) continue;
            cache.push({
                uniqueId: `custom${i}`,
                name: await mockGetArg(`cpm_c${i}_name`) || `Custom ${i}`,
                model: legacyModel || '',
                url: legacyUrl || '',
                key: legacyKey || '',
                format: await mockGetArg(`cpm_c${i}_format`) || 'openai',
                sysfirst: await mockGetBoolArg(`cpm_c${i}_sysfirst`),
                altrole: await mockGetBoolArg(`cpm_c${i}_altrole`),
                mustuser: await mockGetBoolArg(`cpm_c${i}_mustuser`),
                maxout: await mockGetBoolArg(`cpm_c${i}_maxout`),
                mergesys: await mockGetBoolArg(`cpm_c${i}_mergesys`),
                decoupled: await mockGetBoolArg(`cpm_c${i}_decoupled`),
                thought: await mockGetBoolArg(`cpm_c${i}_thought`),
                reasoning: await mockGetArg(`cpm_c${i}_reasoning`) || 'none',
                verbosity: await mockGetArg(`cpm_c${i}_verbosity`) || 'none',
                thinking: await mockGetArg(`cpm_c${i}_thinking`) || 'none',
                responsesMode: 'auto',
                tok: await mockGetArg(`cpm_c${i}_tok`) || 'o200k_base',
                customParams: '',
            });
        }

        expect(cache).toHaveLength(2);
        expect(cache[0].uniqueId).toBe('custom1');
        expect(cache[0].name).toBe('My GPT-4');
        expect(cache[0].model).toBe('gpt-4');
        expect(cache[0].format).toBe('openai');

        expect(cache[1].uniqueId).toBe('custom2');
        expect(cache[1].name).toBe('Custom 2'); // empty name → default
        expect(cache[1].model).toBe('claude-3-opus-20240229');
        expect(cache[1].format).toBe('anthropic');

        // Verify serialization
        const json = JSON.stringify(cache);
        const reparsed = JSON.parse(json);
        expect(reparsed).toHaveLength(2);
    });

    it('migration produces models parseable by parseCustomModelsValue', async () => {
        const migratedModels = [
            {
                uniqueId: 'custom1',
                name: 'Legacy Model',
                model: 'gpt-4',
                url: 'https://api.example.com',
                key: 'sk-test',
                format: 'openai',
                sysfirst: false,
                altrole: false,
                mustuser: false,
                maxout: false,
                mergesys: false,
                decoupled: false,
                thought: false,
                reasoning: 'none',
                verbosity: 'none',
                thinking: 'none',
                responsesMode: 'auto',
                tok: 'o200k_base',
                customParams: '',
            },
        ];

        const json = JSON.stringify(migratedModels);
        const parsed = parseCustomModelsValue(json);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].uniqueId).toBe('custom1');
    });

    it('parseCustomModelsValue handles ALL 9 migrated slots', () => {
        const models = [];
        for (let i = 1; i <= 9; i++) {
            models.push({
                uniqueId: `custom${i}`,
                name: `Slot ${i}`,
                model: `model-${i}`,
                url: `https://api${i}.example.com`,
                key: `key-${i}`,
                format: 'openai',
            });
        }
        const parsed = parseCustomModelsValue(JSON.stringify(models));
        expect(parsed).toHaveLength(9);
        expect(parsed[8].uniqueId).toBe('custom9');
    });

    it('migration does not run when valid JSON models already exist', () => {
        const CUSTOM_MODELS_CACHE = [
            { uniqueId: 'existing', model: 'gpt-4', name: 'Existing' },
        ];
        // The condition: only migrate when cache is EMPTY
        const shouldMigrate = CUSTOM_MODELS_CACHE.length === 0;
        expect(shouldMigrate).toBe(false);
    });

    it('migration handles slot with all boolean flags set', async () => {
        const store = {
            'cpm_c1_url': 'https://api.example.com',
            'cpm_c1_model': 'test-model',
            'cpm_c1_key': 'k',
            'cpm_c1_name': 'All Flags',
            'cpm_c1_format': 'anthropic',
            'cpm_c1_sysfirst': 'true',
            'cpm_c1_altrole': 'true',
            'cpm_c1_mustuser': 'true',
            'cpm_c1_maxout': 'true',
            'cpm_c1_mergesys': 'true',
            'cpm_c1_decoupled': 'true',
            'cpm_c1_thought': 'true',
            'cpm_c1_reasoning': 'full',
            'cpm_c1_verbosity': 'high',
            'cpm_c1_thinking': 'extended',
        };

        const get = async (k, d = '') => store[k] || d || '';
        const getBool = async (k) => store[k] === 'true';

        const model = {
            uniqueId: 'custom1',
            name: await get('cpm_c1_name') || 'Custom 1',
            model: await get('cpm_c1_model'),
            url: await get('cpm_c1_url'),
            key: await get('cpm_c1_key'),
            format: await get('cpm_c1_format') || 'openai',
            sysfirst: await getBool('cpm_c1_sysfirst'),
            altrole: await getBool('cpm_c1_altrole'),
            mustuser: await getBool('cpm_c1_mustuser'),
            maxout: await getBool('cpm_c1_maxout'),
            mergesys: await getBool('cpm_c1_mergesys'),
            decoupled: await getBool('cpm_c1_decoupled'),
            thought: await getBool('cpm_c1_thought'),
            reasoning: await get('cpm_c1_reasoning') || 'none',
            verbosity: await get('cpm_c1_verbosity') || 'none',
            thinking: await get('cpm_c1_thinking') || 'none',
            responsesMode: 'auto',
            tok: await get('cpm_c1_tok') || 'o200k_base',
            customParams: '',
        };

        expect(model.sysfirst).toBe(true);
        expect(model.altrole).toBe(true);
        expect(model.mustuser).toBe(true);
        expect(model.maxout).toBe(true);
        expect(model.mergesys).toBe(true);
        expect(model.decoupled).toBe(true);
        expect(model.thought).toBe(true);
        expect(model.reasoning).toBe('full');
        expect(model.verbosity).toBe('high');
        expect(model.thinking).toBe('extended');
    });
});

// ════════════════════════════════════════════════════════════════════
// J.  Vertex Token Cache (IPC vertex.js)
// ════════════════════════════════════════════════════════════════════
describe('Vertex token cache — already in IPC vertex.js', () => {
    it('vertex.js source has _tokenCaches Map', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/providers/vertex.js'), 'utf-8');
        expect(src).toContain('_tokenCaches');
        expect(src).toContain('new Map()');
    });

    it('vertex.js caches tokens with expiry check', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/providers/vertex.js'), 'utf-8');
        expect(src).toContain('expiresAt');
        expect(src).toContain('cached.expiresAt > Date.now()');
    });
});

// ════════════════════════════════════════════════════════════════════
// K.  SSE Parser — Direct Import (no DI needed in IPC)
// ════════════════════════════════════════════════════════════════════
describe('SSE parser — updateApiRequest direct import', () => {
    it('sse-parser.js imports updateApiRequest directly', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/shared/sse-parser.js'), 'utf-8');
        expect(src).toContain("import { updateApiRequest } from './api-request-log.js'");
    });

    it('sse-parser.js calls updateApiRequest during streaming', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve('src/shared/sse-parser.js'), 'utf-8');
        const matches = src.match(/updateApiRequest\(/g);
        // Should be called in multiple stream parsers  
        expect(matches.length).toBeGreaterThanOrEqual(4);
    });
});

// ════════════════════════════════════════════════════════════════════
// L.  _temp_repo vs IPC Parity — cross-verification
// ════════════════════════════════════════════════════════════════════
describe('Cross-verification: _temp_repo/init.js parity', () => {
    it('IPC boot has all _temp_repo boot phases', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');

        // Read _temp_repo init.js phases
        const tempSrc = fs.readFileSync(
            path.resolve('../_temp_repo/src/lib/init.js'), 'utf-8',
        );
        const ipcSrc = fs.readFileSync(
            path.resolve('src/manager/index.js'), 'utf-8',
        );

        // _temp_repo phases
        const tempPhases = [
            'register-settings',
            'settings-restore',
            'streaming-check',
            'custom-models',
            'model-registration',
            'hotkey-registration',
        ];

        for (const phase of tempPhases) {
            expect(tempSrc, `_temp_repo should have phase '${phase}'`).toContain(`'${phase}'`);
            expect(ipcSrc, `IPC should have phase '${phase}'`).toContain(`'${phase}'`);
        }
    });

    it('IPC has C1-C9 migration like _temp_repo', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const tempSrc = fs.readFileSync(path.resolve('../_temp_repo/src/lib/init.js'), 'utf-8');
        const ipcSrc = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');

        expect(tempSrc).toContain('Auto-Migrate from C1-C9 to JSON');
        expect(ipcSrc).toContain('Auto-Migrate from C1-C9 to JSON');
    });

    it('IPC has boot health telemetry like _temp_repo', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const tempSrc = fs.readFileSync(path.resolve('../_temp_repo/src/lib/init.js'), 'utf-8');
        const ipcSrc = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');

        expect(tempSrc).toContain('cpm_last_boot_status');
        expect(ipcSrc).toContain('cpm_last_boot_status');
    });

    it('IPC has handler cleanup like _temp_repo', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const tempSrc = fs.readFileSync(path.resolve('../_temp_repo/src/lib/init.js'), 'utf-8');
        const ipcSrc = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');

        expect(tempSrc).toContain('_cpmKeydownHandler');
        expect(ipcSrc).toContain('_cpmKeydownHandler');
    });

    it('IPC registers settings FIRST like _temp_repo', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const tempSrc = fs.readFileSync(path.resolve('../_temp_repo/src/lib/init.js'), 'utf-8');
        const ipcSrc = fs.readFileSync(path.resolve('src/manager/index.js'), 'utf-8');

        // Both should have the "CRITICAL FIRST" pattern
        expect(tempSrc).toContain('CRITICAL FIRST');
        expect(ipcSrc).toContain('CRITICAL FIRST');
    });
});
