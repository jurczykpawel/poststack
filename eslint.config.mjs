import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/**", "dist/**", "coverage/**", ".next/**", "src/server/ui/static/vendor/**", ".claude/**", "landing/**"] },
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
  {
    // First-party browser scripts served from /static (not bundled) — give them browser globals.
    files: ["src/server/ui/static/**/*.js"],
    languageOptions: { globals: { document: "readonly", window: "readonly", Event: "readonly", navigator: "readonly", location: "readonly", matchMedia: "readonly", requestAnimationFrame: "readonly", setTimeout: "readonly", CustomEvent: "readonly", MutationObserver: "readonly", getComputedStyle: "readonly" } },
    rules: {
      "no-prototype-builtins": "off",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
    },
  },
];
