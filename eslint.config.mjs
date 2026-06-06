import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["src/generated/**", "node_modules/**", "dist/**", "coverage/**", ".next/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Intentional control-character stripping for log-injection prevention.
      "no-control-regex": "off",
    },
  },
  {
    // Config files run in a CommonJS/CLI context where sync require is needed.
    files: ["*.config.ts", "*.config.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.integration.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];
