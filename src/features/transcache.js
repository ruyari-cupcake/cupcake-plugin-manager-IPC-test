/**
 * CPM Feature — Translation Cache Manager
 * 독립 V3 플러그인 (IPC 불필요)
 * RisuAI 번역 캐시 검색·조회, 사용자 수정 사전 관리
 */
export {};
const Risu = /** @type {any} */ (window.risuai || window.Risuai);
const LOG = '[CPM TransCache]';
const PREFIX = 'cpm-transcache';
const CORRECTIONS_KEY = 'cpm_transcache_corrections';
const ENABLED_ARG_KEY = 'cpm_transcache_display_enabled';
const TIMESTAMPS_KEY = 'cpm_transcache_timestamps';
const PAGE_SIZE = 50;

/* ── Feature Detection ── */
const canSearchCache = typeof Risu.searchTranslationCache === 'function';
const canGetCache = typeof Risu.getTranslationCache === 'function';

/* ── Helpers ── */
function escapeHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ── Corrections Storage ── */
let _corrections = {};

async function loadCorrections() {
    try { const raw = await Risu.pluginStorage.getItem(CORRECTIONS_KEY); _corrections = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; }
    catch { _corrections = {}; }
    rebuildReplacementMap();
    return _corrections;
}
async function saveCorrections() {
    await Risu.pluginStorage.setItem(CORRECTIONS_KEY, JSON.stringify(_corrections));
    rebuildReplacementMap();
}

/* ── Replacement Map ── */
const _replacementMap = new Map();
let _replacementRegex = null;

function rebuildReplacementMap() {
    _replacementMap.clear(); _replacementRegex = null;
    const keys = [];
    for (const data of Object.values(_corrections)) {
        if (data && data.old && typeof data.old === 'string' && data.old.length > 0 && data.new && data.old !== data.new) {
            _replacementMap.set(data.old, data.new); keys.push(data.old);
        }
    }
    if (keys.length > 0) {
        try { _replacementRegex = new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'); }
        catch { _replacementRegex = null; }
    }
}

/* ── Display Handler ── */
let _displayEnabled = true;
const displayHandler = (content) => {
    if (!_displayEnabled || _replacementMap.size === 0 || !content || typeof content !== 'string' || content.length < 2) return null;
    let result;
    if (_replacementRegex) {
        result = content.replace(_replacementRegex, m => _replacementMap.get(m) || m);
    } else {
        result = content;
        for (const [old, nw] of _replacementMap) { if (result.includes(old)) result = result.split(old).join(nw); }
    }
    return result === content ? null : result;
};
Risu.addRisuScriptHandler('display', displayHandler);
if (window._cpmTransCacheCleanup) try { window._cpmTransCacheCleanup(); } catch {}
window._cpmTransCacheCleanup = () => { try { Risu.removeRisuScriptHandler('display', displayHandler); } catch {} };

/* ── Cache API ── */
/** @type {any[] | null} */
let _allCacheEntries = null;
let _cacheLoadedAt = 0;
const CACHE_TTL = 120000;

async function loadAllCache(force = false) {
    if (!canSearchCache) return null;
    if (!force && _allCacheEntries && (Date.now() - _cacheLoadedAt < CACHE_TTL)) return _allCacheEntries;
    try {
        const results = await Risu.searchTranslationCache('');
        _allCacheEntries = results || []; _cacheLoadedAt = Date.now();
        await updateTimestamps(_allCacheEntries);
        return _allCacheEntries;
    } catch { return null; }
}
async function searchCacheLocal(query) {
    const all = await loadAllCache(true);
    if (!all) return null;
    if (!query) return all;
    const lq = query.toLowerCase();
    return all.filter(e => e.key.toLowerCase().includes(lq) || e.value.toLowerCase().includes(lq));
}

/* ── Timestamps ── */
let _timestampIndex = {};
function valueSig(v) { return v.length + ':' + v.substring(0, 16); }
function relativeTime(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return '방금 전';
    if (d < 3600000) return `${Math.floor(d / 60000)}분 전`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}시간 전`;
    return `${Math.floor(d / 86400000)}일 전`;
}
async function loadTimestamps() {
    try { const raw = await Risu.pluginStorage.getItem(TIMESTAMPS_KEY); _timestampIndex = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; }
    catch { _timestampIndex = {}; }
}
async function saveTimestamps() { try { await Risu.pluginStorage.setItem(TIMESTAMPS_KEY, JSON.stringify(_timestampIndex)); } catch {} }
async function updateTimestamps(entries) {
    await loadTimestamps();
    const now = Date.now(), isFirst = Object.keys(_timestampIndex).length === 0, idx = {};
    let changed = false;
    for (const e of entries) {
        const sig = valueSig(e.value), ex = _timestampIndex[e.key];
        if (!ex) { idx[e.key] = { ts: isFirst ? 0 : now, sig }; changed = true; }
        else if (ex.sig !== sig) { idx[e.key] = { ts: now, sig }; changed = true; }
        else idx[e.key] = ex;
        e._timestamp = idx[e.key].ts;
    }
    if (Object.keys(_timestampIndex).length !== Object.keys(idx).length) changed = true;
    _timestampIndex = idx;
    if (changed) await saveTimestamps();
}

/* ── CSS ── */
const CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #111827; color: #d1d5db; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.wrap { max-width: 720px; margin: 0 auto; padding: 24px; }
h2 { font-size: 24px; font-weight: 700; color: #60a5fa; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #374151; }
.info { color: #93c5fd; font-weight: 600; margin-bottom: 12px; border-left: 4px solid #3b82f6; padding: 4px 12px; font-size: 14px; }
.hint { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
.card { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.label { display: block; font-size: 13px; color: #9ca3af; margin-bottom: 6px; font-weight: 500; }
.row { display: flex; gap: 8px; align-items: center; }
.flex1 { flex: 1; }
input[type="text"], textarea { width: 100%; background: #111827; border: 1px solid #4b5563; border-radius: 6px; padding: 8px 12px; color: #e5e7eb; font-family: monospace; font-size: 13px; outline: none; resize: vertical; }
input:focus, textarea:focus { border-color: #3b82f6; }
.btn { display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: background 0.15s; }
.btn-blue { background: #2563eb; color: #fff; } .btn-blue:hover { background: #1d4ed8; }
.btn-red { background: #dc2626; color: #fff; } .btn-red:hover { background: #b91c1c; }
.btn-gray { background: #374151; color: #d1d5db; } .btn-gray:hover { background: #4b5563; }
.btn-green { background: #16a34a; color: #fff; } .btn-green:hover { background: #15803d; }
.btn-orange { background: #ea580c; color: #fff; } .btn-orange:hover { background: #c2410c; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
.grid-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px 8px; background: #1f2937; border: 1px solid #374151; border-radius: 8px; cursor: pointer; color: #d1d5db; font-size: 13px; font-weight: 500; transition: all 0.15s; }
.grid-btn:hover { background: #2563eb; border-color: #3b82f6; }
.grid-btn.warn:hover { background: #ea580c; border-color: #f97316; }
.grid-btn.red:hover { background: #dc2626; border-color: #ef4444; }
.grid-btn .icon { font-size: 24px; margin-bottom: 4px; }
.stats { display: flex; justify-content: space-between; align-items: center; }
.stat-val { font-weight: 700; margin-left: 8px; }
.text-xs { font-size: 12px; } .text-sm { font-size: 14px; }
.text-gray { color: #6b7280; } .text-green { color: #4ade80; } .text-red { color: #f87171; } .text-yellow { color: #fbbf24; } .text-blue { color: #60a5fa; }
.mt2 { margin-top: 8px; } .mt4 { margin-top: 16px; } .mb2 { margin-bottom: 8px; } .mb4 { margin-bottom: 16px; }
.bold { font-weight: 700; }
.entry { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 12px; margin-bottom: 8px; transition: border-color 0.15s; }
.entry:hover { border-color: #3b82f6; }
.entry.corrected { border-color: rgba(234,179,8,0.5); }
.badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.badge-yellow { background: rgba(234,179,8,0.2); color: #fbbf24; }
.mono { font-family: monospace; font-size: 13px; line-height: 1.5; word-break: break-word; }
.pager { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 12px; }
.sort-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.sort-btn { padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer; border: none; }
.sort-active { background: #2563eb; color: #fff; }
.sort-inactive { background: #374151; color: #d1d5db; }
.sort-inactive:hover { background: #4b5563; }
.inner { background: #111827; border-radius: 6px; padding: 12px; }
.success { background: #052e16; border-color: #166534; color: #86efac; }
.error { background: #450a0a; border-color: #991b1b; color: #fca5a5; }
.warn-text { color: #fbbf24; }
#result { display: none; }
`;

/* ── UI State ── */
let _searchResults = [], _unsortedResults = [], _currentPage = 0, _currentSort = 'default', _isLoading = false;
let resultEl = null;

function setResult(html) { if (!resultEl) return; resultEl.style.display = 'block'; resultEl.innerHTML = html; }
function showStatus(msg, type = 'info') {
    const cls = type === 'success' ? 'text-green' : type === 'error' ? 'text-red' : type === 'warn' ? 'text-yellow' : 'text-blue';
    setResult(`<div style="border-left:4px solid currentColor;padding:6px 12px;" class="${cls} text-sm">${msg}</div>`);
}

function renderResults(results, page = 0) {
    _searchResults = results; _currentPage = page;
    const total = results.length, start = page * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total), totalPages = Math.ceil(total / PAGE_SIZE);
    if (total === 0) { setResult('<div class="text-gray text-sm" style="text-align:center;padding:16px;">검색 결과가 없습니다.</div>'); return; }
    const hasTs = results.length > 0 && results[0]._timestamp !== undefined;
    let html = `<div class="row mb2" style="justify-content:space-between;"><span class="text-sm text-gray">총 <strong class="text-blue">${total}</strong>건 (${start + 1}~${end})</span><div class="row">`;
    if (page > 0) html += `<button class="btn btn-gray text-xs" data-act="page" data-v="${page - 1}">◀ 이전</button>`;
    html += `<span class="text-xs text-gray">${page + 1}/${totalPages}</span>`;
    if (end < total) html += `<button class="btn btn-gray text-xs" data-act="page" data-v="${page + 1}">다음 ▶</button>`;
    html += `</div></div>`;

    if (hasTs) {
        const dCls = _currentSort === 'default' ? 'sort-active' : 'sort-inactive';
        const rCls = _currentSort === 'recent' ? 'sort-active' : 'sort-inactive';
        html += `<div class="sort-bar"><span class="text-xs text-gray">정렬:</span><button class="sort-btn ${dCls}" data-act="sort" data-v="default">기본 (사전순)</button><button class="sort-btn ${rCls}" data-act="sort" data-v="recent">🕐 최신 번역순</button></div>`;
    }

    for (let i = start; i < end; i++) {
        const it = results[i], corr = _corrections[it.key];
        const val = corr ? corr.new : it.value;
        const kp = escapeHtml(it.key.length > 80 ? it.key.substring(0, 80) + '…' : it.key);
        const vp = escapeHtml(val.length > 80 ? val.substring(0, 80) + '…' : val);
        const badge = corr ? ' <span class="badge badge-yellow">수정됨</span>' : '';
        const ts = relativeTime(it._timestamp);
        html += `<div class="entry${corr ? ' corrected' : ''}"><div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;min-width:0;">
                <div class="text-xs text-gray mb2" style="display:flex;justify-content:space-between;">원문${badge}${ts ? `<span>${ts}</span>` : ''}</div>
                <div class="mono text-sm">${kp}</div>
                <div class="text-xs text-gray mt2 mb2">번역</div>
                <div class="mono text-sm ${corr ? 'text-yellow' : 'text-green'}">${vp}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                <button class="btn btn-gray text-xs" data-act="view" data-v="${i}" title="상세">🔍</button>
                <button class="btn btn-gray text-xs" data-act="edit" data-v="${i}" title="수정">✏️</button>
                ${corr ? `<button class="btn btn-gray text-xs" data-act="revert" data-v="${i}" title="되돌리기">↩️</button>` : ''}
            </div>
        </div></div>`;
    }

    if (totalPages > 1) {
        html += `<div class="pager">`;
        if (page > 0) html += `<button class="btn btn-gray text-xs" data-act="page" data-v="${page - 1}">◀ 이전</button>`;
        html += `<span class="text-xs text-gray">${page + 1}/${totalPages}</span>`;
        if (end < total) html += `<button class="btn btn-gray text-xs" data-act="page" data-v="${page + 1}">다음 ▶</button>`;
        html += `</div>`;
    }
    setResult(html);
}

function applySortAndRender(results) {
    _unsortedResults = [...results];
    if (_currentSort === 'recent') renderResults([...results].sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0)));
    else renderResults(results);
}

/* ── API Methods ── */
const api = {};

api.search = async () => {
    const inp = /** @type {HTMLInputElement} */ (document.getElementById(`${PREFIX}-search`));
    const q = inp ? inp.value.trim() : '';
    if (!q) { showStatus('검색어를 입력하세요.', 'warn'); return; }
    if (_isLoading) return; _isLoading = true;
    showStatus('🔄 검색 중...');
    try {
        if (canSearchCache) { const r = await searchCacheLocal(q); if (r === null) showStatus('캐시 API 실패', 'error'); else applySortAndRender(r); }
        else {
            const lq = q.toLowerCase();
            const r = Object.entries(_corrections).filter(([k, d]) => k.toLowerCase().includes(lq) || (d.old || '').toLowerCase().includes(lq) || (d.new || '').toLowerCase().includes(lq)).map(([k, d]) => ({ key: k, value: d.old || '' }));
            if (r.length === 0) showStatus('결과 없음 (API 미지원 — 수정 사전만 검색)', 'warn'); else renderResults(r);
        }
    } catch (e) { showStatus(`오류: ${escapeHtml(e.message)}`, 'error'); }
    finally { _isLoading = false; }
};

api.browseAll = async () => {
    if (_isLoading) return; _isLoading = true;
    showStatus('🔄 전체 캐시 로딩...');
    try {
        if (canSearchCache) { const r = await loadAllCache(true); if (!r) showStatus('불러오기 실패', 'error'); else if (r.length === 0) showStatus('캐시 비어있음', 'warn'); else applySortAndRender(r); }
        else showStatus('searchTranslationCache API 미지원', 'warn');
    } catch (e) { showStatus(`오류: ${escapeHtml(e.message)}`, 'error'); }
    finally { _isLoading = false; }
};

api.browseCorrections = async () => {
    await loadCorrections();
    const r = Object.entries(_corrections).map(([k, d]) => ({ key: k, value: d.old || '' }));
    if (r.length === 0) showStatus('수정 사전 비어있음', 'warn'); else renderResults(r);
};

api.viewEntry = (idx) => {
    const it = _searchResults[idx]; if (!it) return;
    const corr = _corrections[it.key], val = corr ? corr.new : it.value;
    let corrHtml = '';
    if (corr) corrHtml = `<div class="card" style="border-color:rgba(234,179,8,0.5);"><div class="text-xs text-yellow mb2">⚠️ 사용자 수정 적용됨 (원래 번역:)</div><div class="mono text-sm text-gray">${escapeHtml(corr.old)}</div></div>`;
    setResult(`<div class="card"><div class="row mb4" style="justify-content:space-between;"><h4 class="text-blue bold text-sm">📄 캐시 항목 상세</h4><button class="btn btn-gray text-xs" data-act="page" data-v="${_currentPage}">← 목록</button></div>
        <div class="mb4"><div class="text-xs text-gray mb2">원문 (Key)</div><div class="inner mono text-sm" style="max-height:240px;overflow-y:auto;">${escapeHtml(it.key)}</div></div>
        ${corrHtml}<div><div class="text-xs text-gray mb2">번역 (현재)</div><div class="inner mono text-sm ${corr ? 'text-yellow' : 'text-green'}" style="max-height:240px;overflow-y:auto;">${escapeHtml(val)}</div></div>
        <div class="row mt4"><button class="btn btn-orange text-sm" data-act="edit" data-v="${idx}">✏️ 수정</button>${corr ? `<button class="btn btn-gray text-sm" data-act="revert" data-v="${idx}">↩️ 되돌리기</button>` : ''}</div>
    </div>`);
};

api.editEntry = (idx) => {
    const it = _searchResults[idx]; if (!it) return;
    const corr = _corrections[it.key], val = corr ? corr.new : it.value;
    setResult(`<div class="card" style="border-color:#ea580c;"><div class="row mb4" style="justify-content:space-between;"><h4 class="text-yellow bold text-sm">✏️ 번역 수정</h4><button class="btn btn-gray text-xs" data-act="page" data-v="${_currentPage}">← 취소</button></div>
        <div class="mb4"><div class="text-xs text-gray mb2">원문</div><div class="inner mono text-xs text-gray" style="max-height:160px;overflow-y:auto;">${escapeHtml(it.key)}</div></div>
        <div class="mb2"><div class="text-xs text-gray mb2">캐시 원본 (참고)</div><div class="inner mono text-xs text-gray" style="max-height:100px;overflow-y:auto;">${escapeHtml(it.value)}</div></div>
        <div class="mb4"><div class="text-xs text-gray mb2">수정할 번역</div><textarea id="${PREFIX}-edit-val" rows="6" style="border-color:#ea580c;">${escapeHtml(val)}</textarea></div>
        <div class="hint">💡 수정 내용은 사용자 수정 사전에 저장, 표시 시 자동 적용됩니다.</div>
        <div class="row"><button class="btn btn-green text-sm" data-act="saveEdit" data-v="${idx}">💾 저장</button><button class="btn btn-gray text-sm" data-act="page" data-v="${_currentPage}">취소</button></div>
    </div>`);
};

api.saveEdit = async (idx) => {
    const it = _searchResults[idx]; if (!it) return;
    const ta = /** @type {HTMLInputElement} */ (document.getElementById(`${PREFIX}-edit-val`)); if (!ta) return;
    const nv = ta.value;
    if (nv === it.value) {
        if (_corrections[it.key]) { delete _corrections[it.key]; await saveCorrections(); showStatus('✅ 원본과 동일 — 수정 되돌림', 'success'); }
        else showStatus('변경 없음', 'warn');
        return;
    }
    _corrections[it.key] = { old: it.value, new: nv };
    await saveCorrections();
    showStatus('✅ 수정 사전에 저장됨', 'success');
    updateCorrCount();
};

api.revertEntry = async (idx) => {
    const it = _searchResults[idx]; if (!it || !_corrections[it.key]) return;
    if (!confirm('수정을 되돌리시겠습니까?')) return;
    delete _corrections[it.key]; await saveCorrections();
    showStatus('✅ 수정 되돌림 완료', 'success'); updateCorrCount();
};

api.exportCache = async () => {
    showStatus('🔄 내보내기 준비...');
    try {
        let entries = [];
        if (canSearchCache) { const all = await loadAllCache(true); if (all) entries = all; }
        const obj = {};
        for (const { key, value } of entries) { obj[key] = _corrections[key] ? _corrections[key].new : value; }
        for (const [k, d] of Object.entries(_corrections)) { if (!(k in obj)) obj[k] = d.new; }
        const total = Object.keys(obj).length;
        if (total === 0) { showStatus('내보낼 데이터 없음', 'warn'); return; }
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `risu-translation-cache-${new Date().toISOString().replace(/[:.]/g,'-').substring(0,19)}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
        showStatus(`✅ ${total}건 내보냄`, 'success');
    } catch (e) { showStatus(`오류: ${escapeHtml(e.message)}`, 'error'); }
};

api.exportCorrections = async () => {
    const cnt = Object.keys(_corrections).length;
    if (cnt === 0) { showStatus('수정 사전 비어있음', 'warn'); return; }
    const obj = {}; for (const [k, d] of Object.entries(_corrections)) obj[k] = d.new;
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `risu-corrections-${new Date().toISOString().replace(/[:.]/g,'-').substring(0,19)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    showStatus(`✅ 수정 사전 ${cnt}건 내보냄`, 'success');
};

api.importCache = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async (e) => {
        const f = /** @type {HTMLInputElement} */ (e.target).files[0]; if (!f) return;
        showStatus('🔄 파일 읽는 중...');
        try {
            const data = JSON.parse(await f.text());
            if (typeof data !== 'object' || data === null || Array.isArray(data)) { showStatus('잘못된 JSON 형식', 'error'); return; }
            const cnt = Object.keys(data).length;
            if (!confirm(`${cnt}건을 수정 사전에 가져오시겠습니까?`)) return;
            let added = 0;
            for (const [k, v] of Object.entries(data)) {
                if (typeof k !== 'string' || typeof v !== 'string') continue;
                let old = '';
                if (canGetCache) { try { old = (await Risu.getTranslationCache(k)) || ''; } catch {} }
                _corrections[k] = { old: old || _corrections[k]?.old || '', new: v }; added++;
            }
            await saveCorrections();
            showStatus(`✅ ${added}건 가져옴`, 'success'); updateCorrCount();
        } catch (e) { showStatus(`오류: ${escapeHtml(e.message)}`, 'error'); }
    };
    inp.click();
};

api.clearCorrections = async () => {
    const cnt = Object.keys(_corrections).length;
    if (cnt === 0) { showStatus('삭제할 항목 없음', 'warn'); return; }
    if (!confirm(`수정 사전 ${cnt}건 전체 삭제?`)) return;
    _corrections = {}; await saveCorrections();
    showStatus(`✅ ${cnt}건 삭제 완료`, 'success'); updateCorrCount();
};

api.showAddForm = () => {
    setResult(`<div class="card" style="border-color:#16a34a;"><h4 class="text-green bold text-sm mb4">➕ 수동 번역 추가</h4>
        <div class="mb4"><div class="text-xs text-gray mb2">원문</div><textarea id="${PREFIX}-add-key" rows="3" placeholder="번역 전 원문..."></textarea></div>
        <div class="mb4"><div class="text-xs text-gray mb2">번역</div><textarea id="${PREFIX}-add-val" rows="3" placeholder="번역된 텍스트..."></textarea></div>
        <div class="hint">💡 수정 사전에 추가됩니다.</div>
        <div class="row"><button class="btn btn-green text-sm" data-act="saveNew">💾 추가</button><button class="btn btn-gray text-sm" data-act="page" data-v="${_currentPage}">취소</button></div>
    </div>`);
};

api.saveNew = async () => {
    const kEl = /** @type {HTMLInputElement} */ (document.getElementById(`${PREFIX}-add-key`)), vEl = /** @type {HTMLInputElement} */ (document.getElementById(`${PREFIX}-add-val`));
    if (!kEl || !vEl) return;
    const k = kEl.value, v = vEl.value;
    if (!k.trim()) { showStatus('원문 입력 필요', 'warn'); return; }
    if (!v.trim()) { showStatus('번역 입력 필요', 'warn'); return; }
    let old = '';
    if (canGetCache) { try { old = (await Risu.getTranslationCache(k)) || ''; } catch {} }
    if (_corrections[k] && !confirm('이미 동일 원문 존재. 덮어쓰시겠습니까?')) return;
    _corrections[k] = { old: old || _corrections[k]?.old || '', new: v };
    await saveCorrections();
    showStatus('✅ 추가 완료', 'success'); updateCorrCount();
};

function updateCorrCount() {
    const el = document.getElementById(`${PREFIX}-corr-count`);
    if (el) el.textContent = `${Object.keys(_corrections).length.toLocaleString()}건`;
}

/* ── Event Delegation ── */
function handleClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const v = btn.getAttribute('data-v');
    const num = v !== null ? (isNaN(Number(v)) ? v : Number(v)) : undefined;
    switch (act) {
        case 'page': renderResults(_searchResults, num); break;
        case 'sort':
            _currentSort = v;
            if (v === 'recent') _searchResults = [..._unsortedResults].sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
            else _searchResults = [..._unsortedResults];
            renderResults(_searchResults, 0); break;
        case 'view': api.viewEntry(num); break;
        case 'edit': api.editEntry(num); break;
        case 'saveEdit': api.saveEdit(num); break;
        case 'revert': api.revertEntry(num); break;
        case 'search': api.search(); break;
        case 'browseAll': api.browseAll(); break;
        case 'browseCorr': api.browseCorrections(); break;
        case 'add': api.showAddForm(); break;
        case 'saveNew': api.saveNew(); break;
        case 'export': api.exportCache(); break;
        case 'exportCorr': api.exportCorrections(); break;
        case 'import': api.importCache(); break;
        case 'clear': api.clearCorrections(); break;
        case 'refresh': api.refreshCount(); break;
    }
}

api.refreshCount = async () => {
    try {
        if (canSearchCache) { const all = await loadAllCache(true); const el = document.getElementById(`${PREFIX}-cache-count`); if (el && all) el.textContent = `${all.length.toLocaleString()}건`; }
    } catch {}
    updateCorrCount();
};

/* ── Open UI ── */
async function openUI() {
    Risu.showContainer('fullscreen');
    await loadCorrections();

    let cacheCount = '—';
    const corrCount = Object.keys(_corrections).length.toLocaleString() + '건';
    if (canSearchCache) { try { const all = await loadAllCache(); cacheCount = all ? `${all.length.toLocaleString()}건` : '(오류)'; } catch { cacheCount = '(오류)'; } }
    else cacheCount = '(API 미지원)';

    document.head.innerHTML = `<style>${CSS}</style>`;
    document.body.innerHTML = `
        <div class="wrap">
            <div class="row" style="justify-content:space-between;align-items:center;">
                <h2>💾 번역 캐시 관리자</h2>
                <button class="btn btn-gray" id="tc-close">✕ 닫기</button>
            </div>
            <p class="info">RisuAI 번역 캐시를 검색·확인하고, 사용자 수정 사전으로 번역을 교정합니다.</p>
            <p class="hint">ℹ️ RisuAI 캐시는 읽기 전용. 수정 시 "수정 사전"에 저장, 채팅 표시 시 자동 적용.</p>

            <div class="card">
                <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;">
                    <input id="${PREFIX}-toggle" type="checkbox" ${_displayEnabled ? 'checked' : ''} style="width:18px;height:18px;">
                    <span>수정 사전 자동 적용 (채팅 표시 시 번역 교정)</span>
                </label>
            </div>

            <div class="card">
                <div class="stats mb2">
                    <div><span class="text-sm text-gray">RisuAI 캐시:</span><span class="stat-val text-blue text-sm" id="${PREFIX}-cache-count">${cacheCount}</span></div>
                    <button class="btn btn-gray text-xs" data-act="refresh" title="새로고침">🔄</button>
                </div>
                <div><span class="text-sm text-gray">수정 사전:</span><span class="stat-val text-yellow text-sm" id="${PREFIX}-corr-count">${corrCount}</span></div>
            </div>

            <div class="card">
                <div class="label">🔍 검색 (원문+번역 모두)</div>
                <div class="row">
                    <input type="text" class="flex1" id="${PREFIX}-search" placeholder="검색어..." />
                    <button class="btn btn-blue" data-act="search">🔍 검색</button>
                </div>
            </div>

            <div class="grid3">
                <button class="grid-btn" data-act="browseAll" ${!canSearchCache ? 'disabled title="API 미지원"' : ''}><span class="icon">📋</span><span>캐시 전체</span></button>
                <button class="grid-btn warn" data-act="browseCorr"><span class="icon">📝</span><span>수정 사전</span></button>
                <button class="grid-btn" data-act="add"><span class="icon">➕</span><span>수동 추가</span></button>
            </div>
            <div class="grid3">
                <button class="grid-btn" data-act="export"><span class="icon">📤</span><span>전체 내보내기</span></button>
                <button class="grid-btn warn" data-act="exportCorr"><span class="icon">📤</span><span>수정 내보내기</span></button>
                <button class="grid-btn" data-act="import"><span class="icon">📥</span><span>가져오기</span></button>
            </div>
            <div style="margin-bottom:16px;">
                <button class="grid-btn red" data-act="clear" style="width:100%;"><span>🗑️ 수정 사전 전체 삭제</span></button>
            </div>

            <div id="result"></div>
        </div>
    `;

    resultEl = document.getElementById('result');
    document.getElementById('tc-close').onclick = () => { document.body.innerHTML = ''; Risu.hideContainer(); };
    document.getElementById(`${PREFIX}-toggle`).onchange = (e) => {
        _displayEnabled = /** @type {HTMLInputElement} */ (e.target).checked;
        Risu.setArgument(ENABLED_ARG_KEY, String(_displayEnabled));
    };
    document.getElementById(`${PREFIX}-search`).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); api.search(); } });
    document.addEventListener('click', handleClick);
}

/* ── Init ── */
(async () => {
    try {
        try { const v = await Risu.getArgument(ENABLED_ARG_KEY); _displayEnabled = !(v === 'false' || v === false); } catch {}
        await loadCorrections();
        console.log(`${LOG} Init: ${Object.keys(_corrections).length} corrections, display=${_displayEnabled}`);

        if (canSearchCache) {
            try { await loadAllCache(); console.log(`${LOG} Timestamp snapshot: ${_allCacheEntries ? _allCacheEntries.length : 0} entries`); } catch {}
        }

        await Risu.registerSetting('번역 캐시', openUI, '💾', 'html');
        console.log(`${LOG} Loaded and ready.`);
    } catch (err) {
        console.error(`${LOG} Init error:`, err);
    }
})();
