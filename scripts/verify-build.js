/**
 * Build verification script for cupcake-provider-v4
 *
 * Checks:
 *  1. All 12 expected output files exist
 *  2. Each has //@api 3.0 header
 *  3. Each has //@name header
 *  4. No empty files
 *  5. Basic size sanity check
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const DIST_DIR = 'dist';

const EXPECTED_FILES = [
    'cupcake-provider-manager.js',
    'cpm-provider-anthropic.js',
    'cpm-provider-openai.js',
    'cpm-provider-gemini.js',
    'cpm-provider-vertex.js',
    'cpm-provider-aws.js',
    'cpm-provider-deepseek.js',
    'cpm-provider-openrouter.js',
    'cpm-copilot-manager.js',
    'cpm-translation-cache.js',
    'cpm-chat-resizer.js',
    'cpm-chat-navigation.js',
];

let passed = 0;
let failed = 0;
const errors = [];

function check(condition, label) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        errors.push(label);
        console.log(`  ❌ ${label}`);
    }
}

console.log('\n🔍 cupcake-provider-v4 Build Verification\n');
console.log(`Checking ${EXPECTED_FILES.length} expected output files in ${DIST_DIR}/\n`);

// Check dist directory exists
let distFiles = [];
try {
    distFiles = readdirSync(DIST_DIR);
} catch (e) {
    console.log(`❌ dist/ directory not found. Did you run 'npm run build'?\n`);
    process.exit(1);
}

for (const fileName of EXPECTED_FILES) {
    console.log(`📄 ${fileName}:`);

    // File exists
    check(distFiles.includes(fileName), `File exists`);
    if (!distFiles.includes(fileName)) {
        console.log('');
        continue;
    }

    const filePath = join(DIST_DIR, fileName);
    const stat = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Not empty
    check(stat.size > 100, `Not empty (${(stat.size / 1024).toFixed(1)} KB, ${lines.length} lines)`);

    // Has //@api 3.0
    check(content.startsWith('//@api 3.0'), `Has //@api 3.0 header`);

    // Has //@name
    check(lines.some(l => l.startsWith('//@name ')), `Has //@name metadata`);

    // Has //@version
    check(lines.some(l => l.startsWith('//@version ')), `Has //@version metadata`);

    // Contains IIFE wrapper
    check(content.includes('(function') || content.includes('!function'), `Contains IIFE wrapper`);

    console.log('');
}

// Extra files check
const extraFiles = distFiles.filter(f => f.endsWith('.js') && !EXPECTED_FILES.includes(f));
if (extraFiles.length > 0) {
    console.log(`⚠️ Extra files in dist/: ${extraFiles.join(', ')}\n`);
}

// Summary
console.log('═'.repeat(50));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
if (errors.length > 0) {
    console.log(`\n❌ Failed checks:`);
    errors.forEach(e => console.log(`   - ${e}`));
}
console.log(failed === 0 ? '\n✅ All checks passed!\n' : '\n❌ Some checks failed.\n');
process.exit(failed === 0 ? 0 : 1);
