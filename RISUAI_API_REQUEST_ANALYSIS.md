# RisuAI Native API Request Construction — Complete Analysis

**Date**: March 5, 2026  
**Source**: `Risuai-main/src/ts/process/request/` and related files  
**Purpose**: Document exactly how RisuAI builds and sends API requests to OpenAI, Anthropic/Claude, and Google Gemini, to identify why native requests may produce different quality than plugin-based approaches.

---

## Table of Contents

1. [Executive Summary — Why Native Requests Differ](#1-executive-summary)
2. [Temperature & top_p: The Critical Difference](#2-temperature--top_p-the-critical-difference)
3. [OpenAI Request Construction](#3-openai-request-construction)
4. [Anthropic/Claude Request Construction](#4-anthropicclaude-request-construction)
5. [Google Gemini Request Construction](#5-google-gemini-request-construction)
6. [Message Preprocessing Pipeline](#6-message-preprocessing-pipeline)
7. [Prompt Engineering/Wrapping](#7-prompt-engineeringwrapping)
8. [Key Differences From Plugin Approach](#8-key-differences-from-plugin-approach)

---

## 1. Executive Summary

**The #1 reason native RisuAI requests may produce different output than plugins:**

RisuAI stores `temperature` as an **integer from 0–200** (where 80 = 0.8) and divides by 100 before sending. The `top_p` is stored as a **raw float** (0–1). If a plugin reads `db.temperature` directly and sends `170` instead of `1.7`, or applies any rounding/clamping, it will produce wildly different results.

Additionally, RisuAI:
- Uses **model-specific parameter sets** (each model declares which parameters it accepts)
- Applies **`applyParameters()`** to conditionally include/exclude fields based on model capabilities  
- Has a **`reformater()`** preprocessing step that restructures messages based on model flags
- Passes parameters through a **centralized `shared.ts:applyParameters()`** function that handles division/conversion
- For Claude: extracts system prompt separately, uses structured `content` blocks, adds `cache_control`
- For Gemini: renames parameters (`top_p` → `topP`, `top_k` → `topK`), nests under `generation_config`
- For OpenAI: passes `temperature`/`top_p` at body root level directly

---

## 2. Temperature & top_p: The Critical Difference

### Storage Format (database.svelte.ts)

```typescript
// Temperature: stored as INTEGER 0-200 (default 80 = 0.80)
data.temperature = 80  // default

// top_p: stored as RAW FLOAT 0-1 (default 1.0)
data.top_p ??= 1
if(typeof(data.top_p) !== 'number'){
    data.top_p = 1
}

// top_k: stored as raw integer (default 0)
data.top_k ??= 0

// frequency_penalty: stored as INTEGER 0-200 (default 70 = 0.70)
data.frequencyPenalty = 70  // default

// presence_penalty: stored as INTEGER 0-200 (default 70 = 0.70)
data.PresensePenalty = 70   // default
```

### Conversion in `applyParameters()` (shared.ts)

The `applyParameters()` function is the **single centralized point** where all parameters are converted for all providers:

```typescript
// shared.ts — applyParameters()

case 'temperature': {
    value = db.temperature === -1000 ? -1000 : db.temperature / 100
    // -1000 means "don't send this parameter"
    // e.g., db.temperature=170 → value=1.7
    break
}

case 'top_p': {
    value = db.top_p
    // NO DIVISION — sent as-is (already 0-1 float)
    // e.g., db.top_p=0.65 → value=0.65
    break
}

case 'top_k': {
    value = db.top_k
    // NO DIVISION — sent as raw integer
    break
}

case 'frequency_penalty': {
    value = db.frequencyPenalty === -1000 ? -1000 : db.frequencyPenalty / 100
    // e.g., db.frequencyPenalty=70 → value=0.7
    break
}

case 'presence_penalty': {
    value = db.PresensePenalty === -1000 ? -1000 : db.PresensePenalty / 100
    // e.g., db.PresensePenalty=70 → value=0.7
    break
}

case 'thinking_tokens': {
    value = db.thinkingTokens
    // Raw integer, no conversion
    break
}

case 'reasoning_effort': {
    // Converts numeric level to string
    // -1 → 'minimal', 0 → 'low', 1 → 'medium', 2 → 'high'
    value = getEffort(db.reasoningEffort)
    break
}

case 'verbosity': {
    // 0 → 'low', 1 → 'medium', 2 → 'high'
    value = getVerbosity(db.verbosity)
    break
}
```

### Critical: The -1000 Skip Mechanism

If ANY parameter is set to `-1000`, it is **completely omitted** from the request body:

```typescript
if (value === -1000) {
    continue  // skip this parameter entirely
}
```

### Separate Parameters Mode

RisuAI supports **separate parameters per model mode** (model, submodel, memory, emotion, etc.) and even **per-model overrides**:

```typescript
if (db.seperateParametersEnabled && (modelMode !== 'model' || db.seperateParametersByModel)) {
    let sepParams = db.seperateParameters[modelMode]
    if (db.seperateParametersByModel){
        sepParams = db.seperateParameters.overrides[arg.modelId]
    }
    // Uses sepParams.temperature / 100, sepParams.top_p as-is, etc.
}
```

### No Clamping, No Rounding, No Type Conversion

**RisuAI does NOT:**
- Clamp temperature to [0, 2] or any range
- Round values to N decimal places
- Convert to string and back
- Apply any min/max bounds
- Convert `top_p` from percentage to decimal (it's already decimal)

The value from `db.temperature / 100` is passed directly as a JavaScript `number` into the request body object, which gets `JSON.stringify()`ed by `globalFetch`.

---

## 3. OpenAI Request Construction

### File: `src/ts/process/request/openAI/requests.ts`

### Parameters Declared for OpenAI Models

```typescript
// types.ts
export const OpenAIParameters: LLMParameter[] = [
    'temperature', 'top_p', 'frequency_penalty', 'presence_penalty'
]

// GPT-5 series adds:
export const GPT5Parameters: LLMParameter[] = [
    'temperature', 'top_p', 'frequency_penalty', 'presence_penalty',
    'reasoning_effort', 'verbosity'
]
```

### Complete Request Body Construction

```typescript
let body = {
    // Model name resolution (long switch-case mapping internal IDs to API model strings)
    model: aiModel === 'openrouter' ? openrouterRequestModel :
        requestModel === 'gpt35' ? 'gpt-3.5-turbo'
        : requestModel === 'gpt4' ? 'gpt-4'
        : requestModel === 'gpt4o' ? 'gpt-4o'
        : requestModel === 'gpt4om' ? 'gpt-4o-mini'
        // ... many more mappings ...
        : arg.modelInfo.internalID ? arg.modelInfo.internalID
        : (!requestModel) ? 'gpt-3.5-turbo'
        : requestModel,
    
    messages: formatedChat,       // OpenAIChatExtra[] — already processed
    max_tokens: arg.maxTokens,    // from db.maxResponse (default 500)
    logit_bias: arg.bias,         // token bias map {tokenId: bias}
    stream: false,                // default false, set true if streaming enabled
}

// Remove empty logit_bias
if(Object.keys(body.logit_bias).length === 0){
    delete body.logit_bias
}

// OAI Completion Tokens flag (newer models use max_completion_tokens)
if(arg.modelInfo.flags.includes(LLMFlags.OAICompletionTokens)){
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
}

// Seed
if(db.generationSeed > 0){
    body.seed = db.generationSeed
}

// JSON Schema
if(db.jsonSchemaEnabled || arg.schema){
    body.response_format = {
        "type": "json_schema",
        "json_schema": getOpenAIJSONSchema(arg.schema)
    }
}

// Prediction
if(db.OAIPrediction){
    body.prediction = {
        type: "content",
        content: db.OAIPrediction
    }
}

// ===== PARAMETERS APPLIED HERE =====
body = applyParameters(
    body,
    arg.modelInfo.parameters,  // e.g., ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']
    {},                        // no renames for OpenAI (keys match API names)
    arg.mode,
    {
        modelId: arg.modelInfo.id
    }
)
// After this call, body now contains:
//   body.temperature = db.temperature / 100  (e.g., 1.7)
//   body.top_p = db.top_p                    (e.g., 0.65)
//   body.frequency_penalty = db.frequencyPenalty / 100 (e.g., 0.7)
//   body.presence_penalty = db.PresensePenalty / 100   (e.g., 0.7)

// Tools (MCP)
if(arg.tools && arg.tools.length > 0){
    body.tools = arg.tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: simplifySchema(tool.inputSchema),
        }
    }))
}

// Ooba mode extras
if(aiModel === 'reverse_proxy' && db.reverseProxyOobaMode){
    // Merges additional parameters from OobaBodyTemplate
}

// Multi-gen
if(arg.multiGen){
    body.n = db.genTime
}

// Streaming
if(arg.useStreaming){
    body.stream = true
}
```

### DeveloperRole Flag (GPT-5+ models)

```typescript
if(arg.modelInfo.flags.includes(LLMFlags.DeveloperRole)){
    formatedChat = formatedChat.map((v) => {
        if(v.role === 'system'){
            v.role = 'developer'  // system → developer for newer OpenAI models
        }
        return v
    })
}
```

### Headers

```typescript
let headers = {
    "Authorization": "Bearer " + (arg.key ?? db.openAIKey),
    "Content-Type": "application/json"
}

// OpenRouter adds:
if(aiModel === 'openrouter'){
    headers["X-Title"] = 'RisuAI'
    headers["HTTP-Referer"] = 'https://risuai.xyz'
}
```

### URL Construction

```typescript
let replacerURL = 'https://api.openai.com/v1/chat/completions'
// OpenRouter: "https://openrouter.ai/api/v1/chat/completions"
// Model endpoint override: arg.modelInfo.endpoint
// Reverse proxy: auto-fills /v1/chat/completions if needed
```

### Additional Parameters (Reverse Proxy / Custom Models)

For reverse proxy and custom models, RisuAI supports `additionalParams` — key-value pairs that get merged into body or headers:
```typescript
// Supports: string, number, boolean, json::, header::, null, {{none}} (delete)
for(const [key, value] of additionalParams){
    if(key.startsWith('header::')) headers[key] = value
    else if(value.startsWith('json::')) body[key] = JSON.parse(value)
    else body[key] = value  // with type coercion
}
```

### OpenAI Response API (newer format)

For `LLMFormat.OpenAIResponseAPI`:
```typescript
const body = applyParameters({
    model: arg.modelInfo.internalID ?? aiModel,
    input: items,                  // ResponseItem[] instead of messages
    max_output_tokens: maxTokens,
    tools: [],
    store: false
}, ['temperature', 'top_p'], {}, arg.mode, {
    modelId: arg.modelInfo.id
})
// URL: https://api.openai.com/v1/responses
```

---

## 4. Anthropic/Claude Request Construction

### File: `src/ts/process/request/anthropic.ts`

### Parameters Declared for Claude Models

```typescript
export const ClaudeParameters: LLMParameter[] = ['temperature', 'top_k', 'top_p']

// Models with thinking:
parameters: [...ClaudeParameters, 'thinking_tokens']
// = ['temperature', 'top_k', 'top_p', 'thinking_tokens']
```

**Note: Claude does NOT use `frequency_penalty` or `presence_penalty`** — these are not in `ClaudeParameters`.

### Message Formatting

Claude requires a **specific message format**:
1. First system message(s) → extracted to a separate `system` string parameter
2. All subsequent messages → `user`/`assistant` alternation required
3. System messages after first → converted to `user` role with "System: " prefix
4. Messages with same consecutive role → merged with `\n\n` separator
5. Must start with `user` message (inserts `{role:'user', content:'Start'}` if needed)

```typescript
// System prompt extraction:
for(const chat of formated){
    switch(chat.role){
        case 'system':
            if(claudeChat.length === 0){
                systemPrompt += '\n\n' + chat.content  // First system → separate param
            } else {
                addClaudeChat({
                    role: 'user',
                    content: "System: " + chat.content  // Later system → user msg
                })
            }
            break
        case 'user':
            addClaudeChat({ role: 'user', content: chat.content })
            break
        case 'assistant':
            addClaudeChat({ role: 'assistant', content: chat.content })
            break
    }
}
```

### Content Block Structure

Each Claude message uses structured content blocks:
```typescript
interface Claude3Chat {
    role: 'user' | 'assistant'
    content: Claude3ContentBlock[]  // Array of text/image/tool blocks
}

// Text block:
{ type: 'text', text: '...', cache_control?: { type: 'ephemeral', ttl?: '5m'|'1h' } }

// Image block:
{ type: 'image', source: { type: 'base64', media_type: '...', data: '...' } }
```

### Cache Control

RisuAI adds `cache_control` to content blocks when `cachePoint` is set:
```typescript
if(chat.cache){
    if(db.claude1HourCaching){
        content[content.length-1].cache_control = { type: 'ephemeral', ttl: "1h" }
    } else {
        content[content.length-1].cache_control = { type: 'ephemeral' }
    }
}
```

### Complete Request Body Construction

```typescript
let body = applyParameters({
    model: arg.modelInfo.internalID,   // e.g., 'claude-sonnet-4-6'
    messages: finalChat,                // Claude3ExtendedChat[]
    system: systemPrompt.trim(),        // Separate system prompt string
    max_tokens: maxTokens,              // from db.maxResponse
    stream: useStreaming ?? false,       // boolean
}, arg.modelInfo.parameters, {
    'thinking_tokens': 'thinking.budget_tokens'  // RENAME: thinking_tokens → thinking.budget_tokens
}, arg.mode, {
    modelId: arg.modelInfo.id
})
// After applyParameters:
//   body.temperature = db.temperature / 100  (e.g., 1.7)
//   body.top_p = db.top_p                    (e.g., 0.65)
//   body.top_k = db.top_k                    (e.g., 0 — will be included)
//   body.thinking.budget_tokens = db.thinkingTokens  (if thinking_tokens in model params)
```

### Thinking Mode Handling

```typescript
// After applyParameters, handle thinking configuration:
if(db.thinkingType === 'off'){
    delete body.thinking
}
else if(db.thinkingType === 'adaptive' && arg.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking)){
    delete body.thinking
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort: db.adaptiveThinkingEffort ?? 'high' }
}
else if(body?.thinking?.budget_tokens === 0){
    delete body.thinking
}
else if(body?.thinking?.budget_tokens > 0){
    body.thinking.type = 'enabled'
    // Final: { thinking: { type: 'enabled', budget_tokens: N } }
}
else if(body?.thinking?.budget_tokens === null){
    delete body.thinking
}

// Empty system → delete
if(systemPrompt === ''){
    delete body.system
}
```

### Headers

```typescript
let headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "accept": "application/json",
}

// Beta headers:
let betas = []
if(body.max_tokens > 8192){
    betas.push('output-128k-2025-02-19')
}
if(db.claude1HourCaching){
    betas.push('extended-cache-ttl-2025-04-11')
}
if(betas.length > 0){
    headers['anthropic-beta'] = betas.join(',')
}

// Direct browser access:
if(db.usePlainFetch){
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
}
```

### URL

```typescript
let replacerURL = arg.customURL ?? 'https://api.anthropic.com/v1/messages'
// Auto-fills /v1/messages for reverse proxy if needed
```

### AWS Bedrock Variant

For `LLMFormat.AWSBedrockClaude`:
```typescript
let params = {...body}
params.anthropic_version = "bedrock-2023-05-31"
delete params.model
delete params.stream

// CRITICAL: When thinking is enabled, force temperature=1.0 and remove top_k/top_p
if (params.thinking?.type === "enabled" || params.thinking?.type === "adaptive"){
    params.temperature = 1.0
    delete params.top_k
    delete params.top_p
}

// URL: https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke
// Uses AWS SigV4 signing
```

### Reverse Proxy Simplification

When using reverse proxy, Claude messages are simplified from structured blocks to plain strings:
```typescript
if(aiModel === 'reverse_proxy'){
    finalChat = claudeChat.map((v) => {
        if(v.content.length > 0 && v.content[0].type === 'text'){
            return {
                role: v.role,
                content: v.content[0].text  // Simplified to string
            }
        }
    })
}
```

---

## 5. Google Gemini Request Construction

### File: `src/ts/process/request/google.ts`

### Parameters Declared for Gemini Models

```typescript
// Gemini 2.5+ with thinking:
parameters: ['thinking_tokens', 'temperature', 'top_k', 'top_p', 'presence_penalty', 'frequency_penalty']

// Gemini 2.0 and below:
parameters: ['temperature', 'top_k', 'top_p', 'presence_penalty', 'frequency_penalty']
```

### Message Formatting

Gemini uses a different message structure:
```typescript
interface GeminiChat {
    role: "user" | "model" | "function"
    parts: GeminiPart[]
}

interface GeminiPart {
    text?: string
    thought?: boolean
    thoughtSignature?: string
    inlineData?: { mimeType: string, data: string }
    functionCall?: GeminiFunctionCall
    functionResponse?: GeminiFunctionResponse
}
```

Role mapping:
- `system` (first message) → extracted to `systemInstruction`
- `system` (later) → merged into nearest `user` message as `"system:" + content`
- `user` → `user`
- `assistant` → `model`
- Other roles → `user` with `role + ':' + content`

```typescript
if(formated[0].role === 'system'){
    systemPrompt = formated[0].content
    formated.shift()
}

for(const chat of formated){
    if(chat.role === 'system'){
        if(prevChat?.role === 'user'){
            // Append to previous user message
            reformatedChat[last].parts[0].text += '\nsystem:' + chat.content
        } else {
            reformatedChat.push({
                role: "user",
                parts: [{ text: chat.role + ':' + chat.content }]
            })
        }
    }
    else if(chat.role === 'assistant' || chat.role === 'user'){
        reformatedChat.push({
            role: chat.role === 'user' ? 'user' : 'model',
            parts: [{ text: chat.content }]
        })
    }
}
```

After processing, consecutive same-role messages are **merged**:
```typescript
// Merge consecutive same-role chats
for (let i = reformatedChat.length - 1; i >= 1; i--) {
    if (currentChat.role === prevChat.role) {
        prevLastPart.text += '\n\n' + currentFirstPart.text
        reformatedChat.splice(i, 1)
    }
}
```

### Complete Request Body Construction

```typescript
const body = {
    contents: reformatedChat,        // GeminiChat[]
    generation_config: applyParameters({
        "maxOutputTokens": maxTokens
    }, para, {
        'top_p': "topP",                    // RENAME: top_p → topP
        'top_k': "topK",                    // RENAME: top_k → topK
        'presence_penalty': "presencePenalty",   // RENAME
        'frequency_penalty': "frequencyPenalty", // RENAME
        'thinking_tokens': "thinkingBudget"      // RENAME
    }, arg.mode, {
        ignoreTopKIfZero: true,              // Skip top_k if value is 0
        modelId: arg.modelInfo.id
    }),
    safetySettings: [
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT",         threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY",    threshold: "BLOCK_NONE" }
    ],
    systemInstruction: {
        parts: [{ "text": systemPrompt }]
    },
    tools: {
        functionDeclarations: arg?.tools?.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: simplifySchema(tool.inputSchema)
        })) ?? []
    }
}
```

After `applyParameters`, the `generation_config` will contain:
```json
{
    "maxOutputTokens": 500,
    "temperature": 1.7,
    "topP": 0.65,
    "topK": 0,          // (skipped if 0 due to ignoreTopKIfZero)
    "presencePenalty": 0.7,
    "frequencyPenalty": 0.7,
    "thinkingBudget": 10000  // (if thinking model)
}
```

### Safety Settings

For models with `LLMFlags.geminiBlockOff`:
```typescript
// threshold changes from "BLOCK_NONE" to "OFF"
for(let i=0; i<uncensoredCatagory.length; i++){
    uncensoredCatagory[i].threshold = "OFF"
}
```

For models with `LLMFlags.noCivilIntegrity`:
```typescript
// HARM_CATEGORY_CIVIC_INTEGRITY is removed entirely
uncensoredCatagory.splice(4, 1)
```

### Thinking Configuration

```typescript
if(arg.modelInfo.flags.includes(LLMFlags.geminiThinking)){
    const internalId = arg.modelInfo.internalID
    const thinkingBudget = body.generation_config.thinkingBudget

    // Gemini 3 models use thinkingLevel instead of thinkingBudget
    if (internalId && /^gemini-3-/.test(internalId)) {
        const budgetNum = Number(thinkingBudget)
        let thinkingLevel = 'HIGH'
        
        if (internalId === 'gemini-3-flash-preview') {
            if (budgetNum >= 16384) thinkingLevel = 'HIGH'
            else if (budgetNum >= 4096) thinkingLevel = 'MEDIUM'
            else thinkingLevel = 'LOW'
        } else {
            if (budgetNum >= 8192) thinkingLevel = 'HIGH'
            else thinkingLevel = 'LOW'
        }

        body.generation_config.thinkingConfig = {
            "thinkingLevel": thinkingLevel,
            "includeThoughts": true,
        }
    } else {
        // Gemini 2.5 and below use numeric budget
        body.generation_config.thinkingConfig = {
            "thinkingBudget": thinkingBudget,
            "includeThoughts": true,
        }
    }
    delete body.generation_config.thinkingBudget
}
```

### Media Resolution

```typescript
if(db.gptVisionQuality === 'high'){
    body.generation_config.mediaResolution = "MEDIA_RESOLUTION_MEDIUM"
}
```

### Audio/Image Output

```typescript
if(arg.modelInfo.flags.includes(LLMFlags.hasAudioOutput)){
    body.generation_config.responseModalities = ['TEXT', 'AUDIO']
    arg.useStreaming = false
}
if(arg.imageResponse || arg.modelInfo.flags.includes(LLMFlags.hasImageOutput)){ 
    body.generation_config.responseModalities = ['TEXT', 'IMAGE']
    arg.useStreaming = false
}
```

### Headers

```typescript
let headers = {
    'Content-Type': 'application/json'
}

// Vertex AI adds Authorization:
if(arg.modelInfo.format === LLMFormat.VertexAIGemini){
    headers['Authorization'] = "Bearer " + vertexAccessToken
}
```

### URL Construction

```typescript
// Google Cloud (API key auth):
url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`

// Streaming:
url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`

// Vertex AI:
url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${modelId}:generateContent`
```

### JSON Schema Support

```typescript
if(db.jsonSchemaEnabled || arg.schema){
    body.generation_config.response_mime_type = "application/json"
    body.generation_config.response_schema = getGeneralJSONSchema(arg.schema, ['$schema','additionalProperties'])
}
```

---

## 6. Message Preprocessing Pipeline

### Full Request Flow: User Click → fetch()

1. **`index.svelte.ts`**: Builds the message array from prompt template
   - Main prompt, jailbreak prompt, global note, character description, lorebook, persona, chat history
   - All prompts go through `risuChatParser()` for variable substitution
   
2. **`requestChatData()`** in `request.ts`:
   - Applies plugin `replacerbeforeRequest` hooks
   - Runs triggers on the formatted message array
   - Calls `requestChatDataMain()`

3. **`requestChatDataMain()`** in `request.ts`:
   - Sets `targ.temperature = db.temperature / 100` (done here for legacy instruct)
   - Calls **`reformater()`** based on model flags
   - Routes to provider-specific function based on `LLMFormat`

4. **`reformater()`** in `request.ts`:
   - `hasFullSystemPrompt`: keeps all system messages as-is
   - `hasFirstSystemPrompt`: extracts first system messages, converts rest to user/assistant
   - System message conversion: `"system: ${content}"` or custom replacement via `db.systemContentReplacement`
   - `requiresAlternateRole`: merges consecutive same-role messages
   - `mustStartWithUserInput`: prepends empty user message if needed

5. **Provider-specific function** (openAI/anthropic/google):
   - Further reformats messages for provider's specific format
   - Calls `applyParameters()` on the body
   - Sends the request

### The `reformater()` Function

```typescript
export function reformater(formated:OpenAIChat[], modelInfo:LLMModel):OpenAIChat[] {
    const flags = modelInfo.flags
    
    // 1. System prompt handling
    if(!flags.includes(LLMFlags.hasFullSystemPrompt)){
        if(flags.includes(LLMFlags.hasFirstSystemPrompt)){
            // Extract contiguous leading system messages into one
            while(formated[0].role === 'system'){
                systemPrompt.content += '\n\n' + formated[0].content
                formated = formated.slice(1)
            }
        }
        // Convert remaining system messages
        for(const m of formated){
            if(m.role === 'system'){
                m.content = db.systemContentReplacement 
                    ? db.systemContentReplacement.replace('{{slot}}', m.content) 
                    : `system: ${m.content}`
                m.role = db.systemRoleReplacement  // default: 'user'
            }
        }
    }
    
    // 2. Alternate role enforcement
    if(flags.includes(LLMFlags.requiresAlternateRole)){
        // Merge consecutive same-role messages
        // Also merges multimodals and thoughts arrays
    }
    
    // 3. Must start with user
    if(flags.includes(LLMFlags.mustStartWithUserInput)){
        if(formated[0].role !== 'user'){
            formated.unshift({ role: 'user', content: ' ' })
        }
    }
    
    return formated
}
```

---

## 7. Prompt Engineering/Wrapping

### RisuAI Does NOT Add Hidden Prompts

RisuAI does **not** inject any hidden system instructions, jailbreak prompts, or formatting instructions into the API request beyond what the user has configured. The prompt template is fully user-configurable.

### What Gets Sent

The message array is built from the user's **prompt template** (configurable in settings), which typically includes:
- **Main Prompt** (`db.mainPrompt`) — user-written system instruction
- **Global Note** (`db.globalNote`) — additional notes
- **Jailbreak** (`db.jailbreak`) — only if `db.jailbreakToggle` is true
- **Character Description** — from the character card
- **Persona** — user's persona
- **Lorebook** — matched lore entries
- **Chat History** — the actual conversation
- **Author's Note** — mid-conversation notes
- **Assistant Prefill** (`db.promptSettings.assistantPrefill`) — optional text prepended to assistant response

### Chain of Thought

If `db.chainOfThought` or `db.promptSettings.customChainOfThought` is enabled, RisuAI adds CoT instructions, but this is a user-visible setting.

### newOAIHandle Mode

When `db.newOAIHandle` is true:
- Messages with empty content are filtered out
- Messages with `memo` starting with 'NewChat' get their content cleared
- Example messages retain their `name` field (e.g., `example_user`, `example_assistant`)

### DeepSeek-Specific Handling

```typescript
// Prefix mode (for DeepSeek models)
if(flags.includes(LLMFlags.deepSeekPrefix) && lastMessage.role === 'assistant'){
    lastMessage.prefix = true
}

// Thinking input (for DeepSeek reasoning models)
if(flags.includes(LLMFlags.deepSeekThinkingInput) && lastMessage.thoughts?.length > 0){
    lastMessage.reasoning_content = lastMessage.thoughts.join('\n')
}
```

---

## 8. Key Differences From Plugin Approach

### Critical Differences That Affect Output Quality

| Aspect | RisuAI Native | Common Plugin Mistakes |
|--------|--------------|----------------------|
| **temperature** | `db.temperature / 100` (e.g., 170→1.7) | May send raw `170`, or clamp to 2.0, or convert string "1.7" |
| **top_p** | `db.top_p` as-is (already 0-1) | May divide by 100 again (0.65→0.0065) |
| **top_k for Gemini** | Renamed to `topK`, skipped if 0 | May send as `top_k` (wrong key for Gemini) |
| **Parameter inclusion** | Only sends parameters listed in model's `parameters[]` array | May send unsupported params (e.g., `frequency_penalty` to Claude) |
| **Claude system prompt** | Separate `system` field, not in messages | May include system in messages array |
| **Claude message structure** | Structured content blocks with `type: 'text'` | May send plain string content |
| **Claude cache_control** | Added to content blocks at cache points | Often missing entirely |
| **Gemini generation_config** | Parameters nested under `generation_config` | May put at body root level |
| **Gemini safety settings** | `BLOCK_NONE` or `OFF` for all categories | May not include safety settings |
| **Gemini systemInstruction** | Uses `systemInstruction.parts[{text}]` | May omit or format incorrectly |
| **-1000 skip** | Skips parameter entirely when -1000 | May send -1000 as the value |
| **Separate params per model** | Full per-model parameter override system | Usually single global params |
| **Stream mode** | Configurable per-request, default false | May always stream or never stream |
| **anthropic-version header** | Always `"2023-06-01"` | May use old version or omit |
| **anthropic-beta header** | Conditionally adds output-128k, extended-cache-ttl | Often omitted |
| **OpenRouter headers** | X-Title, HTTP-Referer | May be missing |
| **Thinking tokens** | Proper model-specific handling (Claude budget_tokens, Gemini thinkingConfig) | Often ignored or wrong format |

### Specific Example: temperature=170, top_p=0.65

**RisuAI Native sends to OpenAI:**
```json
{
    "model": "gpt-4o",
    "messages": [...],
    "max_tokens": 500,
    "temperature": 1.7,
    "top_p": 0.65,
    "frequency_penalty": 0.7,
    "presence_penalty": 0.7,
    "stream": false
}
```

**RisuAI Native sends to Claude:**
```json
{
    "model": "claude-sonnet-4-6",
    "messages": [{"role":"user","content":[{"type":"text","text":"..."}]}],
    "system": "...",
    "max_tokens": 500,
    "temperature": 1.7,
    "top_k": 0,
    "top_p": 0.65,
    "stream": false
}
```
Note: Claude does NOT receive `frequency_penalty` or `presence_penalty`.

**RisuAI Native sends to Gemini:**
```json
{
    "contents": [{"role":"user","parts":[{"text":"..."}]}],
    "generation_config": {
        "maxOutputTokens": 500,
        "temperature": 1.7,
        "topP": 0.65,
        "presencePenalty": 0.7,
        "frequencyPenalty": 0.7
    },
    "safetySettings": [
        {"category":"HARM_CATEGORY_SEXUALLY_EXPLICIT","threshold":"BLOCK_NONE"},
        {"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"BLOCK_NONE"},
        {"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_NONE"},
        {"category":"HARM_CATEGORY_DANGEROUS_CONTENT","threshold":"BLOCK_NONE"},
        {"category":"HARM_CATEGORY_CIVIC_INTEGRITY","threshold":"BLOCK_NONE"}
    ],
    "systemInstruction": {"parts":[{"text":"..."}]}
}
```
Note: Parameters are **nested under `generation_config`** with **camelCase names**.

### Body Interceptors

RisuAI has a plugin system (`bodyIntercepterStore`) that can modify the request body before it's sent:
```typescript
if(arg.interceptor){
    for (const interceptor of bodyIntercepterStore) {
        arg.body = await interceptor.callback(arg.body, arg.interceptor) || arg.body
    }
}
```
This means plugins registered as interceptors can modify any request, which could be a source of quality differences if an interceptor is modifying parameters.

---

## Summary: What a Plugin Must Match Exactly

To produce identical outputs to RisuAI native, a plugin must:

1. **temperature**: Read `db.temperature`, divide by 100, send as number
2. **top_p**: Read `db.top_p`, send as-is (already 0-1)
3. **top_k**: Read `db.top_k`, send as-is for Claude, rename to `topK` for Gemini, skip if 0 for Gemini
4. **frequency_penalty**: Read `db.frequencyPenalty`, divide by 100 — only for OpenAI and Gemini
5. **presence_penalty**: Read `db.PresensePenalty`, divide by 100 — only for OpenAI and Gemini
6. **Skip -1000 values** entirely (don't send the parameter)
7. **Match the exact body structure** for each provider (nested generation_config for Gemini, separate system for Claude)
8. **Match the exact message format** (structured content blocks for Claude, GeminiPart[] for Gemini)
9. **Include all safety settings** (BLOCK_NONE for Gemini)
10. **Include correct headers** (anthropic-version, anthropic-beta, Content-Type)
11. **Handle thinking tokens** correctly per provider
12. **Apply reformater()** preprocessing based on model flags
