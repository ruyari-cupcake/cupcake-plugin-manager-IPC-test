/**
 * @fileoverview Vertex AI Service Account authentication module (IPC version).
 * Migrated from _temp_repo/src/lib/vertex-auth.js.
 * Handles: SA JSON parsing → JWT generation → OAuth token exchange → caching.
 */
import { getRisu } from './ipc-protocol.js';

/** @type {Map<string, {token:string, expiresAt:number}>} */
const _tokenCaches = new Map();

/**
 * Check if a string looks like a Windows file path (common user mistake).
 * @param {string} raw
 * @returns {boolean}
 */
function _looksLikeWindowsPath(raw) {
    const trimmed = (raw || '').trim();
    return /^[A-Za-z]:\\/.test(trimmed) || /^\\\\[^\\]/.test(trimmed);
}

/**
 * base64url encoding (no padding).
 * @param {string} str
 * @returns {string}
 */
function base64url(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parse and validate Service Account JSON.
 * @param {string} jsonStr
 * @returns {{ client_email: string, private_key: string, project_id: string }}
 */
export function parseServiceAccountJson(jsonStr) {
    const trimmed = (jsonStr || '').trim();
    if (!trimmed) throw new Error('Service Account JSON이 비어 있습니다.');
    if (_looksLikeWindowsPath(trimmed)) {
        throw new Error('파일 경로가 아닌 JSON 본문을 입력하세요.');
    }

    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        if (/Bad Unicode escape/i.test(/** @type {Error} */(e).message)) {
            throw new Error('JSON 파싱 오류: 역슬래시(\\) 이스케이프 문제. JSON 본문을 그대로 붙여넣으세요.');
        }
        throw new Error(`JSON 파싱 오류: ${/** @type {Error} */(e).message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON 객체 형식이어야 합니다.');
    }
    if (!parsed.client_email || !parsed.private_key) {
        throw new Error('client_email 또는 private_key가 누락되었습니다.');
    }
    if (!parsed.private_key.includes('-----BEGIN') || !parsed.private_key.includes('PRIVATE KEY-----')) {
        throw new Error('private_key가 유효한 PEM 형식이 아닙니다.');
    }
    return parsed;
}

/**
 * Quick heuristic check: does this string look like a Service Account JSON?
 * @param {string} str
 * @returns {boolean}
 */
export function looksLikeServiceAccountJson(str) {
    if (!str || typeof str !== 'string') return false;
    const t = str.trim();
    if (!t.startsWith('{')) return false;
    try {
        const obj = JSON.parse(t);
        return obj.type === 'service_account' && !!obj.client_email && !!obj.private_key;
    } catch { return false; }
}

/**
 * Get a valid Bearer token + projectId for Vertex AI.
 * Uses cache (60s buffer), generates JWT + exchanges if needed.
 * @param {string} saJsonStr - Raw Service Account JSON string
 * @returns {Promise<{token: string, projectId: string}>} Access token + project ID
 */
export async function getVertexBearerToken(saJsonStr) {
    const key = parseServiceAccountJson(saJsonStr);
    const projectId = key.project_id || '';
    const cacheKey = key.client_email || 'default';
    const cached = _tokenCaches.get(cacheKey);

    if (cached && cached.expiresAt > Date.now() + 60000) {
        return { token: cached.token, projectId };
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    }));
    const sigInput = `${header}.${payload}`;

    // PEM → ArrayBuffer
    const pemBody = key.private_key
        .replace(/-----BEGIN .*?-----/g, '')
        .replace(/-----END .*?-----/g, '')
        .replace(/\s/g, '');
    const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    // WebKit/Safari fix: .slice(0) creates owned ArrayBuffer copy
    const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', binaryKey.buffer.slice(0),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );
    const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', cryptoKey,
        new TextEncoder().encode(sigInput)
    );
    const sigB64 = base64url(String.fromCharCode(...new Uint8Array(sig)));
    const jwt = `${sigInput}.${sigB64}`;

    // Exchange JWT for access token
    const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const Risu = getRisu();
    const res = await Risu.nativeFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new TextEncoder().encode(tokenBody)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Vertex OAuth 토큰 교환 실패: ${errText}`);
    }

    const data = await res.json();
    if (!data?.access_token) throw new Error('Vertex OAuth 토큰 교환 실패: access_token 없음');

    _tokenCaches.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + 3500000 });
    return { token: data.access_token, projectId };
}

/**
 * Invalidate cached token for a specific service account.
 * @param {string} saJsonStr
 */
export function invalidateTokenCache(saJsonStr) {
    try {
        const key = parseServiceAccountJson(saJsonStr);
        _tokenCaches.delete(key.client_email || 'default');
    } catch { /* ignore */ }
}

/**
 * Clear all cached tokens.
 */
export function clearAllTokenCaches() {
    _tokenCaches.clear();
}
