# CPM IPC Coverage Report (2025-06-14)

## Summary

| Metric | Value |
|--------|-------|
| **Test Files** | 65 passed |
| **Tests** | 2,555 passed |
| **Statements** | 94.39% |
| **Branches** | 87.32% |
| **Functions** | 96.56% |
| **Lines** | 96.24% |

## Per-Module Coverage

| Module | % Stmts | % Branch | % Funcs | % Lines | Notes |
|--------|---------|----------|---------|---------|-------|
| api-request-log.js | 100 | 100 | 100 | 100 | ✅ |
| auto-updater.js | 93.49 | 81.53 | 97.95 | 94.12 | Deep integration paths |
| aws-signer.js | 100 | 94.07 | 100 | 100 | |
| companion-installer.js | 100 | 94 | 100 | 100 | |
| copilot-headers.js | 100 | 100 | 100 | 100 | ✅ |
| copilot-token.js | 100 | 97.56 | 100 | 100 | |
| custom-model-serialization.js | 100 | 91.01 | 100 | 100 | |
| dynamic-models.js | 100 | 92.7 | 100 | 100 | |
| endpoints.js | 100 | 85.71 | 100 | 100 | Dead code: fallback unreachable |
| gemini-helpers.js | 100 | 98.5 | 100 | 100 | |
| helpers.js | 86.46 | 82.67 | 86.48 | 93.35 | Deep integration paths |
| ipc-protocol.js | 97.87 | 96.42 | 100 | 100 | |
| key-pool.js | 96 | 87.09 | 100 | 95.31 | Dead code: unreachable try-catch |
| message-format.js | 87.46 | 78.43 | 100 | 90.14 | Complex format transforms |
| model-helpers.js | 100 | 100 | 100 | 100 | ✅ |
| safe-db-writer.js | 98.27 | 91.48 | 100 | 98.24 | |
| sanitize.js | 96.07 | 93.44 | 100 | 98.24 | |
| schema.js | 100 | 100 | 100 | 100 | ✅ |
| settings-backup.js | 98.5 | 93.65 | 100 | 100 | |
| slot-inference.js | 100 | 100 | 100 | 100 | ✅ (was 89% → 100%) |
| sse-parser.js | 97.33 | 87.2 | 100 | 100 | |
| sub-plugin-toggle-ui.js | 92.18 | 88.46 | 75 | 91.22 | **NEW** Phase 3 UI module |
| token-toast.js | 100 | 90.9 | 100 | 100 | |
| token-usage.js | 98.46 | 96.87 | 100 | 100 | |
| update-toast.js | 85.71 | 96.66 | 55.55 | 92.59 | DOM-heavy, hard to test |

## Session Changes (since commit 22b4256)

### Code Quality Fixes (MEDIUM)
- **api-request-log.js**: Protected `id`/`timestamp` from patch injection
- **sse-parser.js**: Added `onComplete` deduplication flag
- **key-pool.js**: Added `maxResets=3` limit to prevent infinite retry loops

### Branch Coverage Push
- **slot-inference.js**: 89.13% → 100% (edge case tests)
- **+31 tests** in `branch-90-push.test.js` (ThoughtSignatureCache, sse-parser, key-pool, slot-inference, message-format)

### Sub-plugin Phase 3: UI Integration
- **NEW** `sub-plugin-toggle-ui.js`: Toggle panel UI module (DI pattern)
- **+16 tests** in `sub-plugin-toggle-ui.test.js`: rendering, XSS escaping, destroy, integration
- **Strengthened** checkVersionsQuiet filtering test: verifies `risuFetch` call count (was weak assertion)
- **+2 tests**: all-enabled (3 calls), all-disabled (1 call) verification
