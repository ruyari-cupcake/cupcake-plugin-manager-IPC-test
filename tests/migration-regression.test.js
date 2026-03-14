import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import rollupConfigs from '../rollup.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(repoRoot, 'src');

function walkFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            found.push(...walkFiles(fullPath));
            continue;
        }
        if (fullPath.endsWith('.js')) found.push(fullPath);
    }
    return found;
}

describe('temp_repo migration regression guards', () => {
    it('keeps all migrated IPC bundle entry points wired into Rollup', () => {
        const actualOutputs = rollupConfigs
            .map((config) => config.output.file)
            .sort();

        expect(actualOutputs).toEqual([
            'dist/cpm-chat-navigation.js',
            'dist/cpm-chat-resizer.js',
            'dist/cpm-copilot-manager.js',
            'dist/cpm-provider-anthropic.js',
            'dist/cpm-provider-aws.js',
            'dist/cpm-provider-deepseek.js',
            'dist/cpm-provider-gemini.js',
            'dist/cpm-provider-openai.js',
            'dist/cpm-provider-openrouter.js',
            'dist/cpm-provider-vertex.js',
            'dist/cpm-translation-cache.js',
            'dist/cupcake-provider-manager.js',
        ]);
    });

    it('keeps runtime source free of eval-like execution and script-tag injection', () => {
        const offenders = [];
        const sourceFiles = walkFiles(srcRoot);

        for (const filePath of sourceFiles) {
            const source = readFileSync(filePath, 'utf8');
            const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
            const matches = [];

            if (/\beval\s*\(/.test(source)) matches.push('eval(');
            if (/\bnew Function\b/.test(source)) matches.push('new Function');
            if (/createElement\((['"])script\1\)/.test(source)) matches.push("createElement('script')");

            if (matches.length > 0) {
                offenders.push(`${relativePath}: ${matches.join(', ')}`);
            }
        }

        expect(offenders).toEqual([]);
    });

    it('keeps the migrated feature surface present in source', () => {
        const expectedSources = [
            'src/features/copilot.js',
            'src/features/navigation.js',
            'src/features/resizer.js',
            'src/features/transcache.js',
            'src/manager/index.js',
            'src/providers/anthropic.js',
            'src/providers/aws.js',
            'src/providers/deepseek.js',
            'src/providers/gemini.js',
            'src/providers/openai.js',
            'src/providers/openrouter.js',
            'src/providers/vertex.js',
        ];

        const actualSources = rollupConfigs
            .map((config) => config.input.replace(/\\/g, '/'))
            .sort();

        expect(actualSources).toEqual(expectedSources.sort());
    });
});