// token-toast.js — Shared: 토큰 사용량 토스트 알림
// Ported from temp_repo (token-toast.js)
import { getRisu } from './ipc-protocol.js';

/**
 * Show a lightweight toast notification with token usage information.
 * Displayed at the top-right corner, auto-dismisses after 6 seconds.
 * @param {string} modelName - Display name of the model
 * @param {{ input: number, output: number, reasoning: number, cached: number, total: number, reasoningEstimated?: boolean }} usage
 * @param {number} [durationMs] - Request duration in milliseconds
 */
export async function showTokenUsageToast(modelName, usage, durationMs) {
    if (!usage) return;
    try {
        const Risu = getRisu();
        const doc = await Risu.getRootDocument();
        if (!doc) return;

        // Remove previous token usage toast
        const existing = await doc.querySelector('[x-cpm-token-toast]');
        if (existing) { try { await existing.remove(); } catch (_) { } }

        // Format numbers with commas
        const fmt = (n) => n != null ? n.toLocaleString() : '0';
        const durationStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';

        // Build detail parts
        const parts = [];
        parts.push(`📥 ${fmt(usage.input)}`);
        parts.push(`📤 ${fmt(usage.output)}`);
        if (usage.reasoning > 0) parts.push(`${usage.reasoningEstimated ? '🗯≈' : '🗯'} ${fmt(usage.reasoning)}`);
        if (usage.cached > 0) parts.push(`💾 ${fmt(usage.cached)}`);
        if (durationStr) parts.push(`⏱️ ${durationStr}`);

        // Truncate model name for display
        const shortModel = modelName.length > 40 ? modelName.substring(0, 37) + '...' : modelName;

        const toast = await doc.createElement('div');
        await toast.setAttribute('x-cpm-token-toast', '1');
        await toast.setStyle('position', 'fixed');
        await toast.setStyle('top', '12px');
        await toast.setStyle('right', '12px');
        await toast.setStyle('zIndex', '99997');
        await toast.setStyle('background', 'rgba(17, 24, 39, 0.92)');
        await toast.setStyle('border', '1px solid #374151');
        await toast.setStyle('borderLeft', '3px solid #8b5cf6');
        await toast.setStyle('borderRadius', '8px');
        await toast.setStyle('padding', '8px 12px');
        await toast.setStyle('maxWidth', '420px');
        await toast.setStyle('minWidth', '200px');
        await toast.setStyle('boxShadow', '0 4px 16px rgba(0,0,0,0.4)');
        await toast.setStyle('fontFamily', "-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace");
        await toast.setStyle('pointerEvents', 'auto');
        await toast.setStyle('opacity', '0');
        await toast.setStyle('transform', 'translateY(-8px)');
        await toast.setStyle('transition', 'opacity 0.25s ease, transform 0.25s ease');
        await toast.setStyle('cursor', 'pointer');

        await toast.setInnerHTML(`
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:11px;color:#a78bfa;font-weight:600;white-space:nowrap">📊 ${shortModel}</span>
                <span style="font-size:11px;color:#6b7280">|</span>
                <span style="font-size:11px;color:#d1d5db;font-family:monospace;letter-spacing:0.5px">${parts.join(' <span style="color:#4b5563">·</span> ')}</span>
            </div>
        `);

        const body = await doc.querySelector('body');
        if (!body) return;
        await body.appendChild(toast);

        // Animate in
        setTimeout(async () => {
            try {
                await toast.setStyle('opacity', '1');
                await toast.setStyle('transform', 'translateY(0)');
            } catch (_) { }
        }, 30);

        // Click to dismiss
        try {
            await toast.addEventListener('click', async () => {
                try {
                    await toast.setStyle('opacity', '0');
                    await toast.setStyle('transform', 'translateY(-8px)');
                    setTimeout(async () => { try { await toast.remove(); } catch (_) { } }, 300);
                } catch (_) { }
            });
        } catch (_) { }

        // Auto-dismiss after 6 seconds
        setTimeout(async () => {
            try {
                await toast.setStyle('opacity', '0');
                await toast.setStyle('transform', 'translateY(-8px)');
                setTimeout(async () => { try { await toast.remove(); } catch (_) { } }, 300);
            } catch (_) { }
        }, 6000);

    } catch (e) {
        console.debug('[CPM TokenToast] Failed:', e.message);
    }
}

export const showTokenToast = showTokenUsageToast;
