import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Playwright fixtures call `use()`, which is not React's hook.
  { files: ["qa/**"], rules: { "react-hooks/rules-of-hooks": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated QA output (HTML reports, traces, caches).
    "qa-results/**",
    "test-results/**",
    "playwright-report/**",
    ".ai-cache/**",
    "qa/.ai-cache/**",
  ]),
]);

export default eslintConfig;
