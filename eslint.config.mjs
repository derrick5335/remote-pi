import globals from "globals";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.mjs", "**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-fallthrough": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-self-assign": "error",
      "no-unsafe-finally": "error",
      "no-undef": "error",
      // Line budget must come from simplification, not from cramming statements onto one line.
      "max-len": ["error", { code: 180, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreUrls: true, ignoreComments: true }],
      "max-statements-per-line": ["error", { max: 2 }],
      "brace-style": ["error", "1tbs", { allowSingleLine: true }],
    },
  },
  // ref: https://typescript-eslint.io/packages/parser/ — parse TS syntax without changing the existing rules.
  { files: ["**/*.ts"], languageOptions: { parser: tsParser } },
];
