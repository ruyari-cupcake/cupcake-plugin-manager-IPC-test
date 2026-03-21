/**
 * Rollup config for cupcake-provider-v4
 *
 * Builds each plugin (manager, 7 providers, 4 features) as a standalone
 * IIFE bundle with shared code tree-shaken and inlined.
 *
 * Output: dist/<plugin-name>.js — each is a self-contained V3 plugin
 * with //@api 3.0 header and metadata comments.
 */
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

/* ─── Plugin entries ─── */
const entries = [
    // Manager
    { input: 'src/manager/index.js', name: 'cupcake-provider-manager', displayName: 'Cupcake Provider Manager', version: '2.0.3', icon: '🧁', description: 'IPC-based multi-provider manager with settings UI' },

    // Providers
    { input: 'src/providers/anthropic.js', name: 'cpm-provider-anthropic', displayName: 'CPM Provider - Anthropic', version: '2.0.3', icon: '🤖', description: 'Anthropic Claude provider (IPC)' },
    { input: 'src/providers/openai.js', name: 'cpm-provider-openai', displayName: 'CPM Provider - OpenAI', version: '2.0.3', icon: '🧠', description: 'OpenAI GPT provider (IPC)' },
    { input: 'src/providers/gemini.js', name: 'cpm-provider-gemini', displayName: 'CPM Provider - Gemini', version: '2.0.3', icon: '💎', description: 'Google AI Studio Gemini provider (IPC)' },
    { input: 'src/providers/vertex.js', name: 'cpm-provider-vertex', displayName: 'CPM Provider - Vertex AI', version: '2.0.3', icon: '🌐', description: 'Google Vertex AI provider with OAuth (IPC)' },
    { input: 'src/providers/aws.js', name: 'cpm-provider-aws', displayName: 'CPM Provider - AWS Bedrock', version: '2.0.3', icon: '🔶', description: 'AWS Bedrock provider with V4 signing (IPC)' },
    { input: 'src/providers/deepseek.js', name: 'cpm-provider-deepseek', displayName: 'CPM Provider - DeepSeek', version: '2.0.3', icon: '🐋', description: 'DeepSeek Chat/Reasoner provider (IPC)' },
    { input: 'src/providers/openrouter.js', name: 'cpm-provider-openrouter', displayName: 'CPM Provider - OpenRouter', version: '2.0.3', icon: '🔀', description: 'OpenRouter dynamic model provider (IPC)' },

    // Features
    { input: 'src/features/copilot.js', name: 'cpm-copilot-manager', displayName: 'CPM Copilot Token Manager', version: '2.0.3', icon: '🔑', description: 'GitHub Copilot OAuth token manager (IPC)' },
    { input: 'src/features/transcache.js', name: 'cpm-translation-cache', displayName: 'CPM Translation Cache', version: '2.0.3', icon: '💾', description: 'Translation cache manager with corrections (IPC)' },
    { input: 'src/features/resizer.js', name: 'cpm-chat-resizer', displayName: 'CPM Chat Resizer', version: '2.0.3', icon: '↕️', description: 'Chat input textarea resizer (IPC)' },
    { input: 'src/features/navigation.js', name: 'cpm-chat-navigation', displayName: 'CPM Chat Navigation', version: '2.0.3', icon: '🧭', description: 'Chat message navigation widget (IPC)' },
];

/* ─── GitHub raw base URL for @update-url ─── */
const RAW_BASE = 'https://raw.githubusercontent.com/ruyari-cupcake/cupcake-plugin-manager-IPC-test/main/dist';

/* ─── Banner builder ─── */
function makeBanner(entry) {
    const lines = [
        `//@api 3.0`,
        `//@name ${entry.displayName}`,
        `//@display-name ${entry.displayName}`,
        `//@version ${entry.version}`,
        `//@description ${entry.description}`,
        `//@icon ${entry.icon}`,
        `//@author Cupcake`,
        `//@update-url ${RAW_BASE}/${entry.name}.js`,
    ];
    // Provider-manager gets the auto-update toggle arg
    if (entry.args) {
        for (const arg of entry.args) {
            lines.push(`//@arg ${arg}`);
        }
    }
    lines.push(
        `// Built from cupcake-provider-v4 — IPC architecture`,
        `// Generated: ${new Date().toISOString().substring(0, 10)}`,
    );
    return lines.join('\n');
}

/* ─── Rollup config array ─── */
export default entries.map(entry => ({
    input: entry.input,
    output: {
        file: `dist/${entry.name}.js`,
        format: 'iife',
        banner: process.env.NODE_ENV === 'production' ? '' : makeBanner(entry),
        sourcemap: false,
    },
    treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
    },
    plugins: [
        nodeResolve(),
        ...(process.env.NODE_ENV === 'production' ? [terser({
            compress: {
                passes: 3,
                pure_getters: true,
                drop_console: false,
                ecma: 2020,
                toplevel: true,
                unsafe_methods: true,
            },
            mangle: {
                properties: false,
                toplevel: true,
            },
            format: {
                preamble: makeBanner(entry),
                comments: false,       // 모든 주석 제거 후 preamble로 배너 추가
                ecma: 2020,
            },
        })] : []),
    ],
    // Suppress "circular dependency" warnings for internal modules
    onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        warn(warning);
    },
}));
