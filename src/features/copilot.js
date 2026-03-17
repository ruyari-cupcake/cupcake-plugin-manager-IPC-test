/**
 * CPM Feature — GitHub Copilot Token Manager
 * 독립 V3 플러그인 (IPC 불필요)
 * GitHub Copilot OAuth Device Flow 토큰 관리
 */
export {};
const Risu = /** @type {any} */ (window.risuai || window.Risuai);
const LOG = '[CPM Copilot]';
const PREFIX = 'cpm-copilot';
const TOKEN_ARG_KEY = 'tools_githubCopilotToken';
const GITHUB_CLIENT_ID = '01ab8ac9400c4e429b23';
const CODE_VERSION = '1.111.0';
const CHAT_VERSION = '0.40.2026031401';
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/${CODE_VERSION} Chrome/142.0.7444.265 Electron/39.3.0 Safari/537.36`;

/* ── Helpers ── */
function sanitizeToken(raw) {
    if (!raw) return '';
    return raw.replace(/[^\x20-\x7E]/g, '').trim();
}
function sanitizeHeaders(headers) {
    const clean = {};
    for (const [k, v] of Object.entries(headers)) {
        clean[k] = Array.from(String(v)).filter((ch) => ch.charCodeAt(0) <= 0xFF).join('');
    }
    return clean;
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

async function getToken() {
    try { const raw = await Risu.getArgument(TOKEN_ARG_KEY); return sanitizeToken(raw || ''); } catch { return ''; }
}
function setToken(val) { Risu.setArgument(TOKEN_ARG_KEY, sanitizeToken(val)); }

/* ── Smart Fetch ── */
function wrapResult(r) {
    const ok = !!r.ok, status = r.status || (ok ? 200 : 400), data = r.data, headers = r.headers || {};
    return { ok, status, headers, async json() { return typeof data === 'object' ? data : JSON.parse(data); }, async text() { return typeof data === 'string' ? data : JSON.stringify(data); } };
}
function isRealHttp(r) { return (r.headers && Object.keys(r.headers).length > 0) || (r.status && r.status !== 400) || (r.data && typeof r.data === 'object'); }

async function copilotFetch(url, opts = {}) {
    const method = opts.method || (url.includes('github.com/login/') ? 'POST' : 'GET');
    const headers = sanitizeHeaders(opts.headers || {});
    const canUseRisuFetch = typeof Risu.risuFetch === 'function';
    let body;
    if (opts.body) { try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body; } catch { body = opts.body; } }

    // OAuth → proxy
    if (url.includes('github.com/login/')) {
        if (canUseRisuFetch) {
            const r = await Risu.risuFetch(url, { method, headers, body, rawResponse: false, plainFetchDeforce: true });
            return wrapResult(r);
        }
        const nfBody = body ? new TextEncoder().encode(JSON.stringify(body)) : undefined;
        return Risu.nativeFetch(url, { method, headers, body: nfBody });
    }
    // API → nativeFetch first
    try {
        const res = await Risu.nativeFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.ok || (res.status && res.status !== 0)) return res;
    } catch {}
    // direct CORS
    if (canUseRisuFetch) {
        try {
            const r = await Risu.risuFetch(url, { method, headers, body, rawResponse: false, plainFetchForce: true });
            if (isRealHttp(r)) return wrapResult(r);
        } catch {}
        // proxy fallback
        try {
            const r = await Risu.risuFetch(url, { method, headers, body, rawResponse: false, plainFetchDeforce: true });
            if (isRealHttp(r)) return wrapResult(r);
        } catch {}
    }
    throw new Error('모든 네트워크 요청 방식 실패');
}

/* ── Copilot API ── */
async function requestDeviceCode() {
    const res = await copilotFetch('https://github.com/login/device/code', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'user:email' })
    });
    if (!res.ok) throw new Error(`디바이스 코드 요청 실패 (${res.status})`);
    return res.json();
}
async function exchangeAccessToken(deviceCode) {
    const res = await copilotFetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    });
    if (!res.ok) throw new Error(`액세스 토큰 요청 실패 (${res.status})`);
    const data = await res.json();
    if (data.error === 'authorization_pending') throw new Error('인증 아직 미완료. GitHub에서 코드 입력 후 다시 시도.');
    if (data.error === 'slow_down') throw new Error('요청 과다. 잠시 후 재시도.');
    if (!data.access_token) throw new Error('액세스 토큰 없음');
    return data.access_token;
}
async function checkTokenStatus(token) {
    const t = sanitizeToken(token);
    if (!t) throw new Error('토큰이 비어있습니다.');
    const res = await copilotFetch('https://api.github.com/copilot_internal/v2/token', {
        method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${t}`, 'User-Agent': USER_AGENT }
    });
    if (!res.ok) {
        if (res.status === 401) throw new Error('토큰 만료 또는 무효. 새 토큰 생성 필요.');
        throw new Error(`상태 확인 실패 (${res.status})`);
    }
    return res.json();
}
async function getTidToken(token) {
    const d = await checkTokenStatus(token); if (!d.token) throw new Error('Tid 토큰 불가'); return d;
}
async function fetchModelList(token) {
    const tid = await getTidToken(token);
    const res = await copilotFetch('https://api.githubcopilot.com/models', {
        method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${tid.token}`,
            'Editor-Version': `vscode/${CODE_VERSION}`, 'Editor-Plugin-Version': `copilot-chat/${CHAT_VERSION}`,
            'Copilot-Integration-Id': 'vscode-chat', 'User-Agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`모델 목록 실패 (${res.status})`);
    return res.json();
}
async function checkQuota(token) {
    const tid = await getTidToken(token);
    const info = { plan: tid.sku || 'unknown', token_meta: {} };
    for (const [k, v] of Object.entries(tid)) { if (k !== 'token' && k !== 'tracking_id' && k !== 'sku') info.token_meta[k] = v; }

    // /copilot_internal/user for quota
    try {
        let userData = null;
        const qHeaders = { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        if (typeof Risu.risuFetch === 'function') {
            try {
                const r = await Risu.risuFetch('https://api.github.com/copilot_internal/user', { method: 'GET', headers: qHeaders, rawResponse: false, plainFetchForce: true });
                if (r && r.ok && r.data && typeof r.data === 'object') userData = r.data;
            } catch {}
            if (!userData) {
                try {
                    const r = await Risu.risuFetch('https://api.github.com/copilot_internal/user', { method: 'GET', headers: qHeaders, rawResponse: false, plainFetchDeforce: true });
                    if (r && r.ok && r.data && typeof r.data === 'object') userData = r.data;
                } catch {}
            }
        }
        if (userData) {
            info.copilot_user = userData;
            if (userData.quota_snapshots) info.quota_snapshots = userData.quota_snapshots;
            if (userData.limited_user_quotas) { info.limited_user_quotas = userData.limited_user_quotas; info.limited_user_reset_date = userData.limited_user_reset_date; }
        }
    } catch {}
    return info;
}

/* ── CSS ── */
const CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #111827; color: #d1d5db; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.cpm-wrap { max-width: 720px; margin: 0 auto; padding: 24px; }
h2 { font-size: 24px; font-weight: 700; color: #60a5fa; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #374151; }
.info { color: #93c5fd; font-weight: 600; margin-bottom: 20px; border-left: 4px solid #3b82f6; padding: 4px 12px; font-size: 14px; }
.card { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.label { display: block; font-size: 13px; color: #9ca3af; margin-bottom: 6px; font-weight: 500; }
.token-display { background: #111827; border: 1px solid #4b5563; border-radius: 6px; padding: 8px 12px; font-family: monospace; font-size: 13px; color: #d1d5db; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input[type="text"], textarea { width: 100%; background: #111827; border: 1px solid #4b5563; border-radius: 6px; padding: 8px 12px; color: #e5e7eb; font-family: monospace; font-size: 13px; outline: none; }
input:focus, textarea:focus { border-color: #3b82f6; }
.row { display: flex; gap: 8px; align-items: center; }
.flex1 { flex: 1; }
.btn { display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: background 0.15s; }
.btn-blue { background: #2563eb; color: #fff; } .btn-blue:hover { background: #1d4ed8; }
.btn-red { background: #dc2626; color: #fff; } .btn-red:hover { background: #b91c1c; }
.btn-gray { background: #374151; color: #d1d5db; } .btn-gray:hover { background: #4b5563; }
.btn-green { background: #16a34a; color: #fff; } .btn-green:hover { background: #15803d; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
.grid-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px 8px; background: #1f2937; border: 1px solid #374151; border-radius: 8px; cursor: pointer; color: #d1d5db; font-size: 13px; font-weight: 500; transition: all 0.15s; }
.grid-btn:hover { background: #2563eb; border-color: #3b82f6; }
.grid-btn.red:hover { background: #dc2626; border-color: #ef4444; }
.grid-btn .icon { font-size: 24px; margin-bottom: 4px; }
#result { display: none; }
.result-card { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 16px; }
.result-inner { background: #111827; border-radius: 6px; padding: 12px; }
.success { background: #052e16; border-color: #166534; color: #86efac; }
.error { background: #450a0a; border-color: #991b1b; color: #fca5a5; }
.mono { font-family: monospace; font-size: 12px; }
.text-xs { font-size: 12px; } .text-sm { font-size: 14px; }
.text-gray { color: #6b7280; } .text-green { color: #4ade80; } .text-red { color: #f87171; } .text-yellow { color: #fbbf24; } .text-blue { color: #60a5fa; }
.mt2 { margin-top: 8px; } .mt4 { margin-top: 16px; } .mb2 { margin-bottom: 8px; } .mb4 { margin-bottom: 16px; }
.bold { font-weight: 700; }
details > summary { cursor: pointer; padding: 12px; font-weight: 600; color: #d1d5db; }
details > summary:hover { color: #fff; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000; padding: 16px; }
.dialog { background: #1f2937; border: 1px solid #374151; border-radius: 12px; max-width: 420px; width: 100%; overflow: hidden; }
.dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #374151; }
.dialog-body { padding: 20px; }
.step { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
.step-num { background: #2563eb; color: #fff; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.code-box { display: flex; align-items: center; justify-content: space-between; background: #374151; padding: 12px; border-radius: 6px; margin-top: 8px; }
.code-text { font-family: monospace; font-size: 22px; letter-spacing: 4px; color: #fff; font-weight: 700; }
.close-x { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; padding: 4px 8px; }
.close-x:hover { color: #fff; }
.bar-wrap { background: #374151; border-radius: 9999px; height: 12px; overflow: hidden; margin: 6px 0; }
.bar-fill { height: 100%; border-radius: 9999px; transition: width 0.3s; }
`;

/* ── UI ── */
let resultEl = null;
function showResult(html) { if (!resultEl) return; resultEl.style.display = 'block'; resultEl.innerHTML = html; resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
function showLoading(msg = '처리 중...') { showResult(`<div class="result-card" style="text-align:center;padding:24px;"><div style="font-size:24px;margin-bottom:8px;">⏳</div><div class="text-gray">${msg}</div></div>`); }
function showError(msg) { showResult(`<div class="result-card error"><strong>❌ 오류:</strong> ${escapeHtml(msg)}</div>`); }
function showSuccess(msg) { showResult(`<div class="result-card success">${msg}</div>`); }

async function refreshTokenDisplay() {
    const el = document.getElementById(`${PREFIX}-token-display`);
    if (!el) return;
    const t = await getToken();
    el.textContent = t ? (t.length > 16 ? t.substring(0, 8) + '••••••••' + t.substring(t.length - 4) : t) : '토큰 없음';
}

/* ── Actions ── */
async function doGenerate() {
    try {
        showLoading('GitHub 디바이스 코드 요청 중...');
        const dc = await requestDeviceCode();
        resultEl.style.display = 'none';

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = `
            <div class="dialog">
                <div class="dialog-head"><h3 style="color:#fff;font-size:16px;font-weight:700;">🔑 GitHub Copilot 토큰 생성</h3><button class="close-x" id="dc-close">✕</button></div>
                <div class="dialog-body">
                    <div class="card" style="margin-bottom:16px;">
                        <div class="step"><span class="step-num">1</span><span>GitHub 로그인 페이지로 이동: <a href="https://github.com/login/device" target="_blank" style="color:#60a5fa;text-decoration:underline;">https://github.com/login/device</a></span></div>
                        <div class="step"><span class="step-num">2</span><div style="flex:1;"><span>아래 코드를 입력:</span><div class="code-box"><span class="code-text" id="dc-code">${escapeHtml(dc.user_code)}</span><button class="btn btn-gray" id="dc-copy" style="font-size:12px;padding:4px 12px;">복사</button></div></div></div>
                        <div class="step"><span class="step-num">3</span><span>GitHub 계정으로 인증</span></div>
                    </div>
                    <p class="text-gray text-sm" style="text-align:center;margin-bottom:12px;">인증 완료 후 확인 버튼 클릭</p>
                    <div style="display:flex;justify-content:flex-end;gap:8px;">
                        <button class="btn btn-gray" id="dc-cancel">취소</button>
                        <button class="btn btn-blue" id="dc-confirm" style="font-weight:700;">확인</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        /** @type {HTMLElement} */ (overlay.querySelector('#dc-close')).onclick = () => overlay.remove();
        /** @type {HTMLElement} */ (overlay.querySelector('#dc-cancel')).onclick = () => overlay.remove();
        /** @type {HTMLElement} */ (overlay.querySelector('#dc-copy')).onclick = () => { try { navigator.clipboard.writeText(dc.user_code); } catch {} };
        const confirmBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#dc-confirm'));
        confirmBtn.onclick = async function () {
            confirmBtn.disabled = true; confirmBtn.textContent = '확인 중...';
            try {
                const at = await exchangeAccessToken(dc.device_code);
                setToken(at); overlay.remove(); await refreshTokenDisplay();
                showSuccess('<strong>✅ 성공!</strong> 토큰이 생성 및 저장되었습니다.');
            } catch (e) { confirmBtn.disabled = false; confirmBtn.textContent = '확인'; alert(e.message); }
        };
    } catch (e) { showError(e.message); }
}

async function doVerify() {
    const t = await getToken();
    if (!t) { showError('토큰 없음. 먼저 생성하세요.'); return; }
    showLoading('토큰 상태 확인 중...');
    try {
        const d = await checkTokenStatus(t);
        const sku = d.sku || '알 수 없음';
        const exp = d.expires_at ? new Date(d.expires_at * 1000).toLocaleString('ko-KR') : '알 수 없음';
        const feats = Object.entries(d).filter(([, v]) => typeof v === 'boolean' && v).map(([k]) => k);
        const ci = '<span class="text-green">✓</span> ', xi = '<span class="text-red">✗</span> ';
        showResult(`
            <div class="result-card"><h4 class="bold text-blue mb2">구독 정보</h4>
                <div class="result-inner text-sm">
                    <div>${sku.includes('subscriber') ? ci : xi}<strong>구독:</strong> ${escapeHtml(sku)}</div>
                    <div>${d.telemetry === 'disabled' ? ci : xi}<strong>텔레메트리:</strong> ${escapeHtml(d.telemetry || '?')}</div>
                    <div class="text-gray text-xs mt2">만료: ${exp}</div>
                </div>
            </div>
            ${feats.length > 0 ? `<div class="result-card mt2"><h4 class="bold text-blue mb2">활성 기능 (${feats.length})</h4><div class="result-inner text-xs">${feats.map(f => `<div>${ci}${escapeHtml(f)}</div>`).join('')}</div></div>` : ''}
        `);
    } catch (e) { showError(e.message); }
}

async function doRemove() {
    const t = await getToken();
    if (!t) { alert('이미 토큰 없음'); return; }
    if (!confirm('토큰을 제거하시겠습니까?')) return;
    setToken(''); await refreshTokenDisplay();
    showResult(`<div class="result-card" style="color:#fbbf24;"><strong>🗑️ 토큰 제거 완료.</strong></div>`);
}

async function doModels() {
    const t = await getToken();
    if (!t) { showError('토큰 없음'); return; }
    showLoading('모델 목록 조회 중...');
    try {
        const d = await fetchModelList(t);
        const ids = (d.data || []).map(m => m.id);
        showResult(`
            <div class="result-card"><h4 class="bold text-blue mb2">사용 가능한 모델 (${ids.length}개)</h4>
                <div class="result-inner mono" style="max-height:200px;overflow-y:auto;">${ids.map(id => `<div style="padding:3px 0;border-bottom:1px solid #1f2937;">${escapeHtml(id)}</div>`).join('')}</div>
            </div>
            <details class="result-card mt2"><summary>원본 JSON</summary><div class="result-inner mono text-gray" style="max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(JSON.stringify(d, null, 2))}</div></details>
        `);
    } catch (e) { showError(e.message); }
}

async function doQuota() {
    const t = await getToken();
    if (!t) { showError('토큰 없음'); return; }
    showLoading('할당량 조회 중...');
    try {
        const q = await checkQuota(t);
        const planLabels = { copilot_for_individuals_subscriber: 'Copilot Individual', copilot_for_individuals_pro_subscriber: 'Copilot Pro', plus_monthly_subscriber_quota: 'Copilot Pro+ (월간)', plus_yearly_subscriber_quota: 'Copilot Pro+ (연간)' };
        let html = `<div class="result-card mb2"><h4 class="bold text-blue mb2">📊 구독 플랜</h4><div class="result-inner text-sm"><strong>플랜:</strong> ${escapeHtml(planLabels[q.plan] || q.plan)}</div></div>`;

        if (q.quota_snapshots) {
            const snap = q.quota_snapshots;
            if (snap.premium_interactions) {
                const pi = snap.premium_interactions;
                const rem = pi.remaining ?? 0, ent = pi.entitlement ?? 0, pct = pi.percent_remaining ?? (ent > 0 ? rem / ent * 100 : 0);
                const clr = pct > 70 ? '#4ade80' : pct > 30 ? '#facc15' : '#f87171';
                html += `<div class="result-card mb2"><h4 class="bold text-blue mb2">🎯 프리미엄 요청</h4><div class="result-inner">
                    <div style="display:flex;justify-content:space-between;align-items:baseline;"><span class="text-sm"><strong>남은 요청:</strong></span><span style="color:${clr};font-size:1.4em;font-weight:700;">${rem} <span class="text-gray text-xs">/ ${ent}</span></span></div>
                    <div class="bar-wrap"><div class="bar-fill" style="background:${clr};width:${Math.min(pct, 100)}%;"></div></div>
                    <div style="display:flex;justify-content:space-between;" class="text-xs text-gray"><span>사용: ${ent - rem}회</span><span>${pct.toFixed(1)}% 남음</span></div>
                    ${pi.unlimited ? '<div class="text-green text-xs bold mt2">♾️ 무제한</div>' : ''}
                    ${pi.reset_date ? `<div class="text-gray text-xs mt2">리셋: ${new Date(pi.reset_date).toLocaleString('ko-KR')}</div>` : ''}
                </div></div>`;
            }
        } else if (q.limited_user_quotas) {
            const arr = Array.isArray(q.limited_user_quotas) ? q.limited_user_quotas : Object.entries(q.limited_user_quotas).map(([k, v]) => ({ name: k, ...(typeof v === 'object' ? v : { value: v }) }));
            if (arr.length > 0) {
                let lhtml = '';
                for (const it of arr) {
                    const label = (it.name || 'quota').replace(/_/g, ' ');
                    const limit = it.limit ?? it.entitlement ?? it.total ?? null;
                    const used = it.used ?? (limit != null && it.remaining != null ? limit - it.remaining : null);
                    if (it.unlimited && !limit) { lhtml += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #374151;"><span class="text-xs" style="text-transform:capitalize;">${escapeHtml(label)}</span><span class="text-green text-xs bold">♾️</span></div>`; }
                    else if (limit != null) { const pct = limit > 0 ? ((limit - (used ?? 0)) / limit * 100) : 0; const clr = pct > 70 ? '#4ade80' : pct > 30 ? '#facc15' : '#f87171'; lhtml += `<div style="padding:6px 0;border-bottom:1px solid #374151;"><div style="display:flex;justify-content:space-between;" class="text-xs"><span style="text-transform:capitalize;">${escapeHtml(label)}</span><span style="color:${clr};">${it.remaining ?? (limit - (used ?? 0))} / ${limit}</span></div><div class="bar-wrap" style="height:6px;"><div class="bar-fill" style="background:${clr};width:${Math.min(pct,100)}%;"></div></div></div>`; }
                    else { lhtml += `<div style="padding:6px 0;" class="text-xs text-gray"><span style="text-transform:capitalize;">${escapeHtml(label)}:</span> ${escapeHtml(JSON.stringify(it))}</div>`; }
                }
                html += `<div class="result-card mb2"><h4 class="bold text-blue mb2">🎯 할당량</h4><div class="result-inner">${lhtml}</div>${q.limited_user_reset_date ? `<div class="text-gray text-xs mt2">리셋: ${new Date(q.limited_user_reset_date).toLocaleString('ko-KR')}</div>` : ''}</div>`;
            }
        } else {
            html += `<div class="result-card" style="color:#fbbf24;">⚠️ 할당량 정보 없음</div>`;
        }

        if (q.token_meta && Object.keys(q.token_meta).length > 0) {
            const bools = [], others = {};
            for (const [k, v] of Object.entries(q.token_meta)) {
                if (typeof v === 'boolean') bools.push({ k, v });
                else if (k === 'expires_at') others[k] = new Date(v * 1000).toLocaleString('ko-KR');
                else others[k] = v;
            }
            let fhtml = '';
            if (bools.length) fhtml += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">${bools.map(b => `<div class="text-xs">${b.v ? '<span class="text-green">✅</span>' : '<span class="text-gray">❌</span>'} ${escapeHtml(b.k)}</div>`).join('')}</div>`;
            if (Object.keys(others).length) fhtml += `<div class="text-xs text-gray mono mt2" style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(others, null, 2))}</div>`;
            html += `<details class="result-card mt2"><summary>🔧 토큰 기능 상세</summary><div style="padding:0 16px 16px;">${fhtml}</div></details>`;
        }
        if (q.copilot_user) {
            html += `<details class="result-card mt2"><summary class="text-gray text-sm">🔍 API 원본 응답</summary><div style="padding:0 16px 16px;"><div class="result-inner mono text-gray text-xs" style="max-height:280px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(JSON.stringify(q.copilot_user, null, 2))}</div></div></details>`;
        }
        showResult(html);
    } catch (e) { showError(e.message); }
}

async function doManualSave() {
    const inp = /** @type {HTMLInputElement} */ (document.getElementById(`${PREFIX}-manual-input`));
    if (!inp || !inp.value.trim()) { alert('토큰을 입력하세요.'); return; }
    setToken(inp.value.trim()); inp.value = '';
    await refreshTokenDisplay();
    showSuccess('<strong>✅</strong> 직접 입력한 토큰이 저장되었습니다.');
}

async function doCopyToken() {
    const t = await getToken();
    if (!t) { alert('토큰 없음'); return; }
    try { await navigator.clipboard.writeText(t); } catch {
        const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    alert('토큰이 복사되었습니다.');
}

/* ── Open UI ── */
async function _openUI() {
    Risu.showContainer('fullscreen');
    const token = await getToken();
    const masked = token ? (token.length > 16 ? token.substring(0, 8) + '••••••••' + token.substring(token.length - 4) : token) : '토큰 없음';

    document.head.innerHTML = `<style>${CSS}</style>`;
    document.body.innerHTML = `
        <div class="cpm-wrap">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <h2>🔑 GitHub Copilot 토큰 관리자</h2>
                <button class="btn btn-gray" id="cpm-close">✕ 닫기</button>
            </div>
            <p class="info">GitHub Copilot OAuth 토큰을 생성·확인·제거하고, 사용 가능한 모델과 할당량을 조회합니다.</p>

            <div class="card">
                <span class="label">현재 저장된 토큰</span>
                <div class="row"><div class="token-display flex1" id="${PREFIX}-token-display">${escapeHtml(masked)}</div><button class="btn btn-gray" id="act-copy">📋 복사</button></div>
            </div>
            <div class="card">
                <span class="label">토큰 직접 입력</span>
                <div class="row"><input type="text" class="flex1" id="${PREFIX}-manual-input" placeholder="ghu_xxxx 또는 gho_xxxx 토큰 붙여넣기..." /><button class="btn btn-blue" id="act-save">💾 저장</button></div>
                <div class="text-xs text-gray mt2">GitHub에서 직접 발급받은 토큰을 수동으로 입력할 수 있습니다.</div>
            </div>

            <div class="grid3">
                <button class="grid-btn" id="act-gen"><span class="icon">🔑</span><span>토큰 생성</span></button>
                <button class="grid-btn" id="act-verify"><span class="icon">✅</span><span>토큰 확인</span></button>
                <button class="grid-btn red" id="act-remove"><span class="icon">🗑️</span><span>토큰 제거</span></button>
                <button class="grid-btn" id="act-models"><span class="icon">📋</span><span>모델 목록</span></button>
                <button class="grid-btn" id="act-quota"><span class="icon">📊</span><span>할당량 확인</span></button>
                <button class="grid-btn" id="act-info"><span class="icon">ℹ️</span><span>자동설정 안내</span></button>
            </div>

            <div id="result"></div>
        </div>
    `;

    resultEl = document.getElementById('result');

    document.getElementById('cpm-close').onclick = () => { document.body.innerHTML = ''; Risu.hideContainer(); };
    document.getElementById('act-copy').onclick = doCopyToken;
    document.getElementById('act-save').onclick = doManualSave;
    document.getElementById('act-gen').onclick = doGenerate;
    document.getElementById('act-verify').onclick = doVerify;
    document.getElementById('act-remove').onclick = doRemove;
    document.getElementById('act-models').onclick = doModels;
    document.getElementById('act-quota').onclick = doQuota;
    document.getElementById('act-info').onclick = () => {
        showResult(`
            <div class="result-card">
                <h4 class="bold text-blue mb2">ℹ️ Copilot 커스텀 모델 설정 안내</h4>
                <div class="result-inner text-sm" style="line-height:1.8;">
                    <p class="mb2">이 플러그인에서 토큰을 생성한 후, Cupcake Provider Manager 설정에서 <strong>커스텀 모델</strong>을 수동으로 추가하세요:</p>
                    <div class="card" style="background:#0f172a;">
                        <div><strong>이름:</strong> 🤖 Copilot (GPT-4.1)</div>
                        <div><strong>URL:</strong> https://api.githubcopilot.com/chat/completions</div>
                        <div><strong>모델:</strong> gpt-4.1</div>
                        <div><strong>Key:</strong> (토큰은 매번 자동 갱신되므로 직접 기입 필요)</div>
                        <div><strong>포맷:</strong> openai</div>
                    </div>
                    <p class="text-xs text-gray mt2">💡 Copilot 토큰은 약 30분마다 만료됩니다. 실제 사용 시 토큰 자동 갱신 로직이 필요합니다.</p>
                </div>
            </div>
        `);
    };
}

/* ── Init ── */
(async () => {
    try {
        // UI는 이제 CPM Manager 설정 내 "🔑 Copilot Token" 탭에 통합되었습니다.
        // 독립 설정 페이지는 더 이상 등록하지 않습니다.
        console.log(`${LOG} Loaded (UI integrated into CPM Settings).`);
    } catch (err) {
        console.error(`${LOG} Init error:`, err);
    }
})();
