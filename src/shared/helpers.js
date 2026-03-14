// @ts-nocheck — helpers.js는 RisuAI 런타임 API(risuFetch, nativeFetch 등) 의존도가 높아
// 완전한 타입 체크가 비현실적입니다. 향후 RisuAI d.ts가 제공되면 활성화 예정.
// helpers.js — Shared: 범용 헬퍼 함수
// 빌드 시 각 플러그인에 인라인됩니다.

import { getRisu } from './ipc-protocol.js';

/**
 * RisuAI argument 안전 조회
 * @param {string} key 인수 키
 * @param {string} [defaultValue=''] 기본값
 * @returns {Promise<string>}
 */
export async function safeGetArg(key, defaultValue = '') {
    try {
        const Risu = getRisu();
        const val = await Risu.getArgument(key);
        return val !== undefined && val !== null && val !== '' ? val : defaultValue;
    } catch {
        return defaultValue;
    }
}

/**
 * RisuAI boolean argument 안전 조회 (true/false/yes/no/1/0 자동 변환)
 * @param {string} key 인수 키
 * @param {boolean} [defaultValue=false] 기본값
 * @returns {Promise<boolean>}
 */
export async function safeGetBoolArg(key, defaultValue = false) {
    try {
        const Risu = getRisu();
        const val = await Risu.getArgument(key);
        if (val === true || val === false) return val;
        const raw = String(val ?? '').trim().toLowerCase();
        if (!raw || raw === 'undefined' || raw === 'null') return defaultValue;
        if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
        if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
        return defaultValue;
    } catch {
        return defaultValue;
    }
}

/**
 * RisuAI argument 설정 (실패 시 경고 출력)
 * @param {string} key 인수 키
 * @param {unknown} value 설정할 값
 */
export function setArg(key, value) {
    try {
        const Risu = getRisu();
        Risu.setArgument(key, value);
    } catch (e) {
        console.warn('[CPM] setArg failed:', key, e.message);
    }
}

/**
 * HTML 특수문자 이스케이프 — XSS 방지
 * @param {string} str 원본 문자열
 * @returns {string} 이스케이프된 문자열
 */
export function escHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 메시지 content part에서 이미지 URL 추출
 * @param {object} part content part 객체
 * @returns {string} 이미지 URL 또는 빈 문자열
 */
export function extractImageUrlFromPart(part) {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'image_url') {
        if (typeof part.image_url === 'string') return part.image_url;
        if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string') return part.image_url.url;
    }
    if (part.type === 'input_image') {
        if (typeof part.image_url === 'string') return part.image_url;
        if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string') return part.image_url.url;
    }
    return '';
}

/**
 * JSON 직렬화 (배열 내 null 요소 자동 제거)
 * @param {unknown} obj 직렬화할 객체
 * @returns {string}
 */
export function safeStringify(obj) {
    return JSON.stringify(obj, function (_key, value) {
        if (Array.isArray(value)) {
            return value.filter(function (item) { return item != null; });
        }
        return value;
    });
}

function getHeaderValue(headers, key) {
    if (!headers) return '';
    const lowerKey = String(key || '').toLowerCase();
    try {
        if (typeof headers.get === 'function') {
            return headers.get(lowerKey) || headers.get(key) || '';
        }
    } catch { }
    return headers[key] || headers[lowerKey] || '';
}

function hasHeaders(headers) {
    if (!headers) return false;
    try {
        if (typeof headers.forEach === 'function') {
            let found = false;
            headers.forEach(() => { found = true; });
            return found;
        }
    } catch { }
    return Object.keys(headers).length > 0;
}

/**
 * 재귀적 직렬화 불가능 필드 제거 (function, Symbol, BigInt 등)
 * postMessage 경계에서 DataCloneError 방지
 * @param {unknown} obj 대상 객체
 * @param {number} [depth=0] 현재 깊이
 * @returns {unknown} 정화된 객체
 */
export function _stripNonSerializable(obj, depth = 0) {
    if (depth > 15) return obj;
    if (obj === null || obj === undefined) return obj;
    const t = typeof obj;
    if (t === 'function' || t === 'symbol' || t === 'bigint') return undefined;
    if (t !== 'object') return obj;
    if (obj instanceof Date || obj instanceof RegExp || obj instanceof Error) return String(obj);
    if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) return obj;
    if (Array.isArray(obj)) {
        return obj.map(item => _stripNonSerializable(item, depth + 1)).filter(item => item !== undefined);
    }
    const result = {};
    for (const key of Object.keys(obj)) {
        const val = _stripNonSerializable(obj[key], depth + 1);
        if (val !== undefined) result[key] = val;
    }
    return result;
}

function sanitizeBodyForBridge(bodyObj) {
    if (!bodyObj || typeof bodyObj !== 'object') return bodyObj;
    let safe = _stripNonSerializable(bodyObj);
    if (Array.isArray(safe.messages)) {
        try {
            const rawMsgs = JSON.parse(JSON.stringify(safe.messages));
            safe.messages = [];
            for (const rawMsg of rawMsgs) {
                if (!rawMsg || typeof rawMsg !== 'object') continue;
                if (typeof rawMsg.role !== 'string' || !rawMsg.role) continue;
                if (rawMsg.content === null || rawMsg.content === undefined) continue;
                const msg = { role: rawMsg.role, content: rawMsg.content };
                if (typeof rawMsg.name === 'string' && rawMsg.name) msg.name = rawMsg.name;
                safe.messages.push(msg);
            }
        } catch {
            safe.messages = safe.messages.filter(m => m != null && typeof m === 'object');
        }
    }
    if (Array.isArray(safe.contents)) {
        try { safe.contents = JSON.parse(JSON.stringify(safe.contents)); } catch { }
        safe.contents = safe.contents.filter(m => m != null && typeof m === 'object');
    }
    try {
        return JSON.parse(JSON.stringify(safe));
    } catch {
        return safe;
    }
}

function toResponseBody(data, status) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
        return new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
    }
    if (Array.isArray(data)) return new Uint8Array(data);
    if (typeof data === 'object' && data && !(data instanceof Blob) && typeof data.length === 'number') {
        try { return new Uint8Array(Array.from(data)); } catch { return null; }
    }
    if (typeof data === 'string' && status && status !== 0) {
        return new TextEncoder().encode(data);
    }
    return null;
}

/**
 * smartFetch — 2단계 폴백 전략으로 proxy2 지역 차단 우회
 *
 * Strategy 1: risuFetch + plainFetchForce
 *   → 호스트 윈도우에서 직접 fetch() — proxy2 우회, 유저 브라우저 IP 사용
 *   → CORS 지원 API만 성공 (Anthropic, Gemini, 일부 OpenAI 호환)
 *   → CORS 실패 시 헤더 없는 빈 응답 → 자동으로 Strategy 2로 폴백
 *
 * Strategy 2: nativeFetch (proxy2 경유 — 폴백)
 *   → sv.risuai.xyz/proxy2 프록시 서버 통해 요청
 *
 * @param {string} url - 요청 URL
 * @param {object} options - { method, headers, body (string), signal? }
 * @returns {Promise<Response>} 표준 Response 객체
 */
export async function smartFetch(url, options = {}) {
    const Risu = getRisu();

    // ─── BUG-1 FIX: AbortSignal은 structured-clone 불가 ───
    // AbortSignal을 Risu.risuFetch()/nativeFetch() 브릿지 호출에 포함하면
    // postMessage가 DataCloneError를 발생시킴.
    // signal을 추출하여 로컬 abort 체크에만 사용하고, 브릿지 옵션에서는 제거.
    const _localAbortSignal = options.signal;
    options = { ...options };
    delete options.signal;

    // Pre-flight abort check
    if (_localAbortSignal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // non-JSON body(예: application/x-www-form-urlencoded)는 risuFetch가
    // JSON.stringify 하므로 직접 fetch 전략을 건너뜀
    const ct = getHeaderValue(options.headers, 'content-type') || '';
    const isJson = !ct || ct.includes('application/json');

    // Copilot API: nativeFetch first (CORS not reliably supported)
    const isCopilotUrl = url.includes('githubcopilot.com') || url.includes('copilot_internal');
    if (isCopilotUrl) {
        // Strategy A: nativeFetch (proxy-based, bypasses CORS)
        try {
            const nfOptions = { ...options };
            // Encode body as Uint8Array to prevent bridge serialization corruption
            // (string bodies can be corrupted by postMessage bridge,
            //  causing "request body is not valid JSON" errors)
            if (typeof nfOptions.body === 'string') {
                nfOptions.body = new TextEncoder().encode(nfOptions.body);
            }
            const nativeRes = await Risu.nativeFetch(url, nfOptions);
            if (nativeRes && (nativeRes.ok || (nativeRes.status && nativeRes.status !== 0))) {
                // For 4xx client errors, return as-is so caller sees exact error
                try {
                    const clonedRes = nativeRes.clone();
                    const bodyText = await clonedRes.text();
                    if (bodyText && bodyText.length > 0) {
                        console.log(`[smartFetch] ✓ Copilot nativeFetch: status=${nativeRes.status} for ${url.substring(0, 60)}`);
                        return new Response(bodyText, {
                            status: nativeRes.status,
                            statusText: nativeRes.statusText,
                            headers: nativeRes.headers
                        });
                    }
                } catch { /* fall through */ }
                return nativeRes;
            }
        } catch (e) {
            console.log(`[smartFetch] Copilot nativeFetch error: ${e.message}, trying fallback`);
        }

        // Strategy B: risuFetch with proxy forced (plainFetchDeforce)
        if (typeof Risu.risuFetch === 'function') {
            try {
                let bodyObj;
                if (options.body && typeof options.body === 'string') {
                    try {
                        bodyObj = JSON.parse(options.body);
                    } catch {
                        // CRITICAL: Do NOT pass raw string to risuFetch
                        // (risuFetch would JSON.stringify it again → double-quoted → "not valid JSON")
                        console.error('[smartFetch] Copilot proxy-forced: body JSON.parse failed, skipping');
                        throw new Error('Body JSON parse failed');
                    }
                } else { bodyObj = options.body; }

                bodyObj = sanitizeBodyForBridge(bodyObj);

                const result = await Risu.risuFetch(url, {
                    method: options.method || 'POST',
                    headers: options.headers || {},
                    body: bodyObj,
                    rawResponse: true,
                    plainFetchDeforce: true,
                });
                if (result && result.data != null && (result.status && result.status !== 0)) {
                    const responseBody = toResponseBody(result.data, result.status);
                    if (!responseBody) throw new Error('Invalid proxy-forced response body');
                    console.log(`[smartFetch] ✓ Copilot proxy-forced: status=${result.status} for ${url.substring(0, 60)}`);
                    return new Response(responseBody, {
                        status: result.status || 200,
                        headers: new Headers(result.headers || {})
                    });
                }
                // 4xx with null data — construct minimal error response
                if (result && result.status >= 400 && result.status < 500) {
                    console.warn(`[smartFetch] Copilot proxy-forced: 4xx status=${result.status} with no body`);
                    return new Response(JSON.stringify({ error: `HTTP ${result.status}` }), {
                        status: result.status,
                        headers: new Headers({ 'content-type': 'application/json' })
                    });
                }
            } catch (e) {
                console.log(`[smartFetch] Copilot proxy-forced error: ${e.message}`);
            }
        }

        // Strategy C: risuFetch with direct fetch (plainFetchForce) as last resort
        if (typeof Risu.risuFetch === 'function') {
            try {
                let bodyObj;
                if (options.body && typeof options.body === 'string') {
                    try {
                        bodyObj = JSON.parse(options.body);
                    } catch {
                        console.error('[smartFetch] Copilot plainFetch: body JSON.parse failed, skipping');
                        throw new Error('Body JSON parse failed');
                    }
                } else { bodyObj = options.body; }

                bodyObj = sanitizeBodyForBridge(bodyObj);

                const result = await Risu.risuFetch(url, {
                    method: options.method || 'POST',
                    headers: options.headers || {},
                    body: bodyObj,
                    rawResponse: true,
                    plainFetchForce: true,
                });
                if (result && result.data != null) {
                    const hasRealHeaders = hasHeaders(result.headers);
                    // Return when: real headers exist, OR request succeeded, OR status is 4xx (real API error)
                    if (hasRealHeaders || result.ok || (result.status >= 400 && result.status < 500)) {
                        const responseBody = toResponseBody(result.data, result.status);
                        if (!responseBody) throw new Error('Invalid plainFetch response body');
                        console.log(`[smartFetch] ✓ Copilot plainFetch: status=${result.status} for ${url.substring(0, 60)}`);
                        return new Response(responseBody, {
                            status: result.status || 200,
                            headers: new Headers(result.headers || {})
                        });
                    }
                }
                // 4xx with null data
                if (result && result.status >= 400 && result.status < 500) {
                    return new Response(JSON.stringify({ error: `HTTP ${result.status}` }), {
                        status: result.status,
                        headers: new Headers({ 'content-type': 'application/json' })
                    });
                }
            } catch (e) {
                console.log(`[smartFetch] Copilot plainFetch error: ${e.message}`);
            }
        }

        // All Copilot strategies failed — fall through to generic path
    }

    // Strategy 1: risuFetch + plainFetchForce (호스트 브라우저에서 직접 API 호출)
    if (isJson && typeof Risu.risuFetch === 'function') {
        try {
            // body를 object로 복원 (risuFetch → fetchWithPlainFetch가 JSON.stringify 함)
            let bodyObj;
            if (options.body && typeof options.body === 'string') {
                try {
                    bodyObj = JSON.parse(options.body);
                } catch {
                    // Do NOT pass raw string to risuFetch — would cause double-stringify
                    console.error('[smartFetch] risuFetch: body JSON.parse failed, skipping to nativeFetch');
                    throw new Error('Body JSON parse failed — cannot safely pass to risuFetch');
                }
            } else {
                bodyObj = options.body;
            }

            // 직렬화 안전 보증 (postMessage 경유 시)
            bodyObj = sanitizeBodyForBridge(bodyObj);

            const result = await Risu.risuFetch(url, {
                method: options.method || 'POST',
                headers: options.headers || {},
                body: bodyObj,
                rawResponse: true,
                plainFetchForce: true,
            });

            if (result && result.data != null) {
                // 실제 API 응답 vs 로컬/CORS 에러 구분:
                //   실제 응답 → result.headers에 서버 헤더 포함
                //   CORS 에러 → headers는 빈 객체 {}, status=400
                const hasRealHeaders = hasHeaders(result.headers);

                if (hasRealHeaders || result.ok) {
                    const responseBody = toResponseBody(result.data, result.status);
                    if (!responseBody) throw new Error('Invalid direct response body');

                    console.log(`[smartFetch] ✓ Direct fetch: status=${result.status} for ${url.substring(0, 60)}`);
                    return new Response(responseBody, {
                        status: result.status || 200,
                        headers: new Headers(result.headers || {})
                    });
                }
            }

            console.log(`[smartFetch] Direct fetch unusable, falling back to proxy`);
        } catch (e) {
            console.log(`[smartFetch] Direct fetch error: ${e.message}, falling back to proxy`);
        }
    }

    // Strategy 2: nativeFetch (proxy2 경유)
    // nativeFetch는 CALLBACK_STREAMS를 통해 Response를 반환하지만,
    // ReadableStream 전송 실패 시 body가 깨질 수 있으므로 방어 처리
    const nfOptions = { ...options };
    // Encode body as Uint8Array to prevent bridge serialization corruption
    if (typeof nfOptions.body === 'string') {
        nfOptions.body = new TextEncoder().encode(nfOptions.body);
    }
    if (typeof Risu.nativeFetch !== 'function') {
        try {
            return await fetch(url, options);
        } catch {
            throw new Error(`[smartFetch] nativeFetch unavailable and direct fetch failed for ${url.substring(0, 60)}`);
        }
    }
    // BUG-2 FIX: nativeFetch를 try-catch로 감싸기 (DataCloneError, bridge 끊김 등 방어)
    try {
        const nativeRes = await Risu.nativeFetch(url, nfOptions);
        // BUG-S6-7 FIX: 기존 clone→text→reconstruct 패턴 대신 간소화된 검증 사용
        // (기존: 전체 body를 text로 읽어 메모리에 2중 적재. 대형 응답 시 비효율적)
        // 유효한 Response인지 간단히 확인 후 반환.
        // Response body 정상 여부는 caller가 .json()/.text() 시 자연스럽게 확인됨.
        if (nativeRes && typeof nativeRes.status === 'number' && nativeRes.status !== 0) {
            return nativeRes;
        }
        // status=0 또는 nativeRes 없음 → bridge 실패로 간주
        console.log(`[smartFetch] nativeFetch returned invalid response (status=${nativeRes?.status})`);
        throw new Error('nativeFetch returned invalid response');
    } catch (e) {
        console.error(`[smartFetch] nativeFetch threw: ${e.message}`);
        throw new Error(`[smartFetch] All fetch strategies failed for ${url.substring(0, 60)}: ${e.message}`);
    }
}

/**
 * streamingFetch — 스트리밍 전용 fetch. body를 소비하지 않고 raw Response 반환.
 *
 * smartFetch와 달리 Response body(ReadableStream)를 건드리지 않으므로
 * SSE 스트리밍 파싱에 사용 가능.
 *
 * 전략:
 *   1. fetch() 직접 — iframe CSP가 허용하면 가장 빠름 (CORS 필수)
 *   2. Risu.nativeFetch() — V3 bridge 경유, Response 객체 반환
 *      (bridge가 ReadableStream 전송을 지원하면 body 스트리밍 가능)
 *
 * @param {string} url
 * @param {object} options - { method, headers, body (string), signal? }
 * @returns {Promise<Response>}
 */
export async function streamingFetch(url, options = {}) {
    const Risu = getRisu();

    // ─── BUG-1 FIX: AbortSignal은 structured-clone 불가 ───
    // bridge 호출(risuFetch/nativeFetch)에서 AbortSignal을 제거.
    // signal은 Strategy 1 (직접 fetch)에서만 안전하게 사용 가능.
    const _localAbortSignal = options.signal;
    options = { ...options };
    delete options.signal;

    // Pre-flight abort check
    if (_localAbortSignal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // ─── BUG-S6-2 FIX: V3 iframe CSP `connect-src 'none'`으로 인해
    //     직접 fetch()는 항상 실패함. bridge API 가용 시 건너뜀.
    //     (Tauri/Node/Web 모든 플랫폼에서 iframe CSP 적용)
    const hasBridgeFetch = typeof Risu.nativeFetch === 'function' || typeof Risu.risuFetch === 'function';
    if (!hasBridgeFetch) {
        // Bridge 미가용 (비정상 상황) — direct fetch 시도
        try {
            const res = await fetch(url, { ...options, signal: _localAbortSignal });
            return res;
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.log(`[streamingFetch] Direct fetch failed (no bridge): ${e.message}`);
        }
    }

    // ─── BUG-S6-1 FIX: nativeFetch 단일 호출 (Copilot/일반 통합)
    //     기존: Copilot 전용 블록 + 일반 블록에서 동일 nativeFetch 중복 호출
    //     수정: 단일 nativeFetch 호출로 통합
    if (typeof Risu.nativeFetch === 'function') {
        try {
            const nfOptions = { ...options };
            // Encode body as Uint8Array to prevent bridge serialization corruption
            if (typeof nfOptions.body === 'string') {
                nfOptions.body = new TextEncoder().encode(nfOptions.body);
            }
            const res = await Risu.nativeFetch(url, nfOptions);
            if (res && (res.ok || (res.status && res.status !== 0))) {
                console.log(`[streamingFetch] ✓ nativeFetch: status=${res.status} for ${url.substring(0, 60)}`);
                return res;
            }
        } catch (e) {
            console.log(`[streamingFetch] nativeFetch error: ${e.message}`);
        }
    }

    // Strategy 3: risuFetch proxy fallback (body will be fully read — streaming degraded)
    // ─── BUG-S6-8 FIX: 스트리밍 저하 경고 출력
    if (typeof Risu.risuFetch === 'function') {
        try {
            let bodyObj;
            if (options.body && typeof options.body === 'string') {
                try {
                    bodyObj = JSON.parse(options.body);
                } catch {
                    // Do NOT pass raw string — would cause double-stringify
                    console.error('[streamingFetch] risuFetch: body JSON.parse failed, skipping');
                    throw new Error('Body JSON parse failed');
                }
            } else { bodyObj = options.body; }

            bodyObj = sanitizeBodyForBridge(bodyObj);

            const result = await Risu.risuFetch(url, {
                method: options.method || 'POST',
                headers: options.headers || {},
                body: bodyObj,
                rawResponse: true,
                plainFetchDeforce: true,
            });
            if (result && result.data != null) {
                let responseBody = null;
                if (result.data instanceof Uint8Array) {
                    responseBody = result.data;
                } else if (ArrayBuffer.isView(result.data) || result.data instanceof ArrayBuffer) {
                    responseBody = new Uint8Array(result.data instanceof ArrayBuffer ? result.data : result.data.buffer);
                } else if (Array.isArray(result.data)) {
                    responseBody = new Uint8Array(result.data);
                } else if (typeof result.data === 'object' && result.data && !(result.data instanceof Blob) && typeof result.data.length === 'number') {
                    try { responseBody = new Uint8Array(Array.from(result.data)); } catch { }
                } else if (typeof result.data === 'string') {
                    responseBody = new TextEncoder().encode(result.data);
                }
                if (responseBody) {
                    console.warn(`[streamingFetch] ⚠ risuFetch 폴백 사용 — 스트리밍 저하 (응답 전체 수집 후 반환). nativeFetch 실패 원인을 확인하세요.`);
                    console.log(`[streamingFetch] ✓ risuFetch proxy: status=${result.status}`);
                    return new Response(responseBody, {
                        status: result.status || 200,
                        headers: new Headers(result.headers || {})
                    });
                }
            }
        } catch (e) {
            console.log(`[streamingFetch] risuFetch proxy error: ${e.message}`);
        }
    }

    throw new Error(`[streamingFetch] All fetch strategies failed for ${url.substring(0, 60)}`);
}

/**
 * collectStream — ReadableStream<string>을 단일 문자열로 수집
 * 브릿지가 ReadableStream 전송을 지원하지 않을 때 폴백으로 사용
 *
 * BUG-S6-3 FIX: abortSignal 파라미터 추가 — abort 시 즉시 수집 중단
 * (기존: abort 체크 없이 스트림 종료까지 무조건 대기)
 */
export async function collectStream(stream, abortSignal) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    try {
        while (true) {
            if (abortSignal?.aborted) {
                reader.cancel();
                break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value == null) continue;
            if (typeof value === 'string') { result += value; continue; }
            if (value instanceof Uint8Array) { result += decoder.decode(value, { stream: true }); continue; }
            if (value instanceof ArrayBuffer) { result += decoder.decode(new Uint8Array(value), { stream: true }); continue; }
            result += String(value);
        }
        result += decoder.decode(); // TextDecoder flush
    } catch (e) {
        if (e.name !== 'AbortError') throw e;
    }
    return result;
}

/**
 * checkStreamCapability — V3 iframe bridge가 ReadableStream 전송을 지원하는지 감지
 * 결과는 캐시됨 (한 번만 검사)
 *
 * 배경: Guest-side collectTransferables에는 ReadableStream이 포함되어 있지 않아
 * (factory.ts L93-108: ArrayBuffer, MessagePort, ImageBitmap, OffscreenCanvas만 처리)
 * transfer list를 통한 ReadableStream 전송은 불가. 다만 Chromium 116+ 에서는
 * ReadableStream이 structured-cloneable이므로 transfer list 없이도 postMessage 가능.
 * 이 함수는 현재 브라우저에서 structured-clone이 가능한지 테스트합니다.
 */
let _streamBridgeCapable = null;
export async function checkStreamCapability() {
    if (_streamBridgeCapable !== null) return _streamBridgeCapable;

    // ReadableStream이 structured-clone 가능한지 테스트 (transfer list 없이)
    // Chromium 116+: ✓ structured-cloneable (CALLBACK_RETURN에서 guest→host 전달 가능)
    // Older browsers / Firefox < some version: ✗ (DataCloneError → string fallback)
    try {
        const s1 = new ReadableStream({ start(c) { c.close(); } });
        const mc1 = new MessageChannel();
        const cloneable = await new Promise(resolve => {
            const timer = setTimeout(() => { resolve(false); try { mc1.port1.close(); mc1.port2.close(); } catch {} }, 500);
            mc1.port2.onmessage = () => { clearTimeout(timer); resolve(true); mc1.port1.close(); mc1.port2.close(); };
            mc1.port2.onmessageerror = () => { clearTimeout(timer); resolve(false); mc1.port1.close(); mc1.port2.close(); };
            try { mc1.port1.postMessage({ s: s1 }); }
            catch { clearTimeout(timer); resolve(false); }
        });
        if (cloneable) {
            _streamBridgeCapable = true;
            console.log('[CPM] ReadableStream is structured-cloneable — streaming enabled.');
            return true;
        }
    } catch { /* fall through */ }

    _streamBridgeCapable = false;
    console.log('[CPM] ReadableStream NOT structured-cloneable. Falling back to string responses.');
    return false;
}
