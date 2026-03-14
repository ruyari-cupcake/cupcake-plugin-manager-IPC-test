/**
 * ipc-protocol.js — Plugin Channel IPC 프로토콜 정의
 *
 * RisuAI Plugin Channel API (실제 시그니처):
 *   addPluginChannelListener(channelName, callback)
 *     → 내부 키: 내_플러그인이름 + channelName
 *   postPluginChannelMessage(대상_플러그인이름, channelName, message)
 *     → 내부 키: 대상_플러그인이름 + channelName → callback(message)
 *
 * 즉, 리스너는 "내 이름 + 채널명"으로 등록되고,
 * 보내는 쪽은 "상대 이름 + 채널명"으로 찾아서 호출합니다.
 * Plugin name = //@name 메타데이터 값.
 */

// ── 플러그인 이름 (반드시 //@name 과 동일해야 함) ──
export const MANAGER_NAME = 'Cupcake Provider Manager';

// ── 채널 이름 (단순 문자열 — 라우팅은 플러그인 이름으로) ──
export const CH = {
    CONTROL:  'control',   // 매니저가 리슨. 서브플러그인이 등록/상태 전송.
    RESPONSE: 'response',  // 매니저가 리슨. 서브플러그인이 fetch 응답 전송.
    FETCH:    'fetch',      // 서브플러그인이 리슨. 매니저가 fetch 요청 전송.
    ABORT:    'abort',      // 서브플러그인이 리슨. 매니저가 중단 신호 전송.
};

// ── 메시지 타입 ──
export const MSG = {
    // 등록
    REGISTER_PROVIDER: 'register-provider',
    REGISTER_ACK:      'register-ack',
    // 동적 모델 동기화
    DYNAMIC_MODELS_REQUEST: 'dynamic-models-request',
    DYNAMIC_MODELS_RESULT:  'dynamic-models-result',
    // Fetch 사이클
    FETCH_REQUEST:     'fetch-request',
    RESPONSE:          'response',
    ERROR:             'error',
    // 중단
    ABORT:             'abort',
};

// ── 헬퍼: UUID 생성 ──
/** @returns {string} UUID v4 형식 문자열 */
export function safeUUID() {
    try {
        return crypto.randomUUID();
    } catch {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
}

// ── 헬퍼: RisuAI API 참조 ──
/** @returns {import('./types').RisuAPI} RisuAI API 객체 */
export function getRisu() {
    return window.risuai || window.Risuai;
}

// ── 등록 재시도 상수 ──
/** @constant {number} */
const REGISTRATION_MAX_RETRIES = 12;
/** @constant {number} ms */
const REGISTRATION_BASE_DELAY = 500;
/** @constant {number} ms */
const REGISTRATION_MAX_DELAY = 5000;
/** @constant {number} 최종 시도 후 ACK 대기 ms */
const REGISTRATION_FINAL_TIMEOUT = 2000;

/**
 * registerWithManager — 프로바이더 등록 (ACK 수신까지 재시도)
 *
 * 매니저가 아직 리스너를 등록하지 않았을 수 있으므로,
 * ACK를 받을 때까지 지수 백오프로 재시도합니다.
 *
 * @param {object} Risu - RisuAI API 레퍼런스
 * @param {string} pluginName - //@name 과 동일한 플러그인 이름
 * @param {object} payload - { name, models, settingsFields }
 * @param {object} [opts] - { maxRetries, baseDelay }
 * @returns {Promise<boolean>} true if ACK received
 */
export function registerWithManager(Risu, pluginName, payload, opts = {}) {
    const maxRetries = opts.maxRetries || REGISTRATION_MAX_RETRIES;
    const baseDelay = opts.baseDelay || REGISTRATION_BASE_DELAY;
    const onControlMessage = typeof opts.onControlMessage === 'function' ? opts.onControlMessage : null;

    return new Promise((resolve) => {
        let resolved = false;
        let retryCount = 0;

        // ACK 리스너 등록
        // NOTE: V3 API에 removePluginChannelListener가 없으므로,
        // resolved 플래그로 중복 실행을 방지. 리스너 자체는 플러그인 수명 동안 유지됨 (알려진 제한).
        Risu.addPluginChannelListener(CH.CONTROL, (msg) => {
            if (msg && msg.type === MSG.REGISTER_ACK && !resolved) {
                resolved = true;
                console.log(`[${pluginName}] ✓ Registration ACK received`);
                resolve(true);
                return;
            }
            if (onControlMessage) onControlMessage(msg);
        });

        // 등록 메시지 전송 (재시도 루프)
        function trySend() {
            if (resolved) return;
            retryCount++;
            console.log(`[${pluginName}] Sending registration (attempt ${retryCount}/${maxRetries})`);
            Risu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                type: MSG.REGISTER_PROVIDER, pluginName, ...payload
            });
            if (retryCount < maxRetries) {
                const delay = Math.min(baseDelay * retryCount, REGISTRATION_MAX_DELAY);
                setTimeout(() => { if (!resolved) trySend(); }, delay);
            } else {
                // 최종 시도 후 1초 대기, 여전히 미응답이면 실패
                setTimeout(() => {
                    if (!resolved) {
                        console.warn(`[${pluginName}] Registration failed after ${maxRetries} retries`);
                        resolve(false);
                    }
                }, REGISTRATION_FINAL_TIMEOUT);
            }
        }
        trySend();
    });
}
