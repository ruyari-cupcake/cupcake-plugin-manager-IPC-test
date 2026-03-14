/**
 * CPM Feature — Chat Navigation
 * 독립 V3 플러그인 (IPC 불필요)
 * 플로팅 위젯으로 채팅 메시지 간 빠른 이동
 * 모드 순환: 4버튼 → 2버튼 → 키보드 → OFF
 *
 * V3 Sandbox API 주의사항:
 *   - querySelectorAll 사용 불가 → nth-child + querySelector 패턴 사용
 *   - e.target 불가 → getBoundingClientRect() 히트 테스트
 *   - new MutationObserver() 불가 → Risu.createMutationObserver()
 *   - classList/getAttribute 제한 → matches() 또는 x-prefix 속성만 사용
 *   - getChildren().length 만 안전 (개별 아이템은 프록시 아님)
 */
const Risu = window.risuai || window.Risuai;
const LOG = '[CPM Nav]';

const WIDGET_ATTR_KEY = 'x-cpmnavi-widget';
const WIDGET_ATTR_VAL = 'container';
const MODES = ['four', 'two', 'keyboard', 'off'];
const MODE_LABELS = { four: '4버튼', two: '2버튼', keyboard: '⌨️키보드', off: 'OFF' };

(async () => {
    // ── Hot-reload cleanup ──
    if (typeof window._cpmNaviCleanup === 'function') {
        try { await window._cpmNaviCleanup(); } catch (e) { console.warn(`${LOG} Previous cleanup error:`, e); }
    }

    try {
        let rootDoc = null;
        let containerSelector = null;
        let currentIndex = 1;
        let isReady = false;
        let widgetElement = null;
        let containerPollTimer = null;
        let currentModeIndex = -1; // starts at -1 so first press → 0 (four)

        // Drag state
        let isDragging = false;
        let dragShiftX = 0;
        let dragShiftY = 0;
        let globalPointerMoveId = null;
        let globalPointerUpId = null;

        // Button refs for hit-test
        let upBtnRef = null;
        let downBtnRef = null;
        let topBtnRef = null;
        let bottomBtnRef = null;
        let handleRef = null;

        // Keyboard listener
        let keyListenerId = null;

        // Chat screen observer
        let domObserver = null;
        let observerTimer = null;
        let lastChatScreenState = null;

        // ── Root Document 획득 ──
        for (let retry = 0; retry < 5; retry++) {
            try {
                rootDoc = await Risu.getRootDocument();
                if (rootDoc) break;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 500));
        }
        if (!rootDoc) { console.error(`${LOG} rootDoc failed`); return; }
        console.log(`${LOG} rootDoc 획득 성공`);

        // ── 채팅 컨테이너 탐색 ──
        const findChatContainer = async () => {
            const selectors = [
                '.flex-col-reverse:nth-of-type(2)',
                '.flex-col-reverse:nth-of-type(1)',
                'main .flex-col-reverse',
                '.flex-col-reverse'
            ];
            for (const sel of selectors) {
                try {
                    const container = await rootDoc.querySelector(sel);
                    if (container) {
                        // V3 API: getChildren() 배열의 .length 만 안전 (아이템은 프록시 아님)
                        const children = await container.getChildren();
                        if (children && children.length >= 2) {
                            containerSelector = sel;
                            return true;
                        }
                    }
                } catch (_) {}
            }
            return false;
        };

        // ── 메시지 수 ──
        const getMessageCount = async () => {
            try {
                if (!containerSelector) return 0;
                const container = await rootDoc.querySelector(containerSelector);
                if (!container) return 0;
                const children = await container.getChildren();
                return children ? children.length : 0;
            } catch (_) { return 0; }
        };

        // ── 스크롤 함수들 ──
        // V3 API: querySelector + nth-child 패턴 (querySelectorAll 대신)
        const goToTop = async () => {
            if (!isReady) return;
            try {
                const count = await getMessageCount();
                if (count === 0) return;
                const el = await rootDoc.querySelector(`${containerSelector} > *:nth-child(${count})`);
                if (el) { await el.scrollIntoView(true); currentIndex = count; }
            } catch (e) { console.error(`${LOG} goToTop:`, e); }
        };

        const goToBottom = async () => {
            if (!isReady) return;
            try {
                const el = await rootDoc.querySelector(`${containerSelector} > *:nth-child(1)`);
                if (el) { await el.scrollIntoView(true); currentIndex = 1; }
            } catch (e) { console.error(`${LOG} goToBottom:`, e); }
        };

        const scrollUp = async () => {
            if (!isReady) return;
            try {
                const count = await getMessageCount();
                if (currentIndex < count) currentIndex++;
                const el = await rootDoc.querySelector(`${containerSelector} > *:nth-child(${currentIndex})`);
                if (el) await el.scrollIntoView(true);
            } catch (e) { console.error(`${LOG} scrollUp:`, e); }
        };

        const scrollDown = async () => {
            if (!isReady) return;
            try {
                if (currentIndex > 1) currentIndex--;
                const el = await rootDoc.querySelector(`${containerSelector} > *:nth-child(${currentIndex})`);
                if (el) await el.scrollIntoView(true);
            } catch (e) { console.error(`${LOG} scrollDown:`, e); }
        };

        // ── 위젯 제거 ──
        const destroyWidget = async () => {
            try {
                const body = await rootDoc.querySelector('body');
                const existing = await rootDoc.querySelector(`[${WIDGET_ATTR_KEY}="${WIDGET_ATTR_VAL}"]`);
                if (existing) await existing.remove();
                widgetElement = null;
                if (globalPointerMoveId) { try { await body.removeEventListener('pointermove', globalPointerMoveId); } catch (_) {} globalPointerMoveId = null; }
                if (globalPointerUpId) { try { await body.removeEventListener('pointerup', globalPointerUpId); } catch (_) {} globalPointerUpId = null; }
                topBtnRef = upBtnRef = downBtnRef = bottomBtnRef = handleRef = null;
            } catch (_) {}
        };

        // ── 키보드 리스너 등록/해제 ──
        const enableKeyboard = async () => {
            if (keyListenerId) return;
            try {
                const body = await rootDoc.querySelector('body');
                if (!body) return;
                keyListenerId = await body.addEventListener('keydown', async (e) => {
                    // V3 API: input/textarea 에서 방향키 가로채기 방지
                    try {
                        let tag = '';
                        if (e && e.target) {
                            try { tag = (typeof e.target.nodeName === 'function') ? String(await e.target.nodeName()).toLowerCase() : (e.target.tagName ? String(e.target.tagName).toLowerCase() : ''); } catch (_) {}
                        }
                        if (tag === 'input' || tag === 'textarea') return;
                        try { if (e.target && e.target.isContentEditable) return; } catch (_) {}
                    } catch (_) {}
                    switch (e.key) {
                        case 'ArrowUp':    await scrollUp();     break;
                        case 'ArrowDown':  await scrollDown();   break;
                        case 'ArrowLeft':  await goToTop();      break;
                        case 'ArrowRight': await goToBottom();   break;
                    }
                });
                console.log(`${LOG} 키보드 리스너 등록`);
            } catch (e) { console.error(`${LOG} 키보드 등록 실패:`, e); }
        };

        const disableKeyboard = async () => {
            if (!keyListenerId) return;
            try {
                const body = await rootDoc.querySelector('body');
                if (body) await body.removeEventListener('keydown', keyListenerId);
            } catch (_) {}
            keyListenerId = null;
            console.log(`${LOG} 키보드 리스너 해제`);
        };

        // ── 플로팅 위젯 생성 ──
        // mode: 'four' = ⏫🔼🔽⏬,  'two' = 🔼🔽
        const createWidget = async (mode) => {
            try {
                const body = await rootDoc.querySelector('body');

                const theme = {
                    handle: 'rgba(255, 255, 255, 0.3)',
                    handleActive: 'rgba(255, 255, 255, 0.8)',
                    btnBg: 'rgba(255, 255, 255, 0.05)',
                    btnBorder: 'rgba(255, 255, 255, 0.2)',
                    btnColor: 'rgba(255, 255, 255, 0.9)'
                };

                const container = await rootDoc.createElement('div');
                await container.setAttribute(WIDGET_ATTR_KEY, WIDGET_ATTR_VAL);
                await container.setStyleAttribute(`
                    position: fixed; bottom: 100px; right: 20px;
                    width: 60px !important; height: auto !important;
                    display: flex; flex-direction: column; gap: 8px;
                    align-items: center; justify-content: center;
                    z-index: 9999; padding: 8px; padding-top: 6px;
                    border-radius: 12px; background-color: rgba(0, 0, 0, 0);
                    user-select: none; -webkit-user-select: none;
                    cursor: default; touch-action: none;
                `);

                // Drag Handle
                const dragHandle = await rootDoc.createElement('div');
                await dragHandle.setStyleAttribute(`
                    width: 32px; height: 8px; background-color: ${theme.handle};
                    border-radius: 4px; cursor: move; margin-bottom: 2px;
                    flex-shrink: 0; pointer-events: none; transition: background-color 0.2s;
                `);

                const btnStyle = `
                    width: 40px !important; height: 40px !important;
                    border-radius: 50%; border: 1px solid ${theme.btnBorder};
                    background: ${theme.btnBg}; color: ${theme.btnColor};
                    display: flex; align-items: center; justify-content: center;
                    flex-shrink: 0; pointer-events: none; transition: background 0.2s;
                `;
                const iconStyle = 'pointer-events: none; width: 24px; height: 24px;';

                const upBtn = await rootDoc.createElement('div');
                await upBtn.setStyleAttribute(btnStyle);
                await upBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`);

                const downBtn = await rootDoc.createElement('div');
                await downBtn.setStyleAttribute(btnStyle);
                await downBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`);

                handleRef = dragHandle;
                upBtnRef = upBtn;
                downBtnRef = downBtn;
                topBtnRef = null;
                bottomBtnRef = null;

                await container.appendChild(dragHandle);

                if (mode === 'four') {
                    const topBtn = await rootDoc.createElement('div');
                    await topBtn.setStyleAttribute(btnStyle);
                    await topBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 11-6-6-6 6"/><path d="m18 17-6-6-6 6"/></svg>`);
                    topBtnRef = topBtn;
                    await container.appendChild(topBtn);
                }

                await container.appendChild(upBtn);
                await container.appendChild(downBtn);

                if (mode === 'four') {
                    const bottomBtn = await rootDoc.createElement('div');
                    await bottomBtn.setStyleAttribute(btnStyle);
                    await bottomBtn.setInnerHTML(`<svg style="${iconStyle}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 7 6 6 6-6"/><path d="m6 13 6 6 6-6"/></svg>`);
                    bottomBtnRef = bottomBtn;
                    await container.appendChild(bottomBtn);
                }

                await body.appendChild(container);
                widgetElement = container;

                // ── Mobile touch-action fix ──
                try {
                    if (widgetElement) {
                        const divs = await widgetElement.querySelectorAll('div');
                        if (divs) for (const div of divs) {
                            await div.setStyle('touch-action', 'none');
                        }
                    }
                } catch (_) {}

                // ── Click Handler (hit-test) ──
                // V3 API: 모든 이벤트 리스너가 document에 등록됨
                // getBoundingClientRect 히트 테스트로 어떤 버튼이 클릭되었는지 식별
                await container.addEventListener('click', async (e) => {
                    if (isDragging) return;
                    const cx = e.clientX;
                    const cy = e.clientY;
                    if (cx === undefined || cy === undefined) return;

                    const hitTest = async (ref, action) => {
                        if (!ref) return false;
                        const rect = await ref.getBoundingClientRect();
                        if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
                            await action();
                            return true;
                        }
                        return false;
                    };

                    if (topBtnRef && await hitTest(topBtnRef, goToTop)) return;
                    if (await hitTest(upBtnRef, scrollUp)) return;
                    if (await hitTest(downBtnRef, scrollDown)) return;
                    if (bottomBtnRef && await hitTest(bottomBtnRef, goToBottom)) return;
                });

                // ── Drag Handler ──
                const getEventXY = (e) => {
                    if (e.clientX !== undefined && e.clientY !== undefined) return { x: e.clientX, y: e.clientY };
                    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
                    if (t) return { x: t.clientX, y: t.clientY };
                    return { x: undefined, y: undefined };
                };

                try {
                    const onDragStart = async (e) => {
                        if (e.button !== undefined && e.button !== 0 && e.button !== -1) return;
                        const { x: cx, y: cy } = getEventXY(e);
                        if (cx === undefined || cy === undefined || !handleRef) return;

                        // V3 API: 히트 테스트로 드래그 핸들 확인
                        const handleRect = await handleRef.getBoundingClientRect();
                        const isInsideHandle =
                            cx >= handleRect.left && cx <= handleRect.right &&
                            cy >= handleRect.top && cy <= handleRect.bottom;
                        if (!isInsideHandle) return;

                        isDragging = true;
                        const rect = await container.getBoundingClientRect();
                        dragShiftX = cx - rect.left;
                        dragShiftY = cy - rect.top;

                        await dragHandle.setStyle('backgroundColor', theme.handleActive);

                        if (globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
                        if (globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);

                        const onDragMove = async (ev) => {
                            if (!isDragging || !widgetElement) return;
                            if (ev.preventDefault) ev.preventDefault();
                            const { x: mx, y: my } = getEventXY(ev);
                            if (mx === undefined || my === undefined) return;
                            await widgetElement.setStyle('bottom', 'auto');
                            await widgetElement.setStyle('right', 'auto');
                            await widgetElement.setStyle('left', `${mx - dragShiftX}px`);
                            await widgetElement.setStyle('top', `${my - dragShiftY}px`);
                        };

                        const onDragEnd = async () => {
                            if (isDragging) {
                                isDragging = false;
                                if (handleRef) await handleRef.setStyle('backgroundColor', theme.handle);
                            }
                            if (globalPointerMoveId) await body.removeEventListener('pointermove', globalPointerMoveId);
                            if (globalPointerUpId) await body.removeEventListener('pointerup', globalPointerUpId);
                            globalPointerMoveId = globalPointerUpId = null;
                        };

                        globalPointerMoveId = await body.addEventListener('pointermove', onDragMove);
                        globalPointerUpId = await body.addEventListener('pointerup', onDragEnd);
                    };

                    await container.addEventListener('pointerdown', onDragStart);
                } catch (dragErr) {
                    console.error(`${LOG} Drag setup error:`, dragErr);
                }

            } catch (e) {
                console.error(`${LOG} createWidget error:`, e);
            }
        };

        // ── 모드 순환 ──
        const cycleMode = async () => {
            currentModeIndex = (currentModeIndex + 1) % MODES.length;
            const mode = MODES[currentModeIndex];
            console.log(`${LOG} 모드 전환: ${MODE_LABELS[mode]}`);

            await destroyWidget();
            await disableKeyboard();

            switch (mode) {
                case 'four':    await createWidget('four'); break;
                case 'two':     await createWidget('two');  break;
                case 'keyboard': await enableKeyboard();    break;
                case 'off': break;
            }
        };

        // ── Chat screen observer (위젯 자동 숨김/표시) ──
        const checkChatScreen = async () => {
            try {
                const chatContainer = await rootDoc.querySelector('.flex-col-reverse');
                const isOnChat = !!chatContainer;
                if (isOnChat === lastChatScreenState) return;
                lastChatScreenState = isOnChat;
                if (widgetElement) {
                    await widgetElement.setStyle('display', isOnChat ? 'flex' : 'none');
                }
            } catch (_) {}
        };

        const startChatObserver = async () => {
            if (domObserver) return;
            try {
                const body = await rootDoc.querySelector('body');
                // V3 API: Risu.createMutationObserver 필수
                domObserver = await Risu.createMutationObserver(async () => {
                    if (observerTimer) clearTimeout(observerTimer);
                    observerTimer = setTimeout(checkChatScreen, 300);
                });
                await domObserver.observe(body, { childList: true, subtree: true });
            } catch (_) {}
        };

        // ── Chat 버튼 (모드 순환) ──
        try {
            await Risu.registerButton({
                name: '🧭 네비게이션',
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>`,
                iconType: 'html',
                location: 'chat'
            }, async () => {
                await cycleMode();
            });
            console.log(`${LOG} chat 버튼 등록 완료 (모드 순환)`);
        } catch (e) {
            console.error(`${LOG} chat 버튼 등록 실패:`, e);
        }

        // ── 초기화 ──
        await startChatObserver();
        await checkChatScreen();

        const tryFindContainer = async () => {
            for (let i = 0; i < 10; i++) {
                if (await findChatContainer()) {
                    isReady = true;
                    console.log(`${LOG} ✅ 네비게이션 준비 완료!`);
                    return;
                }
                await new Promise(r => setTimeout(r, 500));
            }
            console.warn(`${LOG} 채팅 컨테이너 못 찾음 — 채팅 화면에서 다시 시도됩니다.`);
        };

        tryFindContainer();

        containerPollTimer = setInterval(async () => {
            if (!isReady || !containerSelector) {
                const found = await findChatContainer();
                if (found) isReady = true;
            }
        }, 3000);

        // ── Hot-reload cleanup ──
        window._cpmNaviCleanup = async () => {
            console.log(`${LOG} Cleanup: tearing down previous instance...`);
            if (containerPollTimer) { clearInterval(containerPollTimer); containerPollTimer = null; }
            if (observerTimer) { clearTimeout(observerTimer); observerTimer = null; }
            if (domObserver) { try { await domObserver.disconnect(); } catch (_) {} domObserver = null; }
            await disableKeyboard();
            await destroyWidget();
            isReady = false;
            lastChatScreenState = null;
            currentModeIndex = -1;
        };

        console.log(`${LOG} 초기화 완료 (v2.1.0 모드 순환)`);
    } catch (err) {
        console.error(`${LOG} Initialization error:`, err);
    }
})();
