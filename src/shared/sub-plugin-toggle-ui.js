// @ts-check
/**
 * sub-plugin-toggle-ui.js — Settings panel UI for per-sub-plugin auto-update toggles.
 *
 * Renders toggle switches in the RisuAI root document so users can
 * enable/disable auto-updates for individual sub-plugins.
 *
 * Follows the same DI pattern as update-toast.js:
 *   createSubPluginToggleUI({ Risu, escHtml }) → { renderTogglePanel, destroyTogglePanel }
 */

/** @typedef {{ name: string, enabled: boolean }} ToggleState */

const PANEL_ATTR = 'x-cpm-sub-toggle-panel';
const TOGGLE_ATTR = 'x-cpm-sub-toggle';

/**
 * @param {{ Risu: any, escHtml: (s: string) => string }} deps
 * @returns {{
 *   renderTogglePanel: (states: ToggleState[], onToggle: (name: string, enabled: boolean) => Promise<void>) => Promise<{ element: any, toggleCount: number }>,
 *   destroyTogglePanel: () => Promise<void>
 * }}
 */
export function createSubPluginToggleUI({ Risu, escHtml }) {

    /** @type {any} */
    let _panelElement = null;

    return {
        /**
         * Render toggle panel into the root document body.
         *
         * @param {ToggleState[]} states - Current toggle states from getSubPluginToggleStates()
         * @param {(name: string, enabled: boolean) => Promise<void>} onToggle - Callback when user flips a toggle
         * @returns {Promise<{ element: any, toggleCount: number }>}
         */
        async renderTogglePanel(states, onToggle) {
            if (!Array.isArray(states)) {
                throw new Error('states must be an array');
            }

            const doc = await Risu.getRootDocument();
            if (!doc) throw new Error('getRootDocument() returned null');

            // Remove existing panel if present
            const existing = await doc.querySelector(`[${PANEL_ATTR}]`);
            if (existing) { try { await existing.remove(); } catch (_) { } }

            const panel = await doc.createElement('div');
            await panel.setAttribute(PANEL_ATTR, '1');

            // Panel container styles
            const panelStyles = {
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '8px',
                padding: '16px',
                maxWidth: '420px',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            };
            for (const [k, v] of Object.entries(panelStyles)) {
                await panel.setStyle(k, v);
            }

            // Build inner HTML
            let html = `<div style="font-size:14px;font-weight:600;color:#e5e7eb;margin-bottom:12px">🧁 서브 플러그인 자동 업데이트 설정</div>`;

            if (states.length === 0) {
                html += `<div style="font-size:12px;color:#6b7280;padding:8px 0">등록된 서브 플러그인이 없습니다.</div>`;
            } else {
                for (let i = 0; i < states.length; i++) {
                    const s = states[i];
                    const safeName = escHtml(s.name);
                    const bgColor = s.enabled ? '#065f46' : '#374151';
                    const dotPos = s.enabled ? '20px' : '2px';
                    const statusText = s.enabled ? '자동 업데이트 활성' : '자동 업데이트 비활성';
                    const statusColor = s.enabled ? '#6ee7b7' : '#9ca3af';

                    html += `<div ${TOGGLE_ATTR}="${escHtml(s.name)}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #374151">`;
                    html += `<div style="flex:1;min-width:0">`;
                    html += `<div style="font-size:13px;color:#e5e7eb;font-weight:500">${safeName}</div>`;
                    html += `<div style="font-size:11px;color:${statusColor}">${statusText}</div>`;
                    html += `</div>`;
                    // Toggle switch
                    html += `<div x-cpm-toggle-btn="${i}" style="width:40px;height:22px;border-radius:11px;background:${bgColor};cursor:pointer;position:relative;transition:background 0.2s;flex-shrink:0;margin-left:12px">`;
                    html += `<div style="width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${dotPos};transition:left 0.2s"></div>`;
                    html += `</div>`;
                    html += `</div>`;
                }
            }

            await panel.setInnerHTML(html);

            // Attach click handlers for toggle buttons
            for (let i = 0; i < states.length; i++) {
                const toggleBtn = await panel.querySelector(`[x-cpm-toggle-btn="${i}"]`);
                if (toggleBtn) {
                    await toggleBtn.addEventListener('click', async () => {
                        const newEnabled = !states[i].enabled;
                        states[i].enabled = newEnabled;
                        await onToggle(states[i].name, newEnabled);
                        // Re-render panel to reflect new state
                        await this.renderTogglePanel(states, onToggle);
                    });
                }
            }

            const body = await doc.querySelector('body');
            if (body) {
                await body.appendChild(panel);
            }

            _panelElement = panel;
            return { element: panel, toggleCount: states.length };
        },

        /**
         * Remove the toggle panel from the document.
         */
        async destroyTogglePanel() {
            if (_panelElement) {
                try { await _panelElement.remove(); } catch (_) { }
                _panelElement = null;
                return;
            }
            // Fallback: query by attribute
            try {
                const doc = await Risu.getRootDocument();
                if (doc) {
                    const existing = await doc.querySelector(`[${PANEL_ATTR}]`);
                    if (existing) await existing.remove();
                }
            } catch (_) { }
        },
    };
}
