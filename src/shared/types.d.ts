/**
 * @file types.d.ts — 공유 타입 정의 (checkJs 모드에서 JSDoc와 함께 사용)
 *
 * 이 파일은 TypeScript 컴파일러가 JSDoc 타입 체크에 사용하는
 * 프로젝트 전역 타입 정의입니다.
 */

// ══════════════════════════════════════════════
// 메시지 타입
// ══════════════════════════════════════════════

/** 원시 채팅 메시지 (RisuAI 런타임에서 전달) */
export interface ChatMessage {
    role: string;
    content: string | ContentPart[];
    name?: string;
    multimodals?: Multimodal[];
    cachePoint?: boolean;
}

/** 구조적 콘텐츠 블록 (OpenAI / Anthropic / Gemini 공통 수퍼셋) */
export interface ContentPart {
    type: string;
    text?: string;
    image_url?: string | { url: string; detail?: string };
    input_audio?: { data: string; format: string };
    source?: ImageSource;
    inlineData?: InlineData;
    fileData?: { mimeType: string; fileUri: string };
    cache_control?: { type: string };
    thought?: boolean;
    thought_signature?: string;
}

export interface ImageSource {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
}

export interface InlineData {
    mimeType: string;
    data: string;
}

/** 멀티모달 첨부 데이터 */
export interface Multimodal {
    type: 'image' | 'audio' | 'video';
    base64?: string;
    url?: string;
    mimeType?: string;
}

/** extractNormalizedMessagePayload 반환 타입 */
export interface NormalizedPayload {
    text: string;
    multimodals: Multimodal[];
}

export interface SchemaDefinition {
    type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | string;
    required?: boolean;
    default?: unknown;
    maxLength?: number;
    maxItems?: number;
    items?: SchemaDefinition;
    properties?: Record<string, SchemaDefinition>;
}

// ══════════════════════════════════════════════
// 프로바이더 응답 타입
// ══════════════════════════════════════════════

/** 프로바이더 공통 응답 */
export interface ProviderResult {
    success: boolean;
    content: string;
    _status?: number;
}

// ══════════════════════════════════════════════
// OpenAI 포맷
// ══════════════════════════════════════════════

export interface OpenAIFormattedMessage {
    role: string;
    content: string | ContentPart[];
    name?: string;
}

export interface OpenAIFormatConfig {
    developerRole?: boolean;
    mergesys?: boolean;
    mustuser?: boolean;
    sysfirst?: boolean;
    altrole?: boolean;
}

// ══════════════════════════════════════════════
// Anthropic 포맷
// ══════════════════════════════════════════════

export interface AnthropicContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    source?: ImageSource;
    cache_control?: { type: string };
}

export interface AnthropicFormattedMessage {
    role: 'user' | 'assistant';
    content: AnthropicContentBlock[];
}

export interface AnthropicFormatResult {
    messages: AnthropicFormattedMessage[];
    system: string;
}

// ══════════════════════════════════════════════
// Gemini 포맷
// ══════════════════════════════════════════════

export interface GeminiPart {
    text?: string;
    inlineData?: InlineData;
    fileData?: { mimeType: string; fileUri: string };
    thought?: boolean;
    thought_signature?: string;
    thoughtSignature?: string;
}

export interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

export interface GeminiFormatResult {
    contents: GeminiContent[];
    systemInstruction: string[];
}

export interface GeminiFormatConfig {
    preserveSystem?: boolean;
    useThoughtSignature?: boolean;
}

export interface GeminiGenerationConfig {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
}

export interface GeminiThinkingConfig {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: string;
    thinking_level?: string;
}

export interface GeminiSafetySetting {
    category: string;
    threshold: string;
}

// ══════════════════════════════════════════════
// SSE 파싱 설정
// ══════════════════════════════════════════════

export interface OpenAISSEConfig {
    showThinking?: boolean;
    _inThinking?: boolean;
    _requestId?: string;
    _accumulatedContent?: string;
}

export interface GeminiSSEConfig {
    showThoughtsToken?: boolean;
    useThoughtSignature?: boolean;
    _inThoughtBlock?: boolean;
    _lastSignature?: string;
    _streamResponseText?: string;
    _streamUsageMetadata?: Record<string, unknown>;
    _requestId?: string;
}

export interface ClaudeSSEConfig {
    showThinking?: boolean;
    _requestId?: string;
}

// ══════════════════════════════════════════════
// IPC 프로토콜
// ══════════════════════════════════════════════

export interface IPCRegistrationPayload {
    name: string;
    models: string[];
    settingsFields?: Record<string, unknown>[];
}

export interface IPCMessage {
    type: string;
    pluginName?: string;
    requestId?: string;
    [key: string]: unknown;
}

// ══════════════════════════════════════════════
// Key Pool
// ══════════════════════════════════════════════

export interface KeyPoolRotationOptions {
    maxRetries?: number;
    isRetryable?: (result: ProviderResult) => boolean;
}

// ══════════════════════════════════════════════
// Window 확장 (RisuAI 런타임 글로벌)
// ══════════════════════════════════════════════

declare global {
    interface Window {
        risuai?: RisuAPI;
        Risuai?: RisuAPI;
    }
}

// ══════════════════════════════════════════════
// RisuAI API (런타임에 주입)
// ══════════════════════════════════════════════

export interface RisuAPI {
    getArgument(key: string): Promise<unknown>;
    setArgument(key: string, value: unknown): void;
    getRootDocument?(): Promise<any>;
    addPluginChannelListener(channel: string, callback: (msg: IPCMessage) => void): void;
    postPluginChannelMessage(target: string, channel: string, message: IPCMessage): void;
    risuFetch?(url: string, options: Record<string, unknown>): Promise<unknown>;
    [key: string]: unknown;
}

// ══════════════════════════════════════════════
// AWS Signer
// ══════════════════════════════════════════════

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

export interface AwsSignedHeaders {
    Authorization: string;
    'x-amz-date': string;
    'x-amz-security-token'?: string;
    'x-amz-content-sha256': string;
    [key: string]: string;
}
