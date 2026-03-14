# Cupcake Provider v4 — Comprehensive Source Analysis Report

**Date:** 2026-03-10  
**Scope:** All source files under `cupcake-provider-v4/src/` (shared/, providers/, features/, manager/) + documentation files  
**Total files analyzed:** 29 source files + 5 documentation files + README

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Shared Modules (src/shared/)](#2-shared-modules)
3. [Providers (src/providers/)](#3-providers)
4. [Features (src/features/)](#4-features)
5. [Manager Hub (src/manager/)](#5-manager-hub)
6. [IPC Protocol Patterns](#6-ipc-protocol-patterns)
7. [Error Handling Patterns](#7-error-handling-patterns)
8. [Security Measures](#8-security-measures)
9. [Stability Patterns](#9-stability-patterns)
10. [Gaps, TODOs, and Missing Features](#10-gaps-todos-and-missing-features)
11. [Documentation Summary](#11-documentation-summary)
12. [Appendix: File-by-File Index](#12-appendix-file-by-file-index)

---

## 1. Architecture Overview

### Platform

RisuAI V3 Plugin System — each plugin runs inside an independent iframe sandbox with the Plugin Channel API for inter-plugin communication.

### Architecture Pattern

**IPC-based Hub-and-Spoke:**

```
┌─────────────────────────────────────────────────────────┐
│  RisuAI V3 Host (Svelte)                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Plugin Channel API                                │  │
│  │  postPluginChannelMessage / addPluginChannelListener│  │
│  └────┬──────────┬──────────┬──────────┬──────────┐   │  │
│       │          │          │          │          │   │  │
│  ┌────▼────┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼─┐ │  │
│  │ Manager │ │OpenAI │ │Claude │ │Gemini │ │ ... │ │  │
│  │ (Hub)   │ │Prov.  │ │Prov.  │ │Prov.  │ │     │ │  │
│  └─────────┘ └───────┘ └───────┘ └───────┘ └─────┘ │  │
│         IPC: fetch-request / response / abort / ctrl │  │
│         Features: Copilot, TransCache, Nav, Resizer  │  │
└─────────────────────────────────────────────────────────┘
```

### Build System

- **Rollup v4** — 12 independent IIFE bundles (no runtime dependencies between them)
- **Vitest** — 14 test files, 373 tests
- **ESLint 9** (flat config) + **Prettier 3**
- **TypeScript 5** — JSDoc-based `checkJs` type checking only (no TS compilation)

### Key Constraint: V3 Sandbox Limitations

- No `querySelectorAll` — use `nth-child` + `querySelector` chains
- No `e.target` in events — use `getBoundingClientRect()` hit-testing
- No `new MutationObserver` — use `Risu.createMutationObserver()`
- `AbortSignal` is NOT structured-cloneable — must be extracted before `postMessage`
- `ReadableStream` may not be structured-cloneable — tested via `checkStreamCapability()`
- `connect-src 'none'` CSP — all network goes through `risuFetch`/`nativeFetch`

---

## 2. Shared Modules

### 2.1 ipc-protocol.js (130 lines)

**Purpose:** IPC protocol constants and provider registration logic.

**Key Exports:**
- `MANAGER_NAME` — `'Cupcake Provider Manager'`
- `CH` — Channel names: `CONTROL`, `RESPONSE`, `FETCH`, `ABORT`
- `MSG` — Message type constants: `REGISTER_PROVIDER`, `REGISTER_ACK`, `FETCH_REQUEST`, `RESPONSE`, `ERROR`, `ABORT`, `DYNAMIC_MODELS_REQUEST`, `DYNAMIC_MODELS_RESULT`
- `safeUUID()` — Crypto-random UUID generator with Math.random fallback
- `getRisu()` — Returns `globalThis.risuAIBridge` with validation
- `registerWithManager(Risu, displayName, config)` — Exponential-backoff registration

**IPC Pattern:**
Provider sends `REGISTER_PROVIDER` on `CH.CONTROL` → Manager replies with `REGISTER_ACK`. Registration uses exponential backoff retry (max 12 retries, 500ms base, 5000ms max delay, 2s response timeout). Includes `onControlMessage` hook so providers can handle additional control messages (e.g., `DYNAMIC_MODELS_REQUEST`) within the same single control listener (critical fix — V3 supports only one listener per channel per plugin).

**Error Handling:** Timeout on ACK → retry with backoff. Final failure logs warning but doesn't crash plugin.

**Stability:** `safeUUID()` has `crypto.randomUUID()` → `crypto.getRandomValues()` → `Math.random()` triple fallback.

---

### 2.2 helpers.js (581 lines)

**Purpose:** Core fetch utilities, argument accessors, and serialization helpers.

**Key Exports:**
- `safeGetArg(key, defaultValue)` / `safeGetBoolArg(key, defaultValue)` — Safe `Risu.getArgument()` wrappers
- `setArg(key, value)` — Fire-and-forget `Risu.setArgument()`
- `safeStringify(obj)` — JSON.stringify with circular reference safety
- `smartFetch(url, options)` — Multi-strategy non-streaming fetch
- `streamingFetch(url, options)` — Streaming-optimized fetch (preserves ReadableStream body)
- `collectStream(stream, signal)` — Collects ReadableStream to string
- `checkStreamCapability()` — Tests if ReadableStream survives structured-clone via MessageChannel
- `sanitizeBodyForBridge(body)` — Deep-clones and strips non-clonable objects before postMessage

**`smartFetch()` Strategy (3-tier):**
1. Copilot path (URL contains `githubcopilot.com`): `nativeFetch` → `risuFetch(plainFetch)` → `risuFetch(plainFetchForce)`
2. Generic path: `risuFetch(plainFetchForce)` → `nativeFetch(proxy)` fallback

**`streamingFetch()` Strategy:**
Returns the raw `Response` object (not `.text()`) so the caller can consume the body as a ReadableStream.

**Error Handling:**
- `smartFetch` returns the first successful response (HTTP status irrelevant); only cascades on network/fetch errors
- AbortSignal is extracted from options before passing to `risuFetch` (BUG-1 fix for DataCloneError)
- Duplicate replay guard via `_seenBodies` WeakSet to prevent re-sending the same body object across fallback tiers

**Security:** `sanitizeBodyForBridge()` performs deep clone and removes functions, AbortSignals, and other non-serializable objects.

**Known Bug Fixes:** BUG-1 (AbortSignal structured-clone), BUG-2 (nativeFetch defense), BUG-S6-1/2/3/7/8 (streaming fixes)

---

### 2.3 message-format.js (468 lines)

**Purpose:** Converts RisuAI's unified message array into OpenAI, Anthropic, and Gemini API formats.

**Key Exports:**
- `formatToOpenAI(messages, config)` — Returns `OpenAIMessage[]`
- `formatToAnthropic(messages, config)` — Returns `{ messages, system }`
- `formatToGemini(messages, config)` — Returns `{ contents, systemInstruction }`

**`formatToOpenAI`:**
- `sysfirst`: Keeps leading system messages intact
- `altrole`: Merges consecutive same-role messages (C-2 fix)
- `mustuser`: Ensures first message is `user` role
- `mergesys`: Merges all system messages into first user message
- `developerRole`: Converts `system` → `developer` for GPT-5/o-series (BUG-Q4 fix)
- Null/undefined content filtering

**`formatToAnthropic`:**
- Leading system messages extracted to top-level `system` string
- Non-leading system → `user` message with `"system: content"` prefix (BUG-Q2 fix — preserves position)
- Always uses structured content blocks `[{type:'text', text}]` (BUG-Q1 fix — matches native RisuAI)
- `_origSources` tracking for Anthropic `cache_control` injection
- "Start" placeholder for first-user requirement (BUG-Q3 fix)

**`formatToGemini`:**
- System extraction to `systemInstruction`
- Non-leading system as `"system: content"` prefix (BUG-Q5 fix — matches native)
- Multimodal support: image/audio/video via `inlineData`/`fileData`
- Thought signature cache integration for thinking models
- `preserveSystem` mode to keep system messages in-place

**Error Handling:** Graceful degradation on malformed messages — nulls filtered, empty arrays return `[]`.

---

### 2.4 sanitize.js (190 lines)

**Purpose:** Message pre-processing: tag stripping, content normalization, multimodal extraction.

**Key Exports:**
- `sanitizeMessages(messages)` — Strips internal tags, stale captions, thought display content
- `sanitizeBodyJSON(jsonString)` — Regex-based cleanup of serialized body
- `extractNormalizedMessagePayload(msg)` — Extracts text/image/audio from any format
- `stripInternalTags(text)` — Removes `<qak>`, `<|risuai|>`, etc.
- `stripStaleAutoCaption(text)` — Removes expired auto-caption blocks
- `stripThoughtDisplayContent(text)` — Removes `<Thoughts>...</Thoughts>` wrappers
- `isInlaySceneWrapperText(text)` — Detects inlay scene wrapper messages

**Security:** Tag stripping prevents internal RisuAI control sequences from leaking to API providers.

---

### 2.5 sse-parser.js (553 lines)

**Purpose:** SSE streaming parsers for all providers + non-streaming response parsers.

**Key Exports:**
- `createSSEStream(response, lineParser, signal, onComplete)` — Generic SSE→text TransformStream
- `createOpenAISSEStream(response, signal, config)` — OpenAI SSE parser with `[DONE]` handling
- `createAnthropicSSEStream(response, signal, config)` — Anthropic delta/start/stop events
- `createResponsesAPISSEStream(response, signal, config)` — GPT-5.4+ Responses API SSE
- `parseGeminiSSELine(line, config)` — Gemini streaming line parser
- Non-streaming: `parseClaudeNonStreamingResponse()`, `parseGeminiNonStreamingResponse()`, `parseOpenAINonStreamingResponse()`, `parseResponsesAPINonStreamingResponse()`
- `ThoughtSignatureCache` — Static cache for Gemini thought signatures
- `saveThoughtSignatureFromStream(config)` — Persists thought signatures after stream completion

**Token Usage Integration (C-11):**
All parsers extract and normalize token usage:
- OpenAI: `usage` field in final chunk
- Anthropic: `message_start` + `message_delta` usage accumulation
- Gemini: `usageMetadata` in response candidates

**Thinking/Reasoning Display:**
- Claude thinking: `content_block_start` type `thinking` → wrapped in `<Thoughts>...</Thoughts>`
- Claude redacted thinking: `type: 'redacted_thinking'` support
- OpenAI reasoning: `choices[0].delta.reasoning_content` wrapped in `<Thoughts>...</Thoughts>`
- Responses API reasoning: `reasoning.summary[].text`

**Error Handling:**
- `onComplete` called on abort/error/cancel (C-1 fix) for proper resource cleanup
- Safety blocks (Gemini `PROHIBITED_CONTENT`) → return error with safety reason
- Malformed JSON lines → skip with console.warn

---

### 2.6 token-usage.js (155 lines) + token-toast.js (100 lines)

**Purpose:** Token usage normalization, in-memory tracking, and UI notification.

**Key Exports (token-usage.js):**
- `_normalizeTokenUsage(raw)` — Normalizes OpenAI/Anthropic/Gemini to `{input, output, reasoning, cached, total}`
- `_setTokenUsage(requestId, usage)` / `_takeTokenUsage(requestId)` — Store/retrieve
- `_estimateVisibleTextTokens(text)` — Heuristic estimator (chars/3.8)

**Normalization:**
- OpenAI: `prompt_tokens`/`completion_tokens`/`cache_read_input_tokens`
- Anthropic: `input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`; reasoning estimated from output_tokens minus visible text tokens
- Gemini: `promptTokenCount`/`candidatesTokenCount`/`cachedContentTokenCount`/`thoughtsTokenCount`

**Store:** Max 100 entries, keyed by `requestId` with `_stream`/`_nonstream` suffixes.

**token-toast.js:** Injects a toast notification into the host document via `getRootDocument()`. Auto-dismisses after 6s, click-to-dismiss, CSS animated.

---

### 2.7 key-pool.js (107 lines)

**Purpose:** API key rotation pool with automatic retry on rate-limit errors.

**Key Exports:**
- `KeyPool` class: `pick()`, `drain()`, `reset()`, `withRotation(fetchFn)`
- `KeyPool.fromJson(raw)` — Parses comma-separated or whitespace-separated keys, with JSON fallback for compound credentials (AWS)

**Retry Logic:**
- `withRotation(fn)`: Tries each key; on retryable status (429/529/503), drains current key and retries with next
- Default max retries: 30
- `reset()` restores original keys when pool is exhausted (M-8 fix)

---

### 2.8 aws-signer.js (200 lines)

**Purpose:** Complete AWS Signature V4 implementation for Bedrock API calls.

**Key Exports:**
- `AwsV4Signer` class: `sign()`, `signQuery()` — full SigV4 with credential caching
- `hmac()`, `hash()`, `buf2hex()`, `encodeRfc3986()` — Crypto primitives
- `guessServiceRegion(url)` — Extracts AWS service/region from URL patterns

**Security:** Uses Web Crypto API (`crypto.subtle`) exclusively. Credential caching per request (avoids re-deriving signing keys).

---

### 2.9 dynamic-models.js (170 lines)

**Purpose:** Dynamic model discovery formatters and merge logic.

**Key Exports:**
- Provider-specific formatters: `formatOpenAIDynamicModels()`, `formatAnthropicDynamicModels()`, `formatGeminiDynamicModels()`, `formatDeepSeekDynamicModels()`, `formatOpenRouterDynamicModels()`, `formatVertexGoogleModels()`, `formatVertexClaudeModels()`, `formatAwsDynamicModels()`
- `normalizeAwsAnthropicModelId(arn)` — Extracts model ID from ARN
- `mergeDynamicModels(existing, fetched)` — Dedup merge by `uniqueId`

**Filtering:** OpenAI models filtered to gpt-4/5, chatgpt-, o1/o3/o4 prefixes; excludes audio/realtime/embedding/tts/whisper.

---

### 2.10 model-helpers.js (90 lines)

**Purpose:** Model detection helpers for capability gating.

**Key Exports:**
- `supportsOpenAIReasoningEffort(model)` — o1/o3/o4/gpt-5 series
- `supportsOpenAIVerbosity(model)` — GPT-5 parameter models only
- `needsCopilotResponsesAPI(model)` — GPT-5.4+ (via Copilot proxy)
- `shouldStripOpenAISamplingParams(model)` — o3/o4-mini: no temp/top_p
- `shouldStripGPT54SamplingForReasoning(model, reasoning)` — GPT-5.4 with active reasoning
- `needsMaxCompletionTokens(model)` — GPT-4.5+/5+/o-series

---

### 2.11 gemini-helpers.js (100 lines)

**Purpose:** Gemini-specific parameter validation and thinking configuration.

**Key Exports:**
- `getGeminiSafetySettings()` — All 5 harm categories at `BLOCK_NONE` (BUG-Q11 fix)
- `validateGeminiParams(gc)` — Clamps temperature [0,2], topP [0,1], removes invalid values
- `geminiSupportsPenalty(model)` — Flash-lite/2.0-pro-exp don't support penalty
- `cleanExperimentalModelParams(gc, model)` — Strips unsupported params from experimental models
- `buildGeminiThinkingConfig(model, level, budget, isVertexAI)` — Gemini 3 (level-based) vs 2.5 (budget-based) config

**Thinking Config:**
- Gemini 3: `thinkingLevel` = MINIMAL/LOW/MEDIUM/HIGH (Vertex uses `thinking_level`)
- Gemini 2.5: `thinkingBudget` numeric; level→budget mapping (minimal:1024, low:4096, medium:10240, high:24576)

---

### 2.12 copilot-token.js (80 lines)

**Purpose:** GitHub Copilot API token management with caching.

**Key Exports:**
- `ensureCopilotApiToken(config)` — Exchange OAuth token for API token at `api.github.com/copilot_internal/v2/token`
- `getCopilotApiBase()` / `clearCopilotTokenCache()` / `sanitizeCopilotToken()`
- `setCopilotGetArgFn()` / `setCopilotFetchFn()` — Dependency injection for testing

**Stability:** Token cached until 60s before expiry. Singleton pending promise prevents duplicate exchange requests.

---

### 2.13 Other Shared Modules

**api-request-log.js (80 lines):** Circular buffer (max 50) for API request logging. Exports: `createApiRequestLog()`, `storeApiRequest()`, `updateApiRequest()`, `getLatestApiRequest()`, `getAllApiRequests()`, `getApiRequestById()`, `clearApiRequests()`.

**settings-backup.js (95 lines):** Settings backup/restore via `pluginStorage`. Factory function `createSettingsBackup()` dynamically collects all CPM settings keys.

**slot-inference.js (105 lines):** Heuristic slot inference (translation/emotion/memory/other) with multi-language patterns (EN/KO/CN/JP). Exports: `CPM_SLOT_LIST`, `scoreSlotHeuristic()`, `inferSlot()`.

**types.d.ts (253 lines):** TypeScript type definitions for JSDoc checkJs. Defines: `ChatMessage`, `ContentPart`, `Multimodal`, `ProviderResult`, format-specific types, SSE config types, IPC types, `RisuAPI` interface, `AwsCredentials`, `KeyPoolRotationOptions`.

---

## 3. Providers

All 7 providers share a common pattern:
1. Define static model list + settings fields
2. Register with manager via `registerWithManager()`
3. Listen on `CH.FETCH` for request messages
4. Call provider-specific API
5. Send result back on `CH.RESPONSE`
6. Handle `DYNAMIC_MODELS_REQUEST` via `onControlMessage` hook

### 3.1 anthropic.js (~190 lines)

**Models:** Claude 4.6 Sonnet/Opus, 4.5 Sonnet/Haiku/Opus, 4 Sonnet/Opus, 4.1 Opus

**Settings:** API key (multi-key rotation), custom URL, thinking budget, adaptive thinking effort (4.6), prompt caching toggle, 1-hour extended cache toggle

**Thinking:**
- Claude 4.6: Adaptive thinking (`type: 'adaptive'`) with `output_config.effort` levels
- Claude 4.5 and below: Budget-based thinking (`budget_tokens`)

**Key Details:**
- Beta headers: `interleaved-thinking-2025-05-14`, `output-128k-2025-02-19`, `extended-cache-ttl-2025-04-11`
- Dynamic model fetch with API pagination (max 50 pages)
- BUG-Q8 fix: Direct API path does NOT strip temperature during thinking mode (only Bedrock does)
- Token usage included in streaming via `message_start`/`message_delta`
- `_origSources` tracking in formatToAnthropic for cache_control injection

---

### 3.2 openai.js (~195 lines)

**Models:** GPT-4.1, ChatGPT-4o, GPT-5/5.1/5.2/5.3/5.4, GPT-5-mini/nano plus chat-latest variants

**Settings:** API key, custom URL, reasoning effort, verbosity, service tier (flex/default), prompt cache retention

**Key Details:**
- Developer role for GPT-5.x and o-series (except o1-preview/o1-mini) via `formatToOpenAI({developerRole: true})`
- `max_completion_tokens` for GPT-4.5+/5+/o-series
- GPT-5.4 with reasoning: strips temperature/top_p (BUG-Q10 fix)
- Dated GPT-5 models: keeps all sampling params (unlike LBI which force-strips)
- GPT-5.4+ via Copilot: auto-switches to Responses API
- Verbosity only for GPT-5 parameter models

---

### 3.3 gemini.js (~175 lines)

**Models:** Gemini 3 Pro/Flash Preview, 3.1 Pro Preview, 2.5 Pro/Flash

**Key Details:**
- Thinking: Level-based (Gemini 3) or budget-based (Gemini 2.5) via `buildGeminiThinkingConfig()`
- Historical thought parts stripped before sending (`thought: true` parts)
- Parameter validation via `validateGeminiParams()` + `cleanExperimentalModelParams()`
- Dynamic model fetch with pagination
- Safety settings: `BLOCK_NONE` for all categories (BUG-Q11 fix)
- `preserveSystem` default true (BUG-Q9 fix)

---

### 3.4 vertex.js (~320 lines)

**Models:** 13 models — Gemini 3/2.5 variants + Claude 4.5/4.6 on Vertex

**Key Details:**
- OAuth JWT flow: Service account JSON → RS256 JWT → `oauth2.googleapis.com/token` exchange
- Per-credential token caching in `_tokenCaches` Map
- Location-aware URL: `{region}-aiplatform.googleapis.com` (global vs regional)
- Dual format: `formatToGemini()` for Gemini models, `formatToAnthropic()` for Claude models
- Claude-on-Vertex: `rawPredict` endpoint, separate thinking settings
- Token cache invalidation on 401/403
- Region fallback suggestions on 404/400
- Key pairing: Service account JSONs + separate key pool

---

### 3.5 aws.js (~250 lines)

**Models:** AWS Bedrock Claude variants with global/us prefixes

**Key Details:**
- Access key ID + secret key pairing by index (modulo wrap on mismatch)
- Key rotation: Fisher-Yates shuffle, try each pair once (up to 10)
- **Non-streaming only** — binary event-stream is not parseable in V3 sandbox
- AWS SigV4 signing via `AwsV4Signer`
- Retry on 429/529/503 and network errors
- Thinking mode: `temperature=1.0` forced, `top_k`/`top_p` deleted (matches native Bedrock behavior)
- Dynamic model fetch: foundation models + inference profiles listing

---

### 3.6 deepseek.js (~130 lines)

**Models:** deepseek-chat, deepseek-reasoner

**Key Details:**
- Uses OpenAI-compatible format (`formatToOpenAI`, `parseOpenAINonStreamingResponse`)
- Reasoner model: strips all sampling params (temperature, top_p, frequency/presence penalty)
- Key rotation support
- Dynamic model fetch via OpenAI-compatible `/v1/models`

---

### 3.7 openrouter.js (~165 lines)

**Models:** Single dynamic placeholder (`openrouter/auto`)

**Key Details:**
- Actual model determined by `cpm_openrouter_model` setting
- Provider routing via `body.provider.order` array
- Reasoning effort support
- Custom URL support
- Dynamic model fetch via OpenRouter API with model filtering

---

## 4. Features

### 4.1 copilot.js (~340 lines)

**Purpose:** GitHub Copilot OAuth Device Flow token management UI.

**Functionality:**
- Token generation (OAuth device code flow)
- Token verification (subscription/feature check)
- Token removal
- Model listing (available Copilot models)
- Quota checking (with visual progress bars)
- Manual token save

**Key Details:**
- `copilotFetch()` with multi-strategy: `nativeFetch` → `risuFetch(plainFetchForce)` → proxy fallback
- `risuFetch` guard: `typeof Risu.risuFetch === 'function'` check (STRICT_AUDIT fix)
- UI integrated into CPM Manager settings under "🔑 Copilot Token" tab

---

### 4.2 navigation.js (~370 lines)

**Purpose:** Floating chat navigation widget with mode cycling.

**Modes:** 4-button → 2-button → keyboard-only → OFF (cycle via click)

**V3 Sandbox Workarounds:**
- `nth-child` + `querySelector` chains (no `querySelectorAll`)
- `getBoundingClientRect()` hit-testing (no `e.target`)
- `Risu.createMutationObserver()` for chat screen detection
- `getParent()` traversal instead of `closest()`

**Key Details:**
- Drag-and-drop with pointer events
- Position persistence across sessions
- Auto-detection of chat message containers
- Keyboard shortcuts: Arrow Up/Down/Home/End for navigation

---

### 4.3 resizer.js (~220 lines)

**Purpose:** Chat input textarea maximizer with 🧁 toggle button.

**Key Details:**
- Injects CSS for fullscreen textarea overlay
- V3 workarounds: `getParent()`, `pointerup` hit-test
- MutationObserver scans for new textareas
- Hot-reload cleanup support (removes previous instances)
- Toggles between normal and maximized textarea mode

---

### 4.4 transcache.js (~540 lines)

**Purpose:** Translation cache browser with user correction dictionary.

**Key Details:**
- `RisuScriptHandler` on `'display'` event for automatic text replacement from correction dictionary
- Pagination, sorting (default/recent), search
- CRUD for user corrections (original → corrected)
- Import/export as JSON
- Timestamp tracking for cache entries
- Uses `Risu.searchTranslationCache()` / `Risu.getTranslationCache()` APIs

---

## 5. Manager Hub

### src/manager/index.js (2696 lines)

**Version:** CPM 2.0.0

The largest file — central orchestrator for the entire system.

### State (L11-60)

- `registeredProviders` — `Map<string, {pluginName, models, settingsFields, supportsDynamicModels}>`
- `ALL_DEFINED_MODELS` — Array of all models (providers + custom)
- `CUSTOM_MODELS_CACHE` — Array of user-defined custom models
- `pendingRequests` / `pendingControlRequests` — Maps for IPC request tracking with timeouts
- `registeredModelKeys` — Set for dedup during model registration

### Copilot Token Management (L62-203)

- Duplicated inline Copilot OAuth helpers for the settings UI
- Device code flow: `_copilotRequestDeviceCode()` → `_copilotExchangeAccessToken()`
- Token verification: `_copilotCheckTokenStatus()`, `_copilotFetchModelList()`, `_copilotCheckQuota()`
- Auto token exchange: `_ensureCopilotApiToken()` delegates to `shared/copilot-token.js`
- Persistent Copilot session IDs (`_copilotMachineId`, `_copilotSessionId`)

### Settings Backup (L205-285)

- `SettingsBackup` from `shared/settings-backup.js`
- `snapshotAll()` captures all CPM settings to pluginStorage
- `restoreIfEmpty()` restores from backup on fresh load
- Runs at init and after settings UI save

### Slot Inference (L287-330)

- `inferSlot()` uses heuristic scoring from `shared/slot-inference.js`
- Slots: translation, emotion, memory, other
- Per-slot model override + parameter overrides
- Only applies overrides when `heuristicConfirmed === true` (C-5 safety)

### IPC Response/Fetch Listeners (L332-460)

**Response Listener:** `CH.RESPONSE` — matches incoming messages to `pendingRequests` by `requestId`. Handles:
- `MSG.RESPONSE` (success)
- `MSG.ERROR` (failure)
- `MSG.USAGE` (token usage data)

**Fetch Dispatcher:** `ipcFetchProvider()` — sends `MSG.FETCH_REQUEST` to a provider's plugin, with:
- `collectProviderSettings()` gathers all provider-specific settings via `safeGetArg()`
- 60-second timeout with auto-cleanup
- Abort propagation via `CH.ABORT` message when signal fires
- Pre-flight abort check before sending

### Request Handler (L462-600)

`handleRequest(args, activeModelDef, abortSignal)`:
1. Infers slot and applies slot-specific parameter overrides
2. Applies CPM fallback parameters (temp, max_tokens, top_p, freq/pres penalty)
3. Generates request ID for token usage tracking
4. Routes to `ipcFetchProvider()` for IPC providers or `handleCustomModel()` for custom
5. Post-flight abort check
6. Streaming decision: if streaming enabled AND bridge supports ReadableStream → pass through; else → collect to string
7. Token usage toast display (stream: via TransformStream flush; non-stream: immediate)

### Custom Model Handler (L580-1250)

`handleCustomModel()` — Full built-in provider for user-defined endpoints (no IPC needed).

**Supported Formats:** `openai`, `anthropic`, `google`

**URL Building:** `buildCustomEndpointUrl()` auto-completes partial URLs:
- OpenAI: Appends `/v1/chat/completions`
- Anthropic: Appends `/v1/messages`
- Google: Appends `/v1beta/models/{modelId}:generateContent`

**Copilot Integration:**
- Auto-detects `githubcopilot.com` URLs
- Auto-fetches Copilot API token
- Injects VS Code Copilot headers (editor version, machine ID, session ID, etc.)
- `Copilot-Vision-Request: true` for multimodal content

**Responses API (C-9):**
- Auto-detects `/responses` endpoint or Copilot + GPT-5.4+
- Converts `messages` → `input`, strips `name` field
- `reasoning_effort` → `reasoning: {effort, summary: 'auto'}`
- Manual override via `responsesMode: auto/on/off`

**Key Rotation:** Uses `KeyPool.withRotation()` for multi-key support.

**Streaming/Non-streaming:** Both paths supported with per-format SSE parsers.

### Control Channel (L1044-1087)

`setupControlChannel()` — Listens on `CH.CONTROL` for:
- `MSG.DYNAMIC_MODELS_RESULT` — Dynamic model fetch results from providers
- `MSG.REGISTER_PROVIDER` — Late provider registration (after managerReady)
  - Dedup check against existing models (BUG-5 fix)
  - Immediate `registerModelWithRisu()` for late arrivals
  - Sends `REGISTER_ACK` back to provider

### Model Registration (L1089-1180)

`registerModelWithRisu(modelDef)`:
- Per-provider LLM flags (BUG-Q6 fix):
  - Claude: `[0, 7, 8]` (hasImageInput, hasFirstSystemPrompt, hasStreaming)
  - Gemini: `[0, 7, 8, 9]` (+requiresAlternateRole)
  - OpenAI: `[0, 6, 8]` (hasFullSystemPrompt)
  - GPT-5: `[0, 6, 8, 14]` (+DeveloperRole)
- Per-provider tokenizer (BUG-Q7 fix): OpenAI→o200k_base, Claude→6, GoogleAI/VertexAI→10(GoogleCloud), DeepSeek→13
- Abort bridge probe on first request (ABORT_SIGNAL_REF system)
- Pre/post-flight abort checks with graceful empty return
- AbortError catch → `{success: true, content: ''}`

### Settings UI (L1194-2610)

**UI Framework:** Tailwind CSS (CDN), fullscreen container via `Risu.showContainer('fullscreen')`.

**Tabs:**
1. **🎛️ Global Defaults** — Fallback temperature, max tokens, top_p, freq/pres penalty, streaming settings
2. **🌐 Translation** — Translation slot model + parameter overrides
3. **😊 Emotion** — Emotion reading slot
4. **🧠 Memory** — Memory/summarization slot
5. **⚙️ Other** — Trigger/Lua slot
6. **☁️ [Provider] tabs** — Per-provider settings (API keys, URLs, model-specific options), dynamic model refresh button
7. **🔑 Copilot Token** — Full Copilot management UI (generate/verify/remove/models/quota)
8. **🔍 Diagnostics** — System overview, provider status, model list, recent API summary, bug report export (JSON/text/clipboard)
9. **📡 API Request Log** — Last 50 requests with request/response details, export, clear
10. **🛠️ Custom Models Manager** — CRUD, import/export, rich editor with all format options

**Input Security:** `escAttr()` function escapes `&`, `'`, `"`, `<`, `>` for HTML attribute injection prevention.

**Mobile Support:** Collapsible sidebar, auto-close on tab selection for small screens.

**Persistence:**
- Autosave: All inputs fire `setArg()` + `SettingsBackup.updateKey()` on `change` event
- Settings export/import as JSON
- Custom models persisted via `cpm_custom_models` argument (JSON array)

**Keyboard/Touch:** Ctrl+Shift+Alt+P opens settings; 4-finger touch gesture opens settings; registered at `getRootDocument()` level.

### Main Init (L2620-2696)

Initialization sequence:
1. Load settings backup from pluginStorage, restore if needed
2. Parse custom models from `cpm_custom_models` argument
3. Setup IPC listeners (control + response) — **before** any addProvider calls
4. Wait 1 second for sub-plugins to register via IPC
5. Sort all models (provider → name)
6. Register all models with RisuAI via `Risu.addProvider()`
7. Register settings UI via `Risu.registerSetting()`
8. Setup keyboard hotkey + touch gesture
9. Take initial settings backup snapshot

**Critical Fallback:** If init fails, registers an error-mode settings panel showing the stack trace plus recovery instructions. This ensures the user can always access diagnostics even when the plugin crashes.

---

## 6. IPC Protocol Patterns

### Channel Architecture

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `CH.CONTROL` | Bidirectional | Registration, ACK, dynamic model requests/results |
| `CH.FETCH` | Manager → Provider | API request dispatch |
| `CH.RESPONSE` | Provider → Manager | API response + token usage |
| `CH.ABORT` | Manager → Provider | Request cancellation |

### Registration Flow

```
Provider                          Manager
   │                                │
   │─── REGISTER_PROVIDER ────────>│  (on CH.CONTROL)
   │    {pluginName, name, models}  │
   │                                │── store in registeredProviders
   │<── REGISTER_ACK ─────────────│  (on CH.CONTROL)
   │    {success: true}             │
```

### Request/Response Flow

```
Manager                           Provider
   │                                │
   │── FETCH_REQUEST ─────────────>│  (on CH.FETCH)
   │   {requestId, model, msgs,    │
   │    temp, maxTokens, settings}  │
   │                                │── call API
   │<── RESPONSE ─────────────────│  (on CH.RESPONSE)
   │   {requestId, success, content}│
   │                                │
   │<── USAGE (optional) ─────────│  (on CH.RESPONSE)
   │   {requestId, type:USAGE,     │
   │    usage: {...}}               │
```

### Abort Flow

```
Manager                           Provider
   │                                │
   │── ABORT ─────────────────────>│  (on CH.ABORT)
   │   {requestId}                  │
   │                                │── cancel in-flight request
```

### Dynamic Model Flow

```
Manager                           Provider
   │                                │
   │── DYNAMIC_MODELS_REQUEST ────>│  (on CH.CONTROL via onControlMessage)
   │   {requestId, settings}        │
   │                                │── fetch /v1/models or equivalent
   │<── DYNAMIC_MODELS_RESULT ────│  (on CH.CONTROL)
   │   {requestId, models, success} │
```

### Critical Constraint

V3 allows **only one listener per channel per plugin**. The `onControlMessage` hook in `registerWithManager()` ensures the ACK handler and dynamic-model handler share a single `CH.CONTROL` listener (STRICT_AUDIT fix).

---

## 7. Error Handling Patterns

### Pattern 1: Graceful Degradation on Abort

Throughout the codebase, abort is treated as a non-error:
```js
if (abortSignal?.aborted) return { success: true, content: '' };
```
AbortError exceptions also return `{success: true, content: ''}` to prevent RisuAI from showing error dialogs.

### Pattern 2: Multi-Strategy Fetch Fallback

`smartFetch()` and `copilotFetch()` try multiple fetch strategies sequentially, only failing if all strategies fail. Each strategy wraps its call in try/catch independently.

### Pattern 3: IPC Timeout + Cleanup

All IPC calls (`ipcFetchProvider`, `requestDynamicModels`) use timeout + cleanup:
```js
const timer = setTimeout(() => {
    pendingRequests.delete(requestId);
    resolve({ success: false, content: '[CPM] Provider timeout' });
}, 60000);
```

### Pattern 4: JSON Parse Safety

All JSON parsing is wrapped in try/catch with fallback:
```js
try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }
```

### Pattern 5: Safe Argument Access

`safeGetArg()` wraps `Risu.getArgument()` with try/catch and default value return.

### Pattern 6: Critical Init Fallback

Manager init wraps the entire boot sequence in try/catch. On failure, registers an error-mode settings panel so users can still diagnose the issue.

### Pattern 7: Key Rotation Retry

`KeyPool.withRotation()` catches retryable errors (429/529/503) and rotates to the next key automatically, up to 30 retries.

---

## 8. Security Measures

### API Key Protection

1. **Redaction in logs:** API request log export masks `Authorization`, `x-api-key`, `token`, `secret`, `bearer` headers to `****` with only first/last 4 chars visible
2. **Custom model export:** `delete exp.key` — API keys are never included in model export files
3. **Password inputs:** Settings UI uses `type="password"` with show/hide toggle for API key fields

### HTML Injection Prevention

`escAttr()` escapes `& ' " < >` before inserting into innerHTML. The README acknowledges transitioning to `createElement` + `textContent` (no innerHTML) as a future hardening step.

### Body Sanitization

`sanitizeBodyForBridge()` deep-clones request bodies before postMessage to prevent prototype pollution or non-cloneable object errors. `sanitizeBodyJSON()` cleans serialized JSON.

### Internal Tag Stripping

`stripInternalTags()` removes RisuAI control sequences (`<qak>`, `<|risuai|>`) before sending to external APIs.

### Copilot Token Handling

`sanitizeCopilotToken()` validates token format. `_sanitizeCopilotHeaders()` filters non-ASCII characters from headers. Token stored via `Risu.setArgument()` (plugin-scoped storage).

### AWS Credentials

AWS SigV4 signing uses Web Crypto API exclusively. Credentials are never logged or exposed in headers beyond the signing process.

---

## 9. Stability Patterns

### Retry Logic

| Component | Strategy | Max Retries | Backoff |
|-----------|----------|-------------|---------|
| `registerWithManager()` | Exponential backoff | 12 | 500ms base, 5000ms max, ×2 per retry |
| `KeyPool.withRotation()` | Key rotation | 30 | Immediate (next key) |
| AWS provider | Credential pair rotation | 10 | Immediate (next pair) |
| IPC fetch | Timeout | 1 | 60s timeout |

### Validation

- `parseNumSafe()` used throughout handleRequest for parameter parsing with NaN protection
- `parseBool()` handles string/number/boolean inputs uniformly
- `validateGeminiParams()` clamps temperature [0,2], topP [0,1]
- `formatToAnthropic()` filters null/empty messages
- Custom model handler validates message structure post-formatting

### Fallback Chains

- **Parameters:** CPM slot override > RisuAI separate params > RisuAI main params > CPM global fallback > hardcoded default (0.7/4096)
- **Fetch:** Multiple strategies with automatic cascade
- **Stream:** If ReadableStream not transferable → auto-collect to string
- **Token cache:** Pre-expiry refresh (60s before expiry) with singleton pending promise

### Resource Cleanup

- Aborted request streams are explicitly `.cancel()`ed
- IPC pending maps are cleaned up on timeout, success, and error
- TransformStream `flush()` handles token usage display after stream completion
- `_copilotSessionId` and `_copilotMachineId` persist across requests (no regeneration)
- Hot-reload cleanup in resizer/navigation (removes previous DOM elements)

---

## 10. Gaps, TODOs, and Missing Features

### Architecture

| Gap | Severity | Notes |
|-----|----------|-------|
| `manager/index.js` is 2696 lines | Medium | README plans modular split: state, copilot-helpers, request-handler, settings-ui, model-registry, orchestrator |
| Tailwind via CDN | Low | Offline/CSP risk; planned local bundling |
| `innerHTML` usage in settings UI | Low | `escAttr()` mitigates; planned `createElement`/`textContent` transition |
| Copilot token logic duplicated in manager + feature | Low | Code duplication between `src/manager/index.js` and `src/features/copilot.js` |

### Testing Gaps (per STRICT_AUDIT_REPORT)

| Missing Test | Priority |
|--------------|----------|
| Manager-provider integration test (roundtrip) | P1 |
| Custom model fetch integration test | P1 |
| Copilot token test (exchange/cache/error/sanitize) | P1 |
| smartFetch test (fallback order, replay guard) | P1 |
| API request log test (eviction, clear, redaction) | P1 |
| Slot inference test | P2 |
| Settings backup test | P2 |
| UI regression test | P2 |

### Feature Gaps

| Feature | Status |
|---------|--------|
| AWS Bedrock streaming | Not possible (binary event-stream not parseable in V3 sandbox) |
| Chat resizer on/off toggle | Missing (temp_repo had it) |
| `db.systemContentReplacement` | Not reflected in CPM formatters |
| Per-model override via `db.seperateParametersByModel` | Not replicated in plugin (receives already-resolved params) |
| `removePluginChannelListener` | V3 API doesn't support it — mitigated with resolved flags |

### Known Remaining Structural Differences from Native RisuAI

| Aspect | Impact |
|--------|--------|
| V3 bridge structured-clone may lose prototype info | Low |
| Provider-specific flags can't 1:1 replicate all native flags | Low-Medium |
| `pluginStorage` is shared backing store (not plugin-isolated) | Low (prefix mitigation) |
| `getRootDocument()` requires `mainDom` permission | Graceful degrade if denied |

---

## 11. Documentation Summary

### README.md

Complete project documentation: architecture diagram, build/test/lint commands, project structure, build system explanation, new-provider guide, CI/CD workflow, tech stack, and future plans (manager split, innerHTML→DOM, Tailwind local).

### MIGRATION_REPORT_FROM_TEMP_REPO.md

Tracks migration from `_temp_repo` (earlier architecture) to v4. **All migratable items are complete.** Key additions across 3 sessions: provider compatibility, dynamic models IPC, 64 integration tests, diagnostics/bug-report UI, API log tab. Final state: 14 test files, 372 tests, all CI checks green. Items NOT migrated are structurally incompatible (sub-plugin manager, CSP exec, etc.).

### QUALITY_DIFF_REPORT.md

Detailed analysis of response quality differences vs native RisuAI. Documents and fixes 13 bugs (BUG-Q1 through Q13):
- **Q1-Q2 (CRITICAL):** Claude content structure and system message position
- **Q4 (HIGH):** OpenAI developer role missing
- **Q5 (HIGH):** Gemini system message wrapping
- **Q6 (HIGH):** Per-provider model flags mismatch
- **Q10 (HIGH):** GPT-5 dated model sampling params incorrectly stripped
- All 13 bugs fixed and verified.

### STRICT_AUDIT_REPORT_20260309.md

Rigorous re-audit covering 3 axes: feature comparison, test comparison, V3 API compatibility. Found and fixed:
1. **Critical:** `CH.CONTROL` multi-listener collision with V3 single-listener constraint
2. **Feature gap:** Custom Model Responses API Mode setting lost during migration
3. **Compatibility:** `risuFetch` guard added for undocumented API resilience

Test gap identified: shared module tests are well-covered; manager/Copilot/custom-fetch/UI tests are insufficient.

### RISUAI_API_REQUEST_ANALYSIS.md

Complete reverse-engineering of RisuAI native API request construction for OpenAI, Claude, and Gemini. Documents:
- Parameter storage (integer temperature ÷ 100), conversion pipeline, -1000 skip mechanism
- Per-provider body structure, headers, URL construction
- `reformater()` preprocessing flags and behavior
- Exact native vs plugin differences table
- This document was the basis for all BUG-Q fixes

---

## 12. Appendix: File-by-File Index

| File | Lines | Purpose |
|------|-------|---------|
| `src/shared/ipc-protocol.js` | ~130 | IPC constants, registration |
| `src/shared/helpers.js` | ~581 | Fetch utilities, arg accessors |
| `src/shared/message-format.js` | ~468 | Message format converters |
| `src/shared/sanitize.js` | ~190 | Message sanitization |
| `src/shared/sse-parser.js` | ~553 | SSE parsers (all providers) |
| `src/shared/token-usage.js` | ~155 | Token usage normalization |
| `src/shared/token-toast.js` | ~100 | Toast UI notification |
| `src/shared/key-pool.js` | ~107 | API key rotation pool |
| `src/shared/aws-signer.js` | ~200 | AWS V4 Signature |
| `src/shared/dynamic-models.js` | ~170 | Dynamic model formatters |
| `src/shared/model-helpers.js` | ~90 | Model capability detection |
| `src/shared/gemini-helpers.js` | ~100 | Gemini-specific helpers |
| `src/shared/copilot-token.js` | ~80 | Copilot token management |
| `src/shared/api-request-log.js` | ~80 | Circular buffer API log |
| `src/shared/settings-backup.js` | ~95 | Settings backup/restore |
| `src/shared/slot-inference.js` | ~105 | Heuristic slot inference |
| `src/shared/types.d.ts` | ~253 | TypeScript type definitions |
| `src/providers/anthropic.js` | ~190 | Claude provider |
| `src/providers/openai.js` | ~195 | OpenAI/GPT provider |
| `src/providers/gemini.js` | ~175 | Google Gemini provider |
| `src/providers/vertex.js` | ~320 | Vertex AI provider |
| `src/providers/aws.js` | ~250 | AWS Bedrock provider |
| `src/providers/deepseek.js` | ~130 | DeepSeek provider |
| `src/providers/openrouter.js` | ~165 | OpenRouter provider |
| `src/features/copilot.js` | ~340 | Copilot token UI |
| `src/features/navigation.js` | ~370 | Chat navigation widget |
| `src/features/resizer.js` | ~220 | Textarea maximizer |
| `src/features/transcache.js` | ~540 | Translation cache browser |
| `src/manager/index.js` | ~2696 | Central manager hub |

**Total source:** ~8,077 lines across 29 files.

---

*Report generated from complete reading of all 29 source files, README.md, and 4 documentation/audit reports.*
