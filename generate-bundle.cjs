/**
 * Generate update-bundle.json from dist/ build outputs.
 * Run: node generate-bundle.cjs
 *
 * Reads each dist/ JS file, extracts @name and @version from headers,
 * computes SHA-256 hash (after normalizing \r\n → \n), and produces:
 *
 *   { versions: { displayName → {version, file, sha256} }, code: { file → code } }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST_DIR = path.join(__dirname, 'dist');
const OUTPUT = path.join(__dirname, 'update-bundle.json');

if (!fs.existsSync(DIST_DIR)) {
    console.error('❌ dist/ not found. Run "npm run build" first.');
    process.exit(1);
}

const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.js')).sort();
const versions = {};
const code = {};

for (const file of files) {
    const filePath = path.join(DIST_DIR, file);
    // Normalize line endings for consistent hashing across OS
    const raw = fs.readFileSync(filePath, 'utf-8');
    const src = raw.replace(/\r\n/g, '\n');

    // Parse @name and @version from header comments
    const nameMatch = src.match(/\/\/@name\s+(.+)/);
    const versionMatch = src.match(/\/\/@version\s+(.+)/);

    const displayName = nameMatch ? nameMatch[1].trim() : file.replace('.js', '');
    const version = versionMatch ? versionMatch[1].trim() : '0.0.0';

    const hash = crypto.createHash('sha256').update(src, 'utf-8').digest('hex');

    const relFile = `dist/${file}`;
    versions[displayName] = { version, file: relFile, sha256: hash };
    code[relFile] = src;

    console.log(`✅ ${relFile} (${(src.length / 1024).toFixed(1)}KB) — v${version} [sha256:${hash.substring(0, 12)}…]`);
}

const bundle = { versions, code };
fs.writeFileSync(OUTPUT, JSON.stringify(bundle, null, 0), 'utf-8');
const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`\n📦 update-bundle.json generated: ${size}KB (${Object.keys(code).length} files)`);

// Also copy to dist/ for Vercel deployment
const distCopy = path.join(DIST_DIR, 'update-bundle.json');
fs.copyFileSync(OUTPUT, distCopy);
console.log(`📋 Copied to ${distCopy}`);
