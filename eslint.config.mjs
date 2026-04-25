import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const RESTRICTED_FIXTURE_TYPES = [
  {
    selector: 'TSInterfaceDeclaration[id.name="Fixture"]',
    message:
      'Do not redefine `interface Fixture`. Import from `app/[leagueSlug]/_components/fixtures/shared`.',
  },
  {
    selector: 'TSInterfaceDeclaration[id.name="LiveFixtureScore"]',
    message:
      'Do not redefine `interface LiveFixtureScore`. Import from `app/[leagueSlug]/_components/fixtures/shared`.',
  },
  {
    selector: 'TSInterfaceDeclaration[id.name="LivePlayerScore"]',
    message:
      'Do not redefine `interface LivePlayerScore`. Import from `app/[leagueSlug]/_components/fixtures/shared`.',
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Lock the Phase 5 consolidation: fixture page files must import shared
    // types, not redeclare them. Other layers (lib/fpl-cache, playoffs shared)
    // intentionally own their own variants of these shapes.
    files: ["src/app/**/fixtures/page.tsx", "src/app/**/uefa-fixtures/page.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...RESTRICTED_FIXTURE_TYPES],
    },
  },
]);

export default eslintConfig;
