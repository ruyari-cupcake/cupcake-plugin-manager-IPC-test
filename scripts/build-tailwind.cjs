/**
 * build-tailwind.cjs — Generate inline Tailwind CSS for the settings UI.
 *
 * Runs the Tailwind CLI to scan settings-ui source files for used utility
 * classes, then embeds the minified CSS into a JS module that can be imported
 * at runtime to inject a <style> tag instead of loading the CDN.
 *
 * Usage: node scripts/build-tailwind.cjs
 * Output: src/shared/tailwind-css.generated.js
 */
'use strict';

const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const INPUT = join(ROOT, 'styles', 'tailwind-input.css');
const TMP_OUTPUT = join(ROOT, 'dist', 'tailwind.min.css');
const JS_OUTPUT = join(ROOT, 'src', 'shared', 'tailwind-css.generated.js');

// Ensure dist/ exists
if (!existsSync(join(ROOT, 'dist'))) {
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
}

// If no styles/tailwind-input.css, skip build (use pre-generated CSS)
if (!existsSync(INPUT)) {
    console.log('[build-tailwind] No styles/tailwind-input.css found — skipping (using pre-generated CSS).');
    process.exit(0);
}

console.log('[build-tailwind] Running Tailwind CLI...');
execSync(
    `npx @tailwindcss/cli -i "${INPUT}" -o "${TMP_OUTPUT}" --minify`,
    { cwd: ROOT, stdio: 'inherit' },
);

const css = readFileSync(TMP_OUTPUT, 'utf-8').trim();
const sizeKB = (Buffer.byteLength(css, 'utf-8') / 1024).toFixed(1);

// Escape backticks and ${} in the CSS for template literal safety
const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const jsContent = `// @generated — Do not edit manually.
// Built by scripts/build-tailwind.cjs from styles/tailwind-input.css
// Size: ${sizeKB} KB (minified)
export const TAILWIND_CSS = \`${escaped}\`;
`;

writeFileSync(JS_OUTPUT, jsContent, 'utf-8');
console.log(`[build-tailwind] Generated ${JS_OUTPUT} (${sizeKB} KB CSS)`);
