// @ts-check
/**
 * safe-db-writer.js — setDatabaseLite 보안 래퍼
 *
 * setDatabaseLite는 RisuAI 내부에서 DBState.db에 직접 기록하며
 * 유효성 검증이 전혀 없기 때문에, CPM 측에서 호출 전 반드시
 * 입력 데이터를 검증해야 합니다.
 *
 * 방어 대상 (FINAL_MIGRATION_REPORT.md §2.1):
 *  1. 무단 플러그인 설치 (보안 게이트 우회)
 *  2. guiHTML / customCSS 주입 (XSS)
 *  3. characters 배열 조작 (데이터 변조)
 *  4. 기존 플러그인 스크립트 교체 (검증 없이)
 *  5. 설정값 대량 변경
 *  6. 자동 업데이트 URL 변조
 */

const LOG = '[CPM SafeDB]';

// ── CPM이 수정 가능한 키 허용 목록 ──
// CPM은 현재 plugins 키만 사용함. 필요 시 추가.
const ALLOWED_KEYS = new Set(['plugins']);

// ── 절대 수정 불가 키 (XSS / 데이터 조작 벡터) ──
const BLOCKED_KEYS = new Set(['guiHTML', 'customCSS', 'characters']);

// ── 플러그인 객체 필수 필드 ──
const REQUIRED_PLUGIN_FIELDS = ['name', 'script', 'version'];

/**
 * 플러그인 객체 하나를 검증합니다.
 * @param {any} plugin
 * @param {number} index
 * @returns {{ valid: boolean, reason?: string }}
 */
function validatePlugin(plugin, index) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
        return { valid: false, reason: `plugins[${index}]: not a valid object` };
    }
    for (const field of REQUIRED_PLUGIN_FIELDS) {
        if (typeof plugin[field] !== 'string' || plugin[field].trim() === '') {
            return { valid: false, reason: `plugins[${index}].${field}: missing or empty string` };
        }
    }
    // API 버전 검증: CPM은 v3.0 플러그인만 다룸
    if (plugin.version !== '3.0') {
        return { valid: false, reason: `plugins[${index}].version: expected '3.0', got '${plugin.version}'` };
    }
    // name은 합리적 길이로 제한 (인젝션 방지)
    if (plugin.name.length > 200) {
        return { valid: false, reason: `plugins[${index}].name: exceeds 200 chars` };
    }
    // updateURL이 있으면 https만 허용
    if (plugin.updateURL && typeof plugin.updateURL === 'string' && plugin.updateURL.trim() !== '') {
        const url = plugin.updateURL.trim();
        if (!url.startsWith('https://')) {
            return { valid: false, reason: `plugins[${index}].updateURL: only https:// allowed, got '${url.slice(0, 50)}'` };
        }
    }
    return { valid: true };
}

/**
 * setDatabaseLite 입력 데이터를 검증합니다.
 *
 * @param {Record<string, any>} patch - setDatabaseLite에 전달할 데이터
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDbPatch(patch) {
    /** @type {string[]} */
    const errors = [];

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, errors: ['patch must be a plain object'] };
    }

    const keys = Object.keys(patch);
    if (keys.length === 0) {
        return { ok: false, errors: ['patch has no keys'] };
    }

    for (const key of keys) {
        // 차단 키 검사
        if (BLOCKED_KEYS.has(key)) {
            errors.push(`key '${key}' is blocked (XSS/data-manipulation vector)`);
            continue;
        }
        // 허용 키 검사
        if (!ALLOWED_KEYS.has(key)) {
            errors.push(`key '${key}' is not in the allowed list: [${[...ALLOWED_KEYS].join(', ')}]`);
            continue;
        }

        // 키별 값 검증
        if (key === 'plugins') {
            const plugins = patch[key];
            if (!Array.isArray(plugins)) {
                errors.push(`'plugins' must be an array`);
                continue;
            }
            // 빈 배열은 모든 플러그인 삭제 = 매우 위험
            if (plugins.length === 0) {
                errors.push(`'plugins' array is empty — would delete all plugins`);
                continue;
            }
            for (let i = 0; i < plugins.length; i++) {
                const result = validatePlugin(plugins[i], i);
                if (!result.valid) {
                    errors.push(result.reason || `plugins[${i}]: validation failed`);
                }
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

/**
 * setDatabaseLite를 검증 후 안전하게 호출합니다.
 *
 * @param {import('./types.js').RisuAPI} risu - RisuAI API 인스턴스
 * @param {Record<string, any>} patch - 기록할 데이터 (예: { plugins: [...] })
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function safeSetDatabaseLite(risu, patch) {
    const validation = validateDbPatch(patch);
    if (!validation.ok) {
        const msg = `Rejected: ${validation.errors.join('; ')}`;
        console.error(`${LOG} ${msg}`);
        return { ok: false, error: msg };
    }

    try {
        await risu.setDatabaseLite(patch);
        return { ok: true };
    } catch (/** @type {any} */ err) {
        const msg = `Write failed: ${err?.message || err}`;
        console.error(`${LOG} ${msg}`);
        return { ok: false, error: msg };
    }
}
