# Cupcake Provider V4 — Source-Truth Migration Report (2026-03-10)

## Scope
Strict re-audit of migratable stability/security/feature work from `_temp_repo` into `cupcake-provider-v4`, validated against current source and V3 IPC constraints.

## Architectural conclusion
- `_temp_repo`: sub-plugin-inside-plugin architecture.
- `cupcake-provider-v4`: independent V3 plugins over channel IPC.
- `risuai-main` / current host APIs are sufficient for the following classes of migration:
  - provider request/response logic
  - streaming pass-through where structured-clone allows it
  - dynamic model discovery
  - settings UI / persistence / backup
  - feature plugins using DOM/storage/network APIs
- Non-migratable parts are mostly architecture-specific bootstrapping/injection details, not end-user features.

## Important audit result
Earlier markdown reports were partially stale. A large portion of items previously marked as "missing" were already present in current source.

## Already present before this patch session
Confirmed in current `cupcake-provider-v4` source before edits:
- `escHtml`, `extractImageUrlFromPart`, `_stripNonSerializable`, `smartFetch`
- schema validation helpers
- Copilot `data.data` fallback
- OpenAI model override / service tier / prompt cache retention
- Anthropic custom URL / model override / thinking / cache compatibility
- Gemini model override / `chat_gemini_usePlainFetch`
- Vertex region fallback
- DeepSeek max-token clamp
- OpenRouter reasoning `max_tokens`
- resizer ON/OFF toggle
- large existing test suite already green

## Confirmed runtime gaps patched in this session

### 1. Manager runtime backup was still using stale inline implementation
Problem:
- Runtime manager still used an older local `SettingsBackup` object.
- Shared `settings-backup.js` had the stronger implementation, but runtime was not using it.

Patched:
- Manager now uses shared `createSettingsBackup(...)`.

Effect:
- runtime now gets the broader key inventory
- runtime now gets schema-validated backup loading
- runtime backup behavior now matches tested shared implementation much more closely

Files:
- `src/manager/index.js`

### 2. Token-usage streaming setting existed but was not actually wired through manager runtime
Problem:
- providers looked for `cpm_streaming_show_token_usage`
- backup/tests knew about the key
- manager runtime did **not** collect/send that key to providers
- manager UI also did not expose the checkbox

Patched:
- manager now forwards `cpm_streaming_show_token_usage`
- legacy `_temp_repo` key `cpm_show_token_usage` is accepted as fallback
- manager UI now exposes the checkbox
- providers also accept both key names for compatibility

Files:
- `src/manager/index.js`
- `src/providers/openai.js`
- `src/providers/deepseek.js`
- `src/shared/settings-backup.js`

### 3. AWS runtime model-id normalization was only partially applied
Problem:
- dynamic-model helper already had `normalizeAwsAnthropicModelId(...)`
- runtime AWS provider still used a simpler prefix hack

Patched:
- AWS provider now uses the shared normalization helper
- helper now preserves existing `eu.` prefixes too

Files:
- `src/providers/aws.js`
- `src/shared/dynamic-models.js`

### 4. OpenRouter streaming parity gap
Problem:
- `_temp_repo` OpenRouter supported streaming + `stream_options.include_usage`
- `cupcake-provider-v4` OpenRouter provider was effectively non-streaming only

Patched:
- OpenRouter provider now honors global streaming flag
- returns SSE stream through `createOpenAISSEStream(...)`
- supports token-usage stream options with new and legacy setting keys
- non-stream parsing now also receives `requestId`

Files:
- `src/providers/openrouter.js`

### 5. Second-pass provider max-token safeguard parity
Problem:
- `_temp_repo` still had explicit provider-side clamp guards that were not yet restored in current V4 source
- Gemini-family requests could exceed model-family `maxOutputTokens` ceilings
- Vertex Claude/Gemini paths and AWS Claude path also lacked the same hard cap protection from `_temp_repo`

Patched:
- Gemini provider now clamps older Gemini-family models to `8192`
- Gemini `2.5+` / `3.x` family now clamps to `65536`
- Vertex Gemini path now applies the same model-family clamp before request construction
- Vertex Claude path now clamps `max_tokens` to `128000`
- AWS Bedrock path now clamps `max_tokens` to `128000`

Files:
- `src/providers/gemini.js`
- `src/providers/vertex.js`
- `src/providers/aws.js`

### 6. Final-pass Copilot manager quota/diagnostics parity
Problem:
- V4 manager already had Copilot token generation, verification, model listing, quota lookup, diagnostics tab, and API log tab
- but quota rendering was still slimmer than `_temp_repo` in a few concrete ways:
  - no proxy-cache warning when `/copilot_internal/user` returned token-endpoint-shaped data
  - old-format `quota_snapshots` secondary quota panels were not shown
  - new-format `limited_user_quotas` labels were less flexible
  - token metadata detail panel was missing from quota output
  - raw fallback panel for unrecognized quota payloads was missing

Patched:
- manager now flags and surfaces proxy-cache warning state for Copilot quota fetches
- old `quota_snapshots` path now shows secondary quota cards, overage state, and reset info
- new `limited_user_quotas` path now supports `name/type/key` label fallback and raw-item fallback
- token metadata detail panel restored in the quota result UI
- raw API payload details remain available in collapsible form

Files:
- `src/manager/index.js`

## Tests added/updated
Updated regression coverage for:
- AWS normalization helper behavior
- preservation of `eu.` AWS prefixes
- legacy token-usage key compatibility
- OpenRouter streaming flag pattern
- backup key inventory including legacy token-usage key
- Gemini/Vertex/AWS max-token clamp parity
- Copilot quota proxy-warning / label / token-meta parity patterns

Files:
- `tests/provider-patches.test.js`
- `tests/dynamic-models.test.js`
- `tests/settings-backup.test.js`

## Validation result
Full test suite passed after patching.

Final result:
- Test files: `25` passed
- Tests: `549` passed

## Current source-truth status after this patch session
### Migrated / active
- core provider overrides and dynamic-model features: largely active
- streaming pass-through foundation: active
- token-usage stream wiring: active
- runtime settings backup alignment: improved and active
- AWS normalization parity: improved and active
- OpenRouter streaming parity: improved and active
- Gemini/Vertex/AWS provider-side clamp safeguards: restored and active

### Re-reviewed in second pass
- translation-cache display replacement path: already present in V4
- resizer null-overlay cleanup path: already present in V4
- Copilot manager quota/device-flow/model-list path: already present in V4
- navigation feature already has a substantial V3-safe implementation; no newly proven missing runtime delta was confirmed in this pass

### Re-reviewed in final pass
- manager diagnostics tab: already present in V4
- manager standalone API log tab: already present in V4
- remaining concrete Copilot quota UI/runtime parity gaps: patched

### Still requiring deeper line-by-line parity review
The following areas are large enough that they still deserve continued strict comparison, even though they already contain substantial implementation:
- feature plugin UX parity for navigation edge details
- manager diagnostics/API-log UI parity details
- provider-by-provider edge-case parity outside already tested paths

At this point, these are residual polish-review items rather than confirmed missing migrations.

These are no longer broad unknowns; they are now narrow parity-review items.

## Bottom line
`cupcake-provider-v4` was already much closer to `_temp_repo` parity than older reports suggested.
The main confirmed runtime deltas found in this session were real and have now been patched and tested.
