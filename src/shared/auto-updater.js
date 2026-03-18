// @ts-check
/**
 * auto-updater.js — Main plugin auto-update logic for IPC architecture.
 *
 * Migrated from temp_repo (auto-updater.js). Adapted to use dependency injection
 * instead of global state/mixin pattern.
 *
 * Responsibilities:
 *   - SHA-256 integrity verification
 *   - Pending update marker persistence (read/write/clear/remember)
 *   - Retriable error classification
 *   - Version check (manifest + JS fallback)
 *   - Download with bundle-first strategy + Content-Length integrity
 *   - Validate & install to RisuAI DB (header parsing, settings preservation)
 *   - Boot retry lifecycle
 *   - Concurrent dedup via _mainUpdateInFlight
 */

import { safeSetDatabaseLite } from './safe-db-writer.js';

// ────────────────────────────────────────────────────────────────
// Timeout utility — clearTimeout cleanup prevents dangling timers
// ────────────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout with proper cleanup.
 * Prevents dangling timer handles during tests and retries.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function _withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        Promise.resolve(promise).then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

// ────────────────────────────────────────────────────────────────
// SHA-256 utility
// ────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of a string using Web Crypto API.
 * Falls back gracefully if crypto.subtle is unavailable.
 * @param {string} text
 * @returns {Promise<string>} lowercase hex string, or empty string on failure
 */
export async function computeSHA256(text) {
    try {
        const data = new TextEncoder().encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
        return '';
    }
}

// ────────────────────────────────────────────────────────────────
// Version comparison utility
// ────────────────────────────────────────────────────────────────

/**
 * Compare two semver-like version strings.
 * Returns positive if remote > local, 0 if equal, negative if remote < local.
 * @param {string} local
 * @param {string} remote
 * @returns {number}
 */
export function compareVersions(local, remote) {
    const parse = (/** @type {string} */ v) => String(v || '0.0.0').split('.').map(Number);
    const a = parse(local);
    const b = parse(remote);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const diff = (b[i] || 0) - (a[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// ────────────────────────────────────────────────────────────────
// Non-retriable error patterns
// ────────────────────────────────────────────────────────────────

const NON_RETRIABLE_PATTERNS = [
    '이름 불일치',
    '버전 불일치',
    'api 버전이 3.0이 아닙니다',
    '다운그레이드 차단',
    '이미 같은 버전입니다',
    '플러그인을 db에서 찾을 수 없습니다',
    '플러그인 목록을 찾을 수 없습니다',
];

/**
 * Check if an error message indicates a retriable failure.
 * @param {string|Error} error
 * @returns {boolean}
 */
export function isRetriableError(error) {
    const msg = String(error || '').toLowerCase();
    if (!msg) return true;
    return !NON_RETRIABLE_PATTERNS.some(pattern => msg.includes(pattern.toLowerCase()));
}

// ────────────────────────────────────────────────────────────────
// Auto-updater factory
// ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AutoUpdaterDeps
 * @property {any} Risu - RisuAI API reference
 * @property {string} currentVersion - Current CPM_VERSION
 * @property {string} pluginName - Plugin name for DB lookup (e.g. 'Cupcake Provider Manager')
 * @property {string} versionsUrl - Version manifest URL
 * @property {string} mainUpdateUrl - Main plugin JS download URL
 * @property {string} updateBundleUrl - Single-bundle update URL
 * @property {{ showMainAutoUpdateResult?: (local: string, remote: string, changes: string, success: boolean, error?: string) => Promise<void> }} [toast] - Toast notifications
 * @property {(data: any, schema: any) => { valid: boolean, value: any }} [validateSchema] - Schema validator
 * @property {string} [autoUpdateArgKey] - Plugin arg key for auto-update toggle (default: 'cpm_auto_update_enabled')
 */

/**
 * Create an auto-updater instance with dependency injection.
 * @param {AutoUpdaterDeps} deps
 */
export function createAutoUpdater(deps) {
    const {
        Risu,
        currentVersion,
        pluginName,
        versionsUrl,
        mainUpdateUrl,
        updateBundleUrl,
        toast,
        validateSchema,
        autoUpdateArgKey = 'cpm_auto_update_enabled',
    } = deps;

    // ── Constants ──
    const VERSION_CHECK_COOLDOWN = 600000; // 10 minutes
    const VERSION_CHECK_STORAGE_KEY = 'cpm_last_version_check';
    const MAIN_VERSION_CHECK_STORAGE_KEY = 'cpm_last_main_version_check';
    const MAIN_UPDATE_RETRY_STORAGE_KEY = 'cpm_pending_main_update';
    const MAIN_UPDATE_RETRY_COOLDOWN = 300000; // 5 minutes
    const MAIN_UPDATE_RETRY_MAX_ATTEMPTS = 2;
    const DB_PLUGIN_NAME = pluginName.replace(/\s+/g, '_');

    /** @type {Promise<{ok: boolean, error?: string}>|null} */
    let _mainUpdateInFlight = null;

    // ── Pending update marker persistence ──

    async function readPendingUpdate() {
        try {
            const raw = await Risu.pluginStorage.getItem(MAIN_UPDATE_RETRY_STORAGE_KEY);
            if (!raw) return null;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!parsed || typeof parsed !== 'object') {
                await clearPendingUpdate();
                return null;
            }
            const version = String(parsed.version || '').trim();
            if (!version) {
                await clearPendingUpdate();
                return null;
            }
            return {
                version,
                changes: typeof parsed.changes === 'string' ? parsed.changes : '',
                createdAt: Number(parsed.createdAt) || 0,
                attempts: Number(parsed.attempts) || 0,
                lastAttemptTs: Number(parsed.lastAttemptTs) || 0,
                lastError: typeof parsed.lastError === 'string' ? parsed.lastError : '',
            };
        } catch (/** @type {any} */ e) {
            console.warn('[CPM Retry] Failed to read pending main update marker:', e.message || e);
            try { await clearPendingUpdate(); } catch (_) { }
            return null;
        }
    }

    /** @param {any} data */
    async function writePendingUpdate(data) {
        try {
            await Risu.pluginStorage.setItem(MAIN_UPDATE_RETRY_STORAGE_KEY, JSON.stringify(data));
        } catch (/** @type {any} */ e) {
            console.warn('[CPM Retry] Failed to write pending main update marker:', e.message || e);
        }
    }

    async function clearPendingUpdate() {
        try {
            if (typeof Risu.pluginStorage.removeItem === 'function') {
                await Risu.pluginStorage.removeItem(MAIN_UPDATE_RETRY_STORAGE_KEY);
            } else {
                await Risu.pluginStorage.setItem(MAIN_UPDATE_RETRY_STORAGE_KEY, '');
            }
        } catch (/** @type {any} */ e) {
            console.warn('[CPM Retry] Failed to clear pending main update marker:', e.message || e);
        }
    }

    /**
     * @param {string} remoteVersion
     * @param {string} [changes]
     */
    async function rememberPendingUpdate(remoteVersion, changes) {
        const version = String(remoteVersion || '').trim();
        if (!version) return;
        const existing = await readPendingUpdate();
        const sameVersion = existing && existing.version === version;
        await writePendingUpdate({
            version,
            changes: typeof changes === 'string' ? changes : (existing?.changes || ''),
            createdAt: sameVersion ? (existing.createdAt || Date.now()) : Date.now(),
            attempts: sameVersion ? (existing.attempts || 0) : 0,
            lastAttemptTs: sameVersion ? (existing.lastAttemptTs || 0) : 0,
            lastError: sameVersion ? (existing.lastError || '') : '',
        });
    }

    // ── Installed version helper ──

    async function getInstalledVersion() {
        try {
            const db = await Risu.getDatabase();
            const plugin = db?.plugins?.find?.(
                (/** @type {any} */ p) => p?.name === DB_PLUGIN_NAME || p?.name === pluginName
            );
            return String(plugin?.versionOfPlugin || currentVersion || '').trim();
        } catch (_) {
            return String(currentVersion || '').trim();
        }
    }

    // ── Download with integrity verification ──

    /**
     * @param {string} [expectedVersion]
     * @returns {Promise<{ok: boolean, code?: string, error?: string}>}
     */
    async function downloadMainPluginCode(expectedVersion) {
        const LOG = '[CPM Download]';
        const MAX_RETRIES = 3;

        // Prefer the update bundle (same source of truth as api/versions).
        try {
            const bundleUrl = updateBundleUrl + '?_t=' + Date.now() + '&_r=' + Math.random().toString(36).substr(2, 6);
            console.log(`${LOG} Trying update bundle first: ${bundleUrl}`);
            const bundleResult = await _withTimeout(
                Risu.risuFetch(bundleUrl, { method: 'GET', plainFetchForce: true }),
                20000, 'update bundle fetch timed out (20s)'
            );

            if (bundleResult?.data && (!bundleResult.status || bundleResult.status < 400)) {
                const rawBundle = typeof bundleResult.data === 'string' ? JSON.parse(bundleResult.data) : bundleResult.data;

                // Validate bundle structure if validator provided
                if (validateSchema) {
                    const parsedBundle = validateSchema(rawBundle, { type: 'object' });
                    if (!parsedBundle.valid) {
                        throw new Error(`update bundle schema invalid`);
                    }
                }

                const mainEntry = rawBundle.versions?.[pluginName];
                const fileName = mainEntry?.file || 'provider-manager.js';
                const bundledCode = rawBundle.code?.[fileName];

                if (!mainEntry?.version) {
                    throw new Error('main plugin version missing in update bundle');
                }
                if (expectedVersion && mainEntry.version !== expectedVersion) {
                    throw new Error(`bundle version mismatch: expected ${expectedVersion}, got ${mainEntry.version}`);
                }
                if (!bundledCode || typeof bundledCode !== 'string') {
                    throw new Error(`main plugin code missing in update bundle (${fileName})`);
                }
                if (!mainEntry.sha256) {
                    throw new Error('main plugin bundle entry has no sha256 hash — refusing untrusted update');
                }
                const actualHash = await computeSHA256(bundledCode);
                if (!actualHash) {
                    throw new Error('SHA-256 computation failed for bundled main plugin code');
                }
                if (actualHash !== mainEntry.sha256) {
                    throw new Error(`bundle sha256 mismatch: expected ${mainEntry.sha256.substring(0, 12)}…, got ${actualHash.substring(0, 12)}…`);
                }
                console.log(`${LOG} Bundle integrity OK [sha256:${mainEntry.sha256.substring(0, 12)}…]`);
                console.log(`${LOG} Bundle download OK: ${fileName} v${mainEntry.version} (${(bundledCode.length / 1024).toFixed(1)}KB)`);
                return { ok: true, code: bundledCode };
            }
            throw new Error(`update bundle fetch failed with status ${bundleResult?.status}`);
        } catch (/** @type {any} */ bundleErr) {
            console.warn(`${LOG} Update bundle path failed, falling back to direct JS:`, bundleErr.message || bundleErr);
        }

        // Best-effort: fetch expected SHA-256 from versions manifest for fallback integrity check
        let _fallbackExpectedSha256 = null;
        try {
            const vUrl = versionsUrl + '?_t=' + Date.now();
            const vRes = await _withTimeout(
                Risu.risuFetch(vUrl, { method: 'GET', plainFetchForce: true }),
                10000, 'versions manifest timed out (10s)'
            );
            if (vRes?.data) {
                const vData = typeof vRes.data === 'string' ? JSON.parse(vRes.data) : vRes.data;
                _fallbackExpectedSha256 = vData?.[pluginName]?.sha256 || null;
                if (_fallbackExpectedSha256) {
                    console.log(`${LOG} Fallback integrity: got expected SHA from versions manifest [${_fallbackExpectedSha256.substring(0, 12)}…]`);
                }
            }
        } catch (_) {
            console.warn(`${LOG} Could not fetch versions manifest for fallback integrity check — proceeding without SHA verification`);
        }

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`${LOG} Attempt ${attempt}/${MAX_RETRIES}: ${mainUpdateUrl}`);
                const cacheBuster = mainUpdateUrl + '?_t=' + Date.now() + '&_r=' + Math.random().toString(36).substr(2, 6);

                let response;
                try {
                    response = await _withTimeout(
                        Risu.nativeFetch(cacheBuster, { method: 'GET' }),
                        20000, 'nativeFetch timed out (20s)'
                    );
                } catch (nativeErr) {
                    console.warn(`${LOG} nativeFetch failed, falling back to risuFetch:`, /** @type {any} */ (nativeErr).message || nativeErr);
                    const risuResult = await _withTimeout(
                        Risu.risuFetch(cacheBuster, { method: 'GET', plainFetchForce: true }),
                        20000, 'risuFetch fallback timed out (20s)'
                    );
                    if (!risuResult.data || (risuResult.status && risuResult.status >= 400)) {
                        throw new Error(`risuFetch failed with status ${risuResult.status}`);
                    }
                    const code = typeof risuResult.data === 'string' ? risuResult.data : String(risuResult.data || '');
                    if (_fallbackExpectedSha256) {
                        const actualHash = await computeSHA256(code);
                        if (actualHash && actualHash !== _fallbackExpectedSha256) {
                            throw new Error(`direct download sha256 mismatch: expected ${_fallbackExpectedSha256.substring(0, 12)}…, got ${(actualHash || '?').substring(0, 12)}…`);
                        }
                        if (actualHash) console.log(`${LOG} Fallback integrity OK [sha256:${actualHash.substring(0, 12)}…]`);
                    } else {
                        console.warn(`${LOG} ⚠️ Direct download completed WITHOUT SHA-256 verification (versions manifest unavailable)`);
                    }
                    return { ok: true, code };
                }

                if (!response.ok || response.status < 200 || response.status >= 300) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const text = await _withTimeout(
                    response.text(),
                    20000, 'response body read timed out (20s)'
                );

                const contentLength = parseInt(response.headers?.get?.('content-length') || '0', 10);
                if (contentLength > 0) {
                    const actualBytes = new TextEncoder().encode(text).byteLength;
                    if (actualBytes < contentLength) {
                        console.warn(`${LOG} Incomplete download (${attempt}/${MAX_RETRIES}): expected ${contentLength}B, got ${actualBytes}B`);
                        if (attempt < MAX_RETRIES) {
                            await new Promise(r => setTimeout(r, 1000 * attempt));
                            continue;
                        }
                        return { ok: false, error: `다운로드 불완전: ${contentLength}B 중 ${actualBytes}B만 수신됨` };
                    }
                    console.log(`${LOG} Content-Length OK: ${actualBytes}B / ${contentLength}B`);
                }

                if (_fallbackExpectedSha256) {
                    const actualHash = await computeSHA256(text);
                    if (actualHash && actualHash !== _fallbackExpectedSha256) {
                        throw new Error(`direct download sha256 mismatch: expected ${_fallbackExpectedSha256.substring(0, 12)}…, got ${(actualHash || '?').substring(0, 12)}…`);
                    }
                    if (actualHash) console.log(`${LOG} Fallback integrity OK [sha256:${actualHash.substring(0, 12)}…]`);
                } else {
                    console.warn(`${LOG} ⚠️ Direct download completed WITHOUT SHA-256 verification (versions manifest unavailable)`);
                }

                return { ok: true, code: text };
            } catch (/** @type {any} */ e) {
                console.warn(`${LOG} Error (${attempt}/${MAX_RETRIES}):`, e.message || e);
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                } else {
                    return { ok: false, error: `다운로드 실패 (${MAX_RETRIES}회 시도): ${e.message || e}` };
                }
            }
        }
        return { ok: false, error: '다운로드 실패 (알 수 없는 오류)' };
    }

    // ── Validate & install to RisuAI DB ──

    /**
     * @param {string} code
     * @param {string} remoteVersion
     * @param {string} [changes]
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async function validateAndInstall(code, remoteVersion, changes) {
        const LOG = '[CPM SafeUpdate]';

        if (!code || code.length < 100) {
            return { ok: false, error: '다운로드된 코드가 비어있거나 너무 짧습니다' };
        }

        const lines = code.split('\n');
        let parsedName = '', parsedDisplayName = '', parsedVersion = '', parsedUpdateURL = '', parsedApiVersion = '2.0';
        /** @type {Record<string, 'int'|'string'>} */
        const parsedArgs = {};
        /** @type {Record<string, string|number>} */
        const defaultRealArg = {};
        /** @type {Record<string, Record<string, string>>} */
        const parsedArgMeta = {};
        /** @type {Array<{link: string, hoverText?: string}>} */
        const parsedCustomLink = [];

        for (const line of lines) {
            const nameMatch = line.match(/^\/\/@name\s+(.+)/);
            if (nameMatch) parsedName = nameMatch[1].trim();
            const displayMatch = line.match(/^\/\/@display-name\s+(.+)/);
            if (displayMatch) parsedDisplayName = displayMatch[1].trim();
            const verMatch = line.match(/^\/\/@version\s+(.+)/);
            if (verMatch) parsedVersion = verMatch[1].trim();
            const urlMatch = line.match(/^\/\/@update-url\s+(\S+)/);
            if (urlMatch) parsedUpdateURL = urlMatch[1];
            if (/^\/\/@api\s/.test(line)) {
                const vers = line.replace(/^\/\/@api\s+/, '').trim().split(' ');
                for (const v of vers) { if (['2.0', '2.1', '3.0'].includes(v)) { parsedApiVersion = v; break; } }
            }
            if (/^\/\/@(?:arg|risu-arg)\s/.test(line)) {
                const parts = line.trim().split(' ');
                if (parts.length >= 3) {
                    const key = parts[1];
                    const type = parts[2];
                    if (type === 'int' || type === 'string') {
                        parsedArgs[key] = type;
                        defaultRealArg[key] = type === 'int' ? 0 : '';
                    }
                    if (parts.length > 3) {
                        /** @type {Record<string, string>} */
                        const meta = {};
                        parts.slice(3).join(' ').replace(/\{\{(.+?)(::?(.+?))?\}\}/g, (/** @type {any} */ _, /** @type {string} */ g1, /** @type {any} */ _g2, /** @type {string} */ g3) => {
                            meta[g1] = g3 || '1';
                            return '';
                        });
                        if (Object.keys(meta).length > 0) parsedArgMeta[key] = meta;
                    }
                }
            }
            if (/^\/\/@link\s/.test(line)) {
                const link = line.split(' ')[1];
                if (link && link.startsWith('https')) {
                    const hoverText = line.split(' ').slice(2).join(' ').trim();
                    parsedCustomLink.push({ link, hoverText: hoverText || undefined });
                }
            }
        }

        if (!parsedName) {
            return { ok: false, error: '다운로드된 코드에서 플러그인 이름(@name)을 찾을 수 없습니다' };
        }
        if (parsedName !== DB_PLUGIN_NAME && parsedName !== pluginName) {
            return { ok: false, error: `이름 불일치: "${parsedName}" ≠ "${pluginName}"` };
        }
        if (!parsedVersion) {
            return { ok: false, error: '다운로드된 코드에서 버전 정보(@version)를 찾을 수 없습니다' };
        }
        if (parsedApiVersion !== '3.0') {
            return { ok: false, error: `API 버전이 3.0이 아닙니다: ${parsedApiVersion}` };
        }

        console.log(`${LOG} Parsed: name=${parsedName} ver=${parsedVersion} api=${parsedApiVersion} args=${Object.keys(parsedArgs).length}`);

        if (remoteVersion && parsedVersion !== remoteVersion) {
            return { ok: false, error: `버전 불일치: 기대 ${remoteVersion}, 실제 ${parsedVersion}` };
        }

        try {
            const db = await Risu.getDatabase();
            if (!db) {
                return { ok: false, error: 'RisuAI 데이터베이스 접근 실패 (권한 거부)' };
            }
            if (!db.plugins || !Array.isArray(db.plugins)) {
                return { ok: false, error: 'RisuAI 플러그인 목록을 찾을 수 없습니다' };
            }

            const existingIdx = db.plugins.findIndex(
                (/** @type {any} */ p) => p.name === DB_PLUGIN_NAME || p.name === pluginName
            );
            if (existingIdx === -1) {
                return { ok: false, error: `기존 "${pluginName}" 플러그인을 DB에서 찾을 수 없습니다` };
            }

            const existing = db.plugins[existingIdx];
            const currentInstalledVersion = existing.versionOfPlugin || currentVersion;
            const installDirection = compareVersions(currentInstalledVersion, parsedVersion);
            if (installDirection === 0) {
                return { ok: false, error: `이미 같은 버전입니다: ${parsedVersion}` };
            }
            if (installDirection < 0) {
                return { ok: false, error: `다운그레이드 차단: 현재 ${currentInstalledVersion} > 다운로드 ${parsedVersion}` };
            }

            const existingScriptBytes = new TextEncoder().encode(String(existing.script || '')).byteLength;
            const nextScriptBytes = new TextEncoder().encode(String(code || '')).byteLength;
            if (existingScriptBytes >= (300 * 1024) && nextScriptBytes < existingScriptBytes * 0.95) {
                return { ok: false, error: `불완전한 다운로드 의심: 새 코드(${(nextScriptBytes / 1024).toFixed(1)}KB)가 기존(${(existingScriptBytes / 1024).toFixed(1)}KB)의 95% 미만입니다` };
            }

            const oldRealArg = existing.realArg || {};
            /** @type {Record<string, any>} */
            const mergedRealArg = {};
            for (const [key, type] of Object.entries(parsedArgs)) {
                if (key in oldRealArg && existing.arguments && existing.arguments[key] === type) {
                    mergedRealArg[key] = oldRealArg[key];
                } else {
                    mergedRealArg[key] = defaultRealArg[key];
                }
            }

            /** @type {any} */
            const updatedPlugin = {
                name: parsedName,
                displayName: parsedDisplayName || parsedName,
                script: code,
                arguments: parsedArgs,
                realArg: mergedRealArg,
                argMeta: parsedArgMeta,
                version: '3.0',
                customLink: parsedCustomLink,
                versionOfPlugin: parsedVersion,
                updateURL: parsedUpdateURL || existing.updateURL || '',
                enabled: existing.enabled !== false,
            };

            // ── TOCTOU re-verification: re-read DB to detect concurrent updates ──
            const freshDb = await Risu.getDatabase();
            const freshPlugin = freshDb?.plugins?.find?.(
                (/** @type {any} */ p) => p.name === DB_PLUGIN_NAME || p.name === pluginName
            );
            if (freshPlugin && freshPlugin.versionOfPlugin && freshPlugin.versionOfPlugin !== currentInstalledVersion) {
                const freshCmp = compareVersions(freshPlugin.versionOfPlugin, parsedVersion);
                if (freshCmp <= 0) {
                    console.log(`${LOG} Concurrent update detected: DB version changed ${currentInstalledVersion}→${freshPlugin.versionOfPlugin} while preparing ${parsedVersion}`);
                    return { ok: false, error: `동시 업데이트 감지: DB 버전이 ${currentInstalledVersion}→${freshPlugin.versionOfPlugin}로 변경됨 (설치 대상: ${parsedVersion})` };
                }
            }

            const freshPlugins = freshDb.plugins.slice();
            const freshIdx = freshPlugins.findIndex(
                (/** @type {any} */ p) => p.name === DB_PLUGIN_NAME || p.name === pluginName
            );
            if (freshIdx === -1) {
                return { ok: false, error: `기존 "${pluginName}" 플러그인을 DB에서 찾을 수 없습니다 (재검증 실패)` };
            }
            freshPlugins[freshIdx] = updatedPlugin;
            const writeResult = await safeSetDatabaseLite(Risu, { plugins: freshPlugins });
            if (!writeResult.ok) {
                return { ok: false, error: `DB write rejected: ${writeResult.error}` };
            }

            // Post-write verification
            try {
                const verifyDb = await Risu.getDatabase();
                const verifyPlugin = verifyDb?.plugins?.find?.(
                    (/** @type {any} */ p) => p.name === DB_PLUGIN_NAME || p.name === pluginName
                );
                console.log(`${LOG} In-memory verify: version=${verifyPlugin?.versionOfPlugin || 'missing'} script=${verifyPlugin?.script ? 'present' : 'missing'}`);
            } catch (/** @type {any} */ verifyErr) {
                console.warn(`${LOG} In-memory verify failed:`, verifyErr.message || verifyErr);
            }

            // Autosave flush marker
            try {
                await Risu.pluginStorage.setItem('cpm_last_main_update_flush', JSON.stringify({
                    ts: Date.now(),
                    from: currentInstalledVersion,
                    to: parsedVersion,
                }));
                console.log(`${LOG} Autosave flush marker written to pluginStorage.`);
            } catch (/** @type {any} */ flushErr) {
                console.warn(`${LOG} Autosave flush marker write failed:`, flushErr.message || flushErr);
            }

            // Wait for autosave
            console.log(`${LOG} Waiting for RisuAI autosave flush before showing success...`);
            await new Promise(resolve => setTimeout(resolve, 3500));

            console.log(`${LOG} ✓ Successfully applied main plugin update: ${currentInstalledVersion} → ${parsedVersion}`);
            console.log(`${LOG}   Settings preserved: ${Object.keys(mergedRealArg).length} args (${Object.keys(oldRealArg).length} existed, ${Object.keys(parsedArgs).length} in new version)`);

            await clearPendingUpdate();

            if (toast?.showMainAutoUpdateResult) {
                await toast.showMainAutoUpdateResult(currentInstalledVersion, parsedVersion, changes || '', true);
            }

            return { ok: true };
        } catch (/** @type {any} */ e) {
            return { ok: false, error: `DB 저장 실패: ${e.message || e}` };
        }
    }

    // ── Safe update orchestrator (dedup) ──

    /**
     * @param {string} remoteVersion
     * @param {string} [changes]
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async function safeMainPluginUpdate(remoteVersion, changes) {
        if (_mainUpdateInFlight) {
            console.log('[CPM SafeUpdate] Main update already in flight — joining existing run.');
            return await _mainUpdateInFlight;
        }

        _mainUpdateInFlight = (async () => {
            try {
                await rememberPendingUpdate(remoteVersion, changes);

                const dl = await downloadMainPluginCode(remoteVersion);
                if (!dl.ok) {
                    console.error(`[CPM SafeUpdate] Download failed: ${dl.error}`);
                    if (!isRetriableError(dl.error || '')) {
                        await clearPendingUpdate();
                    }
                    if (toast?.showMainAutoUpdateResult) {
                        await toast.showMainAutoUpdateResult(currentVersion, remoteVersion, changes || '', false, dl.error);
                    }
                    return { ok: false, error: dl.error };
                }
                const result = await validateAndInstall(dl.code, remoteVersion, changes);
                if (!result.ok) {
                    console.error(`[CPM SafeUpdate] Install failed: ${result.error}`);
                    if (!isRetriableError(result.error || '')) {
                        await clearPendingUpdate();
                    }
                    const isSameVersionNoop = result.error && result.error.includes('이미 같은 버전');
                    if (!isSameVersionNoop && toast?.showMainAutoUpdateResult) {
                        await toast.showMainAutoUpdateResult(currentVersion, remoteVersion, changes || '', false, result.error);
                    }
                }
                return result;
            } catch (/** @type {any} */ unexpectedErr) {
                console.error(`[CPM SafeUpdate] Unexpected error:`, unexpectedErr);
                return { ok: false, error: `예기치 않은 오류: ${unexpectedErr.message || unexpectedErr}` };
            }
        })();

        try {
            return await _mainUpdateInFlight;
        } finally {
            _mainUpdateInFlight = null;
        }
    }

    // ── Boot retry lifecycle ──

    async function retryPendingUpdateOnBoot() {
        try {
            const pending = await readPendingUpdate();
            if (!pending) return false;

            const installedVersion = await getInstalledVersion();
            if (installedVersion && compareVersions(installedVersion, pending.version) <= 0) {
                console.log(`[CPM Retry] Pending main update already satisfied (${installedVersion} >= ${pending.version}). Clearing marker.`);
                await clearPendingUpdate();
                return true;
            }

            if (pending.attempts >= MAIN_UPDATE_RETRY_MAX_ATTEMPTS) {
                console.warn(`[CPM Retry] Pending main update exceeded max attempts (${pending.attempts}/${MAIN_UPDATE_RETRY_MAX_ATTEMPTS}). Clearing marker.`);
                await clearPendingUpdate();
                return false;
            }

            const elapsed = Date.now() - (pending.lastAttemptTs || 0);
            if (pending.lastAttemptTs && elapsed < MAIN_UPDATE_RETRY_COOLDOWN) {
                console.log(`[CPM Retry] Pending main update cooldown active (${Math.ceil((MAIN_UPDATE_RETRY_COOLDOWN - elapsed) / 1000)}s left).`);
                return false;
            }

            await writePendingUpdate({
                ...pending,
                attempts: (pending.attempts || 0) + 1,
                lastAttemptTs: Date.now(),
                lastError: '',
            });

            console.log(`[CPM Retry] Retrying pending main update on boot: ${installedVersion || 'unknown'} → ${pending.version}`);
            const result = await safeMainPluginUpdate(pending.version, pending.changes || '');
            if (!result.ok) {
                const latest = await readPendingUpdate();
                if (latest) {
                    await writePendingUpdate({
                        ...latest,
                        lastError: String(result.error || ''),
                    });
                }
            }
            return true;
        } catch (/** @type {any} */ e) {
            console.warn('[CPM Retry] Pending main update retry failed:', e.message || e);
            return false;
        }
    }

    // ── Manifest-based version check ──

    /** @type {boolean} */
    let _versionChecked = false;
    /** @type {boolean} */
    let _mainVersionFromManifest = false;

    /**
     * Check if the auto-update toggle is enabled.
     * Default is OFF — user must explicitly enable via plugin settings.
     * @returns {Promise<boolean>}
     */
    async function _isAutoUpdateEnabled() {
        try {
            const val = await Risu.getArgument(autoUpdateArgKey);
            if (val === true || val === 1) return true;
            const raw = String(val ?? '').trim().toLowerCase();
            return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
        } catch (_) {
            return false;
        }
    }

    async function checkVersionsQuiet() {
        try {
            if (_versionChecked) return;
            _versionChecked = true;

            // Auto-update toggle check (default OFF)
            if (!await _isAutoUpdateEnabled()) {
                console.log('[CPM AutoCheck] Auto-update is disabled (cpm_auto_update_enabled=off). Skipping.');
                return;
            }

            try {
                const lastCheck = await Risu.pluginStorage.getItem(VERSION_CHECK_STORAGE_KEY);
                if (lastCheck) {
                    const elapsed = Date.now() - parseInt(lastCheck, 10);
                    if (elapsed < VERSION_CHECK_COOLDOWN) {
                        console.log(`[CPM AutoCheck] Skipped — last check ${Math.round(elapsed / 60000)}min ago (cooldown: ${VERSION_CHECK_COOLDOWN / 60000}min)`);
                        return;
                    }
                }
            } catch (_) { /* pluginStorage not available */ }

            const cacheBuster = versionsUrl + '?_t=' + Date.now();
            console.log(`[CPM AutoCheck] Fetching version manifest...`);

            const fetchPromise = Risu.risuFetch(cacheBuster, { method: 'GET', plainFetchForce: true });
            const result = await _withTimeout(fetchPromise, 15000, 'Version manifest fetch timed out (15s)');

            if (!result.data || (result.status && result.status >= 400)) {
                console.warn(`[CPM AutoCheck] Fetch failed (status=${result.status}), silently skipped.`);
                return;
            }

            const manifest = (typeof result.data === 'string') ? JSON.parse(result.data) : result.data;
            if (!manifest || typeof manifest !== 'object') return;

            let mainUpdateInfo = null;
            const mainRemote = manifest[pluginName];
            if (mainRemote && mainRemote.version) {
                _mainVersionFromManifest = true;
                const mainCmp = compareVersions(currentVersion, mainRemote.version);
                if (mainCmp > 0) {
                    mainUpdateInfo = {
                        localVersion: currentVersion, remoteVersion: mainRemote.version,
                        changes: mainRemote.changes || '',
                    };
                    console.log(`[CPM AutoCheck] Main plugin update available: ${currentVersion}→${mainRemote.version}`);
                } else {
                    console.log(`[CPM AutoCheck] Main plugin is up to date (${currentVersion}).`);
                }
            }

            try {
                await Risu.pluginStorage.setItem(VERSION_CHECK_STORAGE_KEY, String(Date.now()));
            } catch (_) { /* ignore */ }

            if (mainUpdateInfo) {
                try { await rememberPendingUpdate(mainUpdateInfo.remoteVersion, mainUpdateInfo.changes); } catch (e) { console.warn('[CPM AutoCheck] rememberPendingUpdate failed:', e); }
                try { await safeMainPluginUpdate(mainUpdateInfo.remoteVersion, mainUpdateInfo.changes); } catch (e) { console.warn('[CPM AutoCheck] safeMainPluginUpdate failed:', e); }
            }
        } catch (/** @type {any} */ e) {
            console.debug(`[CPM AutoCheck] Silent error:`, e.message || e);
        }
    }

    // ── JS fallback version check ──

    /** @type {boolean} */
    let _mainVersionChecked = false;

    async function checkMainPluginVersionQuiet() {
        try {
            if (_mainVersionFromManifest) {
                console.log('[CPM MainAutoCheck] Already checked via manifest, skipping JS fallback.');
                return;
            }
            if (_mainVersionChecked) return;
            _mainVersionChecked = true;

            // Auto-update toggle check (default OFF)
            if (!await _isAutoUpdateEnabled()) {
                console.log('[CPM MainAutoCheck] Auto-update is disabled (cpm_auto_update_enabled=off). Skipping.');
                return;
            }

            try {
                const lastCheck = await Risu.pluginStorage.getItem(MAIN_VERSION_CHECK_STORAGE_KEY);
                if (lastCheck) {
                    const elapsed = Date.now() - parseInt(lastCheck, 10);
                    if (elapsed < VERSION_CHECK_COOLDOWN) {
                        console.log(`[CPM MainAutoCheck] Skipped — last check ${Math.round(elapsed / 60000)}min ago`);
                        return;
                    }
                }
            } catch (_) { /* ignore */ }

            const cacheBuster = mainUpdateUrl + '?_t=' + Date.now();
            console.log('[CPM MainAutoCheck] Fallback: fetching remote main plugin script...');

            let code;
            try {
                const response = await _withTimeout(
                    Risu.nativeFetch(cacheBuster, { method: 'GET' }),
                    20000, 'nativeFetch timed out (20s)'
                );
                if (!response.ok || response.status < 200 || response.status >= 300) {
                    console.warn(`[CPM MainAutoCheck] nativeFetch failed (HTTP ${response.status}), skipped.`);
                    return;
                }
                code = await _withTimeout(
                    response.text(),
                    20000, 'nativeFetch body read timed out (20s)'
                );
                console.log(`[CPM MainAutoCheck] nativeFetch OK (${(code.length / 1024).toFixed(1)}KB)`);
            } catch (/** @type {any} */ nativeErr) {
                console.warn(`[CPM MainAutoCheck] nativeFetch failed: ${nativeErr.message || nativeErr}, trying risuFetch...`);
                try {
                    const result = await _withTimeout(
                        Risu.risuFetch(cacheBuster, { method: 'GET', plainFetchForce: true }),
                        20000, 'risuFetch timed out (20s)'
                    );
                    if (!result.data || (result.status && result.status >= 400)) {
                        console.warn(`[CPM MainAutoCheck] risuFetch also failed (status=${result.status}), skipped.`);
                        return;
                    }
                    code = typeof result.data === 'string' ? result.data : String(result.data || '');
                    console.log(`[CPM MainAutoCheck] risuFetch OK (${(code.length / 1024).toFixed(1)}KB)`);
                } catch (/** @type {any} */ risuErr) {
                    console.warn(`[CPM MainAutoCheck] Both fetch methods failed: ${risuErr.message || risuErr}`);
                    return;
                }
            }
            const verMatch = code.match(/\/\/\s*@version\s+([^\r\n]+)/i);
            if (!verMatch) { console.warn('[CPM MainAutoCheck] Remote version tag not found in fetched code, skipped.'); return; }
            const changesMatch = code.match(/\/\/\s*@changes\s+(.+)/i);
            const cChanges = changesMatch ? changesMatch[1].trim() : '';

            const remoteVersion = (verMatch[1] || '').trim();
            const cmp = compareVersions(currentVersion, remoteVersion);

            try { await Risu.pluginStorage.setItem(MAIN_VERSION_CHECK_STORAGE_KEY, String(Date.now())); } catch (_) { /* ignore */ }

            if (cmp > 0) {
                console.log(`[CPM MainAutoCheck] Main update available: ${currentVersion}→${remoteVersion}`);
                try { await rememberPendingUpdate(remoteVersion, cChanges); } catch (_) { }
                const installResult = await validateAndInstall(code, remoteVersion, cChanges);
                if (!installResult.ok) {
                    console.warn(`[CPM MainAutoCheck] Direct install failed (${installResult.error}), trying fresh verified download...`);
                    await safeMainPluginUpdate(remoteVersion, cChanges);
                }
            } else {
                console.log('[CPM MainAutoCheck] Main plugin is up to date.');
            }
        } catch (/** @type {any} */ e) { console.debug('[CPM MainAutoCheck] Silent error:', e.message || e); }
    }

    // ── Public API ──
    return {
        // Core operations
        checkVersionsQuiet,
        checkMainPluginVersionQuiet,
        safeMainPluginUpdate,
        retryPendingUpdateOnBoot,
        downloadMainPluginCode,
        validateAndInstall,

        // Persistence
        readPendingUpdate,
        writePendingUpdate,
        clearPendingUpdate,
        rememberPendingUpdate,

        // Utilities
        getInstalledVersion,

        // Auto-update toggle check
        _isAutoUpdateEnabled,

        // Constants (for testing)
        _constants: {
            VERSION_CHECK_COOLDOWN,
            MAIN_UPDATE_RETRY_COOLDOWN,
            MAIN_UPDATE_RETRY_MAX_ATTEMPTS,
            VERSION_CHECK_STORAGE_KEY,
            MAIN_VERSION_CHECK_STORAGE_KEY,
            MAIN_UPDATE_RETRY_STORAGE_KEY,
            AUTO_UPDATE_ARG_KEY: autoUpdateArgKey,
        },
    };
}
