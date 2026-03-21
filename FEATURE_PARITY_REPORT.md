# Feature Parity Comparison: _temp_repo vs cupcake-provider-v4_IPC

> Generated: 2025-07-19
> Based on: _temp_repo (CPM v1.22.10, monolithic) vs cupcake-provider-v4_IPC (CPM v2.0.0-alpha, IPC-based)

---

## 1. Tool-Use System (7 Core Files)

| Feature/Module | _temp_repo File | IPC File | Status | Notes |
|---|---|---|---|---|
| Tool Config Loader | `src/lib/tool-use/tool-config.js` | `src/shared/tool-config.js` | ✅ MIGRATED | isToolUseEnabled, isToolEnabled, getToolMaxDepth, getToolTimeout, getWebSearchConfig |
| Tool Definitions | `src/lib/tool-use/tool-definitions.js` | `src/shared/tool-definitions.js` | ✅ MIGRATED | TOOL_DATETIME, TOOL_CALCULATE, TOOL_DICE, TOOL_WEB_SEARCH, TOOL_FETCH_URL |
| Tool Executor | `src/lib/tool-use/tool-executor.js` | `src/shared/tool-executor.js` | ✅ MIGRATED | executeToolCall, webSearch, fetchUrl, calculate, rollDice, _parseSearchResults |
| Tool Parsers | `src/lib/tool-use/tool-parsers.js` | `src/shared/tool-parsers.js` | ✅ MIGRATED | parseOpenAIToolCalls, parseAnthropicToolCalls, parseGeminiToolCalls, formatToolResult |
| Tool Loop (Layer 2) | `src/lib/tool-use/tool-loop.js` | `src/shared/tool-loop.js` | ✅ MIGRATED | runToolLoop with timeout execution & retry logic |
| MCP Bridge (Layer 1) | `src/lib/tool-use/tool-mcp-bridge.js` | `src/shared/tool-mcp-bridge.js` | ✅ MIGRATED | registerCpmTools, refreshCpmTools for RisuAI MCP protocol |
| Prefetch Search | `src/lib/tool-use/prefetch-search.js` | `src/shared/prefetch-search.js` | ✅ MIGRATED | isPrefetchSearchEnabled, injectPrefetchSearch, formatSearchBlock |

---

## 2. Stream Handling & SSE Parsing

| Feature/Module | _temp_repo File(s) | IPC File | Status | Notes |
|---|---|---|---|---|
| SSE Stream Creation | `src/lib/stream-builders.js` | `src/shared/sse-parser.js` | 🔄 REORGANIZED | Core: createSSEStream, createOpenAISSEStream, createAnthropicSSEStream, createResponsesAPISSEStream |
| SSE Line Parsing | `src/lib/sse-parsers.js` | `src/shared/sse-parser.js` | 🔄 REORGANIZED | parseOpenAISSELine, parseGeminiSSELine, GEMINI_BLOCK_REASONS |
| Response Parsing (Non-Streaming) | `src/lib/response-parsers.js` | `src/shared/sse-parser.js` | 🔄 REORGANIZED | parseOpenAINonStreamingResponse, parseClaudeNonStreamingResponse, parseGeminiNonStreamingResponse |
| Stream Collection | `src/lib/stream-utils.js` | `src/shared/helpers.js` | ✅ MIGRATED | collectStream, checkStreamCapability, resetStreamCapability |
| Thought Signature Cache | `src/lib/format-gemini.js` | `src/shared/sse-parser.js` | ✅ MIGRATED | ThoughtSignatureCache object, saveThoughtSignatureFromStream |

---

## 3. Provider Implementations

| Provider | _temp_repo Approach | IPC File | Status | Key Exports |
|---|---|---|---|---|
| OpenAI (GPT) | `src/lib/fetch-custom.js` (monolithic) | `src/providers/openai.js` | 🔧 REFACTORED | Main fetch handler, Copilot ResponsesAPI fallback |
| Anthropic (Claude) | `src/lib/fetch-custom.js` (monolithic) | `src/providers/anthropic.js` | 🔧 REFACTORED | Claude-specific streaming & thinking parsing |
| Google Gemini | `src/lib/fetch-custom.js` (monolithic) | `src/providers/gemini.js` | 🔧 REFACTORED | Gemini safety settings, thinking config |
| Vertex AI | `src/lib/fetch-custom.js` + `vertex-auth.js` | `src/providers/vertex.js` | 🔧 REFACTORED | Google models + Claude models on Vertex |
| AWS Bedrock | `src/lib/fetch-custom.js` + `aws-signer.js` | `src/providers/aws.js` | 🔧 REFACTORED | Bedrock API signing, model normalization |
| DeepSeek | `src/lib/fetch-custom.js` | `src/providers/deepseek.js` | 🔧 REFACTORED | DeepSeek models, think/reason parsing |
| OpenRouter | `src/lib/fetch-custom.js` | `src/providers/openrouter.js` | 🔧 REFACTORED | Multi-provider aggregator |

---

## 4. Message Format Functions

| Format | _temp_repo File(s) | IPC File | Status | Functions |
|---|---|---|---|---|
| OpenAI Format | `src/lib/format-openai.js` | `src/shared/message-format.js` | 📦 CONSOLIDATED | formatToOpenAI |
| Anthropic Format | `src/lib/format-anthropic.js` | `src/shared/message-format.js` | 📦 CONSOLIDATED | formatToAnthropic |
| Gemini Format | `src/lib/format-gemini.js` | `src/shared/message-format.js` | 📦 CONSOLIDATED | formatToGemini (partial; safety in gemini-helpers.js) |
| Gemini Safety Config | `src/lib/format-gemini.js` | `src/shared/gemini-helpers.js` | 📦 CONSOLIDATED | getGeminiSafetySettings, validateGeminiParams, buildGeminiThinkingConfig |

---

## 5. Authentication & Token Management

| Feature | _temp_repo File(s) | IPC File | Status | Key Functions |
|---|---|---|---|---|
| Copilot Token Management | `src/lib/copilot-token.js` | `src/shared/copilot-token.js` | ✅ MIGRATED | ensureCopilotApiToken, clearCopilotTokenCache, sanitizeCopilotToken |
| Copilot Headers | `src/lib/copilot-headers.js` | `src/shared/copilot-headers.js` | ✅ MIGRATED | buildCopilotTokenExchangeHeaders, getCopilotStaticHeaders |
| Vertex Service Account Auth | `src/lib/vertex-auth.js` | **N/A** | ⚠️ MISSING | parseServiceAccountJson, getVertexBearerToken, clearAllTokenCaches |
| AWS Signing | `src/lib/aws-signer.js` | `src/shared/aws-signer.js` | ✅ MIGRATED | AwsV4Signer class |
| IPC Protocol (NEW) | **N/A** | `src/shared/ipc-protocol.js` | 🆕 NEW | registerWithManager, setupChannelCleanup, getRisu, safeUUID |

---

## 6. Key Pool & Token Tracking

| Feature | _temp_repo File(s) | IPC File | Status | Key Functions |
|---|---|---|---|---|
| Key Pool Management | `src/lib/key-pool.js` | `src/shared/key-pool.js` | ✅ MIGRATED | KeyPool object (add, remove, rotate, get, clear) |
| Token Usage Tracking | `src/lib/token-usage.js` | `src/shared/token-usage.js` | ✅ MIGRATED | _tokenUsageStore, _setTokenUsage, _takeTokenUsage |
| Token Usage Toast | `src/lib/token-toast.js` | `src/shared/token-toast.js` | ✅ MIGRATED | showTokenUsageToast |
| API Request Logging | `src/lib/api-request-log.js` | `src/shared/api-request-log.js` | ✅ MIGRATED | storeApiRequest, getAllApiRequests |

---

## 7. Settings & UI

| Feature | _temp_repo File(s) | IPC File | Status |
|---|---|---|---|
| Settings Backup/Restore | `src/lib/settings-backup.js` | `src/shared/settings-backup.js` | ✅ MIGRATED |
| Custom Model Serialization | `src/lib/custom-model-serialization.js` | `src/shared/custom-model-serialization.js` | ✅ MIGRATED |
| Dynamic Models | **N/A** | `src/shared/dynamic-models.js` | 🆕 NEW (IPC) |
| Sub-Plugin Toggle UI | Inline in router.js | `src/shared/sub-plugin-toggle-ui.js` | 🔧 EXTRACTED |

---

## 8. Auto-Update & Version Management

| Feature | _temp_repo File(s) | IPC File | Status |
|---|---|---|---|
| Auto-Updater | `src/lib/auto-updater.js` | `src/shared/auto-updater.js` | ✅ MIGRATED |
| Update Toast | `src/lib/update-toast.js` | `src/shared/update-toast.js` | ✅ MIGRATED |
| Endpoints | `src/lib/endpoints.js` | `src/shared/endpoints.js` | ✅ MIGRATED |

---

## 9. Utilities & Helpers

| Utility | _temp_repo File(s) | IPC File | Status |
|---|---|---|---|
| Common Helpers | `src/lib/helpers.js` | `src/shared/helpers.js` | ✅ MIGRATED |
| Sanitization | `src/lib/sanitize.js` | `src/shared/sanitize.js` | ✅ MIGRATED |
| Schema Validation | `src/lib/schema.js` | `src/shared/schema.js` | ✅ MIGRATED |
| Model Helpers | `src/lib/model-helpers.js` | `src/shared/model-helpers.js` | ✅ MIGRATED |
| Slot Inference | `src/lib/slot-inference.js` | `src/shared/slot-inference.js` | ✅ MIGRATED |
| Tailwind CSS | `src/lib/tailwind-css.generated.js` | `src/shared/tailwind-css.generated.js` | ✅ MIGRATED |

---

## 10. Architecture Summary

| Component | _temp_repo | IPC | Status |
|---|---|---|---|
| Main Entry | `src/index.js` | `src/manager/index.js` | 🔧 REFACTORED |
| Provider Routing | `src/lib/router.js` (monolithic) | Individual provider modules + IPC | 📦 MODULARIZED |
| IPC Protocol | N/A | `src/shared/ipc-protocol.js` | 🆕 NEW |

---

## Migration Status Summary

| Status | Count | Categories |
|---|---|---|
| ✅ FULLY MIGRATED | 25+ | Tool-use (7), Token mgmt (4), Key pool, Helpers, Sanitize, Schema, Slot inference, etc. |
| 🔄 REORGANIZED | 8+ | SSE/Stream handling, Message format, Gemini helpers |
| 🔧 REFACTORED | 6+ | Provider implementations, Init system, Router → IPC manager |
| 📦 EXTRACTED | 4+ | Features (copilot, navigation, resizer, transcache) |
| 🆕 NEW (IPC) | 8+ | ipc-protocol, Dynamic models, Companion installer, Safe DB writer, Types |
| ⚠️ NOT YET MIGRATED | 1 | Vertex service account parser (vertex-auth.js) |
| ➖ NOT NEEDED | 1 | CSP-safe execution (IPC provides isolation) |
