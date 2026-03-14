/** @typedef {{ patterns: RegExp[], weight: number }} SlotHeuristic */
/** @typedef {Record<string, SlotHeuristic>} SlotHeuristicMap */

export const CPM_SLOT_LIST = ['translation', 'emotion', 'memory', 'other'];

/** @type {SlotHeuristicMap} */
export const SLOT_HEURISTICS = {
    translation: {
        patterns: [
            /translat(?:e|ion|ing)/i, /번역/, /翻[译訳]/,
            /source\s*(?:language|lang|text)/i, /target\s*(?:language|lang)/i,
            /\b(?:en|ko|ja|zh|de|fr|es|ru)\s*(?:→|->|to|에서|으로)\s*(?:en|ko|ja|zh|de|fr|es|ru)\b/i,
            /\[(?:SL|TL|Source|Target)\]/i,
            /output\s*(?:only\s*)?(?:the\s+)?translat/i,
        ],
        weight: 2,
    },
    emotion: {
        patterns: [
            /emotion|감정|표정|expression|mood|sentiment/i, /\bemote\b/i,
            /facial\s*express/i,
            /character.*(?:emotion|feeling|mood)/i,
            /(?:detect|classify|analyze).*(?:emotion|sentiment)/i,
        ],
        weight: 2,
    },
    memory: {
        patterns: [
            /summar(?:y|ize|izing|isation)/i, /요약/,
            /\bmemory\b/i, /메모리/, /\brecap\b/i,
            /condense.*(?:context|conversation|chat)|compress.*(?:context|conversation|chat)/i,
            /key\s*(?:points|events|details)/i,
            /\bhypa(?:memory|v[23])\b/i, /\bsupa(?:memory)?\b/i,
        ],
        weight: 2,
    },
    other: {
        patterns: [
            /\blua\b/i, /\bscript/i, /\btrigger\b/i, /트리거/,
            /\bfunction\s*call/i, /\btool\s*(?:use|call)/i,
            /\bexecute\b/i, /\butility\b/i, /\bhelper\b/i,
        ],
        weight: 1,
    },
};

/**
 * @param {string} promptText
 * @param {string} slotName
 * @param {SlotHeuristicMap} [heuristics]
 */
export function scoreSlotHeuristic(promptText, slotName, heuristics = SLOT_HEURISTICS) {
    const h = heuristics[slotName];
    if (!h || !promptText) return 0;
    let score = 0;
    for (const p of h.patterns) {
        if (p.test(promptText)) score += h.weight;
    }
    return score;
}

/**
 * @param {{ uniqueId?: string }} activeModelDef
 * @param {Record<string, any>} args
 * @param {{ safeGetArg: (key: string, defaultValue?: string) => Promise<string>, slotList?: string[], heuristics?: SlotHeuristicMap }} deps
 */
export async function inferSlot(activeModelDef, args, deps) {
    const safeGetArg = deps?.safeGetArg;
    const slotList = deps?.slotList || CPM_SLOT_LIST;
    const heuristics = deps?.heuristics || SLOT_HEURISTICS;
    if (typeof safeGetArg !== 'function') throw new Error('inferSlot requires safeGetArg');

    const matchingSlots = [];
    for (const slot of slotList) {
        const configuredId = await safeGetArg(`cpm_slot_${slot}`, '');
        if (configuredId && configuredId === activeModelDef.uniqueId) matchingSlots.push(slot);
    }
    if (matchingSlots.length === 0) return { slot: 'chat', heuristicConfirmed: false };

    const isMultiCollision = matchingSlots.length > 1;

    let promptText = '';
    if (args?.prompt_chat && Array.isArray(args.prompt_chat)) {
        for (let i = 0; i < args.prompt_chat.length; i++) {
            const m = args.prompt_chat[i];
            if (!m) continue;
            const content = typeof m.content === 'string' ? m.content : '';
            if (m.role === 'system' || i < 3 || i >= args.prompt_chat.length - 2) promptText += content + '\n';
        }
        promptText = promptText.substring(0, 3000);
    }
    if (!promptText.trim()) return { slot: 'chat', heuristicConfirmed: false };

    let bestSlot = null;
    let bestScore = 0;
    let secondBest = 0;
    for (const slot of matchingSlots) {
        const score = scoreSlotHeuristic(promptText, slot, heuristics);
        if (score > bestScore) {
            secondBest = bestScore;
            bestScore = score;
            bestSlot = slot;
        } else if (score > secondBest) {
            secondBest = score;
        }
    }

    if (bestSlot && bestScore > 0) {
        if (!isMultiCollision || bestScore > secondBest) {
            return { slot: bestSlot, heuristicConfirmed: true };
        }
    }

    return { slot: 'chat', heuristicConfirmed: false };
}
