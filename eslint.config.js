import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.wrangler/**",
      "**/dist/**",
      "**/build/**",
      "**/.react-router/**",
      "**/worker-configuration.d.ts",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
