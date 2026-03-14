// @ts-check
/**
 * update-toast.js — Toast notification UI for auto-update system.
 *
 * Migrated from temp_repo (update-toast.js).
 * Adapted for IPC architecture — uses dependency-injected Risu & escHtml.
 */

/**
 * @typedef {Object} UpdateInfo
 * @property {string} name
 * @property {string} icon
 * @property {string} localVersion
 * @property {string} remoteVersion
 * @property {string} [changes]
 */

/**
 * Create update toast methods with dependency injection.
 *
 * @param {{ Risu: any, escHtml: (s: string) => string }} deps
 * @returns {{ showUpdateToast: (updates: UpdateInfo[]) => Promise<void>, showMainAutoUpdateResult: (localVersion: string, remoteVersion: string, changes: string, success: boolean, error?: string) => Promise<void> }}
 */
export function createUpdateToast({ Risu, escHtml }) {
    return {
        /**
         * Show a toast for available sub-plugin updates.
         * @param {UpdateInfo[]} updates
         */
        async showUpdateToast(updates) {
            try {
                const doc = await Risu.getRootDocument();
                if (!doc) { console.debug('[CPM Toast] getRootDocument returned null'); return; }

                const existing = await doc.querySelector('[x-cpm-toast]');
                if (existing) { try { await existing.remove(); } catch (_) { } }

                const count = updates.length;
                let detailLines = '';
                const showMax = Math.min(count, 3);
                for (let i = 0; i < showMax; i++) {
                    const u = updates[i];
                    const changeText = u.changes ? ` — ${escHtml(u.changes)}` : '';
                    detailLines += `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${escHtml(u.icon)} ${escHtml(u.name)} <span style="color:#6ee7b7">${escHtml(u.localVersion)} → ${escHtml(u.remoteVersion)}</span>${changeText}</div>`;
                }
                if (count > showMax) {
                    detailLines += `<div style="font-size:11px;color:#6b7280;margin-top:2px">...외 ${count - showMax}개</div>`;
                }

                const toast = await doc.createElement('div');
                await toast.setAttribute('x-cpm-toast', '1');
                const styles = {
                    position: 'fixed', bottom: '20px', right: '20px', zIndex: '99998',
                    background: '#1f2937', border: '1px solid #374151', borderLeft: '3px solid #3b82f6',
                    borderRadius: '10px', padding: '12px 14px', maxWidth: '380px', minWidth: '280px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                    pointerEvents: 'auto', opacity: '0', transform: 'translateY(12px)',
                    transition: 'opacity 0.3s ease, transform 0.3s ease',
                };
                for (const [k, v] of Object.entries(styles)) await toast.setStyle(k, v);

                await toast.setInnerHTML(`
                    <div style="display:flex;align-items:flex-start;gap:10px">
                        <div style="font-size:20px;line-height:1;flex-shrink:0">🧁</div>
                        <div style="flex:1;min-width:0">
                            <div style="font-size:13px;font-weight:600;color:#e5e7eb">플러그인 업데이트 ${count}개 있음</div>
                            ${detailLines}
                            <div style="font-size:11px;color:#6b7280;margin-top:4px">설정에서 업데이트하세요</div>
                        </div>
                    </div>
                `);

                const body = await doc.querySelector('body');
                if (body) { await body.appendChild(toast); console.log('[CPM Toast] Toast appended to root body'); }
                else { console.debug('[CPM Toast] body not found'); return; }

                setTimeout(async () => { try { await toast.setStyle('opacity', '1'); await toast.setStyle('transform', 'translateY(0)'); } catch (_) { } }, 50);
                setTimeout(async () => {
                    try { await toast.setStyle('opacity', '0'); await toast.setStyle('transform', 'translateY(12px)');
                        setTimeout(async () => { try { await toast.remove(); } catch (_) { } }, 350);
                    } catch (_) { }
                }, 8000);
            } catch (/** @type {any} */ e) { console.debug('[CPM Toast] Failed to show toast:', e.message); }
        },

        /**
         * Show main plugin auto-update result toast.
         * @param {string} localVersion
         * @param {string} remoteVersion
         * @param {string} changes
         * @param {boolean} success
         * @param {string} [error]
         */
        async showMainAutoUpdateResult(localVersion, remoteVersion, changes, success, error) {
            try {
                const doc = await Risu.getRootDocument();
                if (!doc) { console.debug('[CPM MainToast] getRootDocument returned null'); return; }

                const existing = await doc.querySelector('[x-cpm-main-toast]');
                if (existing) { try { await existing.remove(); } catch (_) { } }

                const subToastEl = await doc.querySelector('[x-cpm-toast]');
                const bottomPos = subToastEl ? '110px' : '20px';

                const toast = await doc.createElement('div');
                await toast.setAttribute('x-cpm-main-toast', '1');
                const borderColor = success ? '#6ee7b7' : '#f87171';
                const styles = {
                    position: 'fixed', bottom: bottomPos, right: '20px', zIndex: '99999',
                    background: '#1f2937', border: '1px solid #374151', borderLeft: `3px solid ${borderColor}`,
                    borderRadius: '10px', padding: '12px 14px', maxWidth: '380px', minWidth: '280px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                    pointerEvents: 'auto', opacity: '0', transform: 'translateY(12px)',
                    transition: 'opacity 0.3s ease, transform 0.3s ease',
                };
                for (const [k, v] of Object.entries(styles)) await toast.setStyle(k, v);

                const changesHtml = changes ? ` — ${escHtml(changes)}` : '';
                let html;
                if (success) {
                    html = `
                        <div style="display:flex;align-items:flex-start;gap:10px">
                            <div style="font-size:20px;line-height:1;flex-shrink:0">🧁</div>
                            <div style="flex:1;min-width:0">
                                <div style="font-size:13px;font-weight:600;color:#6ee7b7">✓ 메인 플러그인 자동 업데이트 완료</div>
                                <div style="font-size:11px;color:#9ca3af;margin-top:2px">Cupcake PM <span style="color:#6ee7b7">${escHtml(localVersion)} → ${escHtml(remoteVersion)}</span>${changesHtml}</div>
                                <div style="font-size:11px;color:#fcd34d;margin-top:4px;font-weight:500">⚡ 3~4초 정도 기다린 뒤 새로고침하면 적용됩니다</div>
                            </div>
                        </div>`;
                } else {
                    html = `
                        <div style="display:flex;align-items:flex-start;gap:10px">
                            <div style="font-size:20px;line-height:1;flex-shrink:0">🧁</div>
                            <div style="flex:1;min-width:0">
                                <div style="font-size:13px;font-weight:600;color:#f87171">⚠️ 자동 업데이트 실패</div>
                                <div style="font-size:11px;color:#9ca3af;margin-top:2px">Cupcake PM ${escHtml(localVersion)} → ${escHtml(remoteVersion)}</div>
                                <div style="font-size:10px;color:#f87171;margin-top:2px">${escHtml(error || '알 수 없는 오류')}</div>
                                <div style="font-size:10px;color:#6b7280;margin-top:4px">리스 설정 → 플러그인 탭 → + 버튼으로 수동 업데이트하세요</div>
                            </div>
                        </div>`;
                }
                await toast.setInnerHTML(html);

                const body = await doc.querySelector('body');
                if (!body) { console.debug('[CPM MainToast] body not found'); return; }
                await body.appendChild(toast);

                setTimeout(async () => { try { await toast.setStyle('opacity', '1'); await toast.setStyle('transform', 'translateY(0)'); } catch (_) { } }, 50);
                const dismissDelay = success ? 10000 : 15000;
                setTimeout(async () => {
                    try { await toast.setStyle('opacity', '0'); await toast.setStyle('transform', 'translateY(12px)');
                        setTimeout(async () => { try { await toast.remove(); } catch (_) { } }, 350);
                    } catch (_) { }
                }, dismissDelay);
            } catch (/** @type {any} */ e) { console.debug('[CPM MainToast] Failed to show toast:', e.message || e); }
        },
    };
}
