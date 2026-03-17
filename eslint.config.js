import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.es2022,
                ...globals.node,
                Risu: 'readonly',
                risuai: 'readonly',
                Risuai: 'readonly',
            },
        },
        rules: {
            // 보안 관련
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',

            // 코드 품질
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
            'no-constant-condition': ['warn', { checkLoops: false }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'prefer-const': 'warn',
            'no-var': 'warn',
            'eqeqeq': ['warn', 'smart'],

            // 허용 (프로젝트 특성)
            'no-console': 'off',
            'no-prototype-builtins': 'off',
        },
    },
    {
        ignores: ['dist/**', 'node_modules/**', 'scripts/**', '*.config.js', 'src/shared/tailwind-css.generated.js'],
    },
];
