import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import stylistic from '@stylistic/eslint-plugin';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores(['.next/**', 'out/**', 'coverage/**', 'next-env.d.ts']),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      // Prettier positions braces; ESLint also requires them on every body.
      curly: ['error', 'all'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'directive', next: '*' },
        { blankLine: 'any', prev: 'directive', next: 'directive' },
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        // Keep related declarations together; separate their setup from work.
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        {
          blankLine: 'any',
          prev: ['const', 'let', 'var'],
          next: ['const', 'let', 'var'],
        },
        { blankLine: 'always', prev: '*', next: ['return', 'throw'] },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'next',
            'next/*',
            'react',
            'react/*',
            'react-dom',
            'react-dom/*',
            '@upstash/*',
            'redis',
            'ioredis',
            '@/infrastructure/*',
            '@/app/*',
            '@/components/*',
            '@/lib/*',
            '**/infrastructure/**',
            '**/components/**',
            '**/app/**',
            '**/lib/**',
          ],
        },
      ],
    },
  },
]);
