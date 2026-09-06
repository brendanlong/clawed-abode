import nextConfig from 'eslint-config-next';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  ...nextConfig,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['node_modules/', '.next/', 'prisma/', 'data/', 'src/generated/'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // disallowTypeAnnotations off: integration tests type module bindings as
      // `typeof import('./x')` because they import after the test DB is ready.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],
      // Backend code must use createLogger from @/lib/logger; console.warn/error stay
      // allowed for client code and the logger's own sink.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Scripts and tests talk to a human on stdout; the logger's sink is console by design.
    files: ['scripts/**', 'src/**/*.test.{ts,tsx}', 'src/test/**', 'src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  }
);
