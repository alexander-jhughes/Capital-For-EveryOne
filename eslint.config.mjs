import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Agent worktrees are separate checkouts of this repo; linting them here double-counts every file.
      ".claude/**",
      // Generated: the ONNX runtime copied from node_modules (scripts/access/copy-runtime.mjs).
      "public/ort/**",
    ],
  },
];

export default eslintConfig;
