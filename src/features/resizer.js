/**
 * CPM Feature — Chat Input Resizer
 * 독립 V3 플러그인 (IPC 불필요)
 * rootDoc에서 textarea를 찾아 🧁 버튼으로 확장/축소
 *
 * V3 Sandbox API 주의사항:
 *   - new MutationObserver() → Risu.createMutationObserver() 사용 필수
 *   - el.closest() → el.getParent() 로 대체
 *   - querySelectorAll → 순회 querySelector (SafeElement[] 직렬화 불가)
 *   - e.target → getBoundingClientRect() 히트 테스트로 대체
 */
export {};
const Risu = /** @type {any} */ (window.risuai || window.Risuai);
const LOG = '[CPM Resizer]';

let rootDoc = null;

const EXCLUDE = ['.text-input-area', '#messageInputTranslate', '.partial-edit-textarea'];

async function preinitChatVars() {
    try {
        const char = await Risu.getCharacter();
        if (!char?.chats || char.chatPage === undefined) return;
        const chat = char.chats[char.chatPage];
        if (!chat) return;
        if (!chat.scriptstate) chat.scriptstate = {};
        let changed = false;
        if (chat.scriptstate['$fold_ui'] === undefined || chat.scriptstate['$fold_ui'] === null) {
            chat.scriptstate['$fold_ui'] = '';
            changed = true;
        }
        if (changed) await Risu.setCharacter(char);
    } catch (_) {}
}

async function scrubBackgroundNull() {
    try {
        // NOTE: querySelectorAll 사용 불가 — querySelector 사용
        const overlay = await rootDoc.querySelector('.absolute.top-0.left-0.w-full.h-full');
        if (!overlay) return;
        const html = await overlay.getInnerHTML();
        if (!html || typeof html !== 'string') return;
        const cleaned = html
            .replace(/<p>\s*null\s*<\/p>/gi, '')
            .replace(/>\s*null\s*</g, '><')
            .replace(/<p>\s*<\/p>/g, '');
        if (cleaned !== html) await overlay.setInnerHTML(cleaned);
    } catch (_) {}
}

async function injectStyles() {
    const styleId = 'cpm-maximizer-styles';
    if (await rootDoc.querySelector(`[x-id="${styleId}"]`)) return;
    const styleEl = await rootDoc.createElement('style');
    await styleEl.setAttribute('x-id', styleId);
    await styleEl.setInnerHTML(`
        textarea[x-cpm-maximized="true"] {
            position: fixed !important;
            top: 10vh !important;
            left: 10vw !important;
            width: 80vw !important;
            height: 80vh !important;
            max-height: none !important;
            z-index: 999999 !important;
            background-color: var(--bgcolor, #1e1e2e) !important;
            padding: 24px !important;
            box-shadow: 0 0 50px rgba(0, 0, 0, 0.8), 0 0 0 9999px rgba(0, 0, 0, 0.6) !important;
            border-radius: 12px !important;
            border: 2px solid var(--borderc, #555) !important;
            font-size: 1.1em !important;
            resize: none !important;
            transition: all 0.2s ease-out !important;
        }
        button[x-cpm-maximized-btn="true"] {
            position: fixed !important;
            bottom: 12vh !important;
            right: 12vw !important;
            z-index: 9999999 !important;
            padding: 12px !important;
            font-size: 1.5em !important;
            background: rgba(255, 255, 255, 0.1) !important;
            backdrop-filter: blur(4px) !important;
        }
    `);
    const head = await rootDoc.querySelector('head');
    if (head) await head.appendChild(styleEl);
}

async function attachButtonToTextarea(ta) {
    try {
        if (await ta.getAttribute('x-cpm-resizer')) return;

        let isExcluded = false;
        for (const sel of EXCLUDE) {
            try { if (await ta.matches(sel)) { isExcluded = true; break; } } catch (_) {}
        }
        if (isExcluded) {
            await ta.setAttribute('x-cpm-resizer', 'skip');
            return;
        }

        await ta.setAttribute('x-cpm-resizer', '1');

        // V3 API: getParent() instead of closest('div')
        const parent = await ta.getParent();
        if (!parent) return;

        // 이미 버튼이 있으면 스킵
        if (await parent.querySelector('[x-cpm-btn]')) return;

        await parent.setStyle('position', 'relative');

        const btn = await rootDoc.createElement('button');
        await btn.setAttribute('x-cpm-btn', 'true');
        await btn.setInnerHTML('🧁');
        await btn.setStyleAttribute(
            'position:absolute; top:4px; right:4px; z-index:10000; ' +
            'background:rgba(59,130,246,0.8); border:none; border-radius:6px; ' +
            'padding:4px 8px; cursor:pointer; font-size:16px; opacity:0.6;'
        );
        await btn.setAttribute('x-title', '창 최대화 / 크기 조절');

        let isMaximized = false;

        // V3 API: pointerup + getBoundingClientRect 히트 테스트
        // 모든 이벤트 리스너가 document에 등록되므로,
        // 모든 pointerup에서 이 핸들러가 실행됨 → 히트 테스트로 실제 이 버튼 클릭 확인
        await btn.addEventListener('pointerup', async (e) => {
            const cx = e.clientX ?? e.x;
            const cy = e.clientY ?? e.y;
            if (typeof cx !== 'number' || typeof cy !== 'number') return;

            const rect = await btn.getBoundingClientRect();
            if (!rect) return;
            const rLeft = rect.left ?? rect.x ?? 0;
            const rTop = rect.top ?? rect.y ?? 0;
            const rRight = rect.right ?? (rLeft + (rect.width || 0));
            const rBottom = rect.bottom ?? (rTop + (rect.height || 0));

            if (cx < rLeft - 5 || cx > rRight + 5 || cy < rTop - 5 || cy > rBottom + 5) {
                return; // 이 버튼에 대한 클릭 아님
            }

            if (!isMaximized) {
                isMaximized = true;
                await injectStyles();
                await ta.setAttribute('x-cpm-maximized', 'true');
                await btn.setAttribute('x-cpm-maximized-btn', 'true');
            } else {
                isMaximized = false;
                await ta.setAttribute('x-cpm-maximized', 'false');
                await btn.setAttribute('x-cpm-maximized-btn', 'false');
            }
        });

        await parent.appendChild(btn);
    } catch (err) {
        console.warn(`${LOG} Failed to attach button:`, err);
    }
}

(async () => {
    // ── Hot-reload cleanup ──
    if (typeof window._cpmResizerCleanup === 'function') {
        try { await window._cpmResizerCleanup(); } catch (_) {}
    }

    try {
        // STB-7: Chat Resizer 활성화/비활성화 토글
        try {
            const enableFlag = await Risu.getArgument('cpm_enable_chat_resizer');
            if (enableFlag === false || enableFlag === 'false' || enableFlag === '0' || enableFlag === 'off') {
                console.log(`${LOG} Disabled by user setting (cpm_enable_chat_resizer=${enableFlag})`);
                return;
            }
        } catch (_) { /* 설정 읽기 실패 시 기본 활성화 */ }

        await preinitChatVars();

        for (let retry = 0; retry < 5; retry++) {
            try {
                rootDoc = await Risu.getRootDocument();
                if (rootDoc) break;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 500));
        }
        if (!rootDoc) { console.error(`${LOG} rootDoc failed`); return; }
        console.log(`${LOG} rootDoc acquired`);

        const body = await rootDoc.querySelector('body');
        if (!body) return;

        // Always scrub once at startup
        await scrubBackgroundNull();

        // Inject maximizer CSS early
        await injectStyles();

        // === MutationObserver (PRIMARY mechanism) ===
        // V3 API: Risu.createMutationObserver 필수 (new MutationObserver 사용 불가)
        let scanPending = false;
        let nullPending = false;
        const observer = await Risu.createMutationObserver(async () => {
            if (!scanPending) {
                scanPending = true;
                setTimeout(async () => {
                    scanPending = false;
                    try {
                        // V3 API: querySelectorAll 사용 불가 — 순회 querySelector
                        for (let i = 0; i < 3; i++) {
                            const ta = await rootDoc.querySelector('textarea:not([x-cpm-resizer])');
                            if (!ta) break;
                            await attachButtonToTextarea(ta);
                        }
                    } catch (_) {}
                }, 400);
            }
            if (!nullPending) {
                nullPending = true;
                setTimeout(async () => { nullPending = false; await scrubBackgroundNull(); }, 250);
            }
        });
        await observer.observe(body, { childList: true, subtree: true });

        // Initial scan: process up to 5 visible textareas
        for (let i = 0; i < 5; i++) {
            try {
                const ta = await rootDoc.querySelector('textarea:not([x-cpm-resizer])');
                if (!ta) break;
                await attachButtonToTextarea(ta);
            } catch (_) { break; }
        }

        // ── Hot-reload cleanup registration ──
        window._cpmResizerCleanup = async () => {
            try { await observer.disconnect(); } catch (_) {}
        };

        console.log(`${LOG} Loaded and ready.`);
    } catch (err) {
        console.error(`${LOG} Initialization error:`, err);
    }
})();
