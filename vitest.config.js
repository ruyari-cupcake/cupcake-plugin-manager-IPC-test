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
                'src/shared/tailwind-css.generated.js',  // 생성 파일
            ],
            reporter: ['text', 'json-summary', 'json'],
            thresholds: {
                statements: 80,
                branches: 70,
                functions: 80,
                lines: 80,
            },
        },
    },
});
