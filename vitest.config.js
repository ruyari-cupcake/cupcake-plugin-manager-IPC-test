import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.js'],
        environment: 'node',
        globals: true,
        coverage: {
            provider: 'v8',
            include: ['src/shared/**/*.js'],
            exclude: [
                'src/manager/**',
                'src/features/**',
                'src/providers/**',
                'src/shared/aws-signer.js',  // Web Crypto API 의존 — 런타임 전용
                'src/shared/helpers.js',      // RisuAI 런타임 API 의존 — 런타임 전용
            ],
            thresholds: {
                statements: 70,
                branches: 55,
                functions: 80,
                lines: 70,
            },
        },
    },
});
