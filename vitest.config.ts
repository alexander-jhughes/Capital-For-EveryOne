import { defineConfig } from "vitest/config";

// Local worktrees under .claude are separate checkouts of this repo. Without this, every test file ran twice or more
// and the totals were misleading.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.next/**", ".claude/**", "**/.claude/**"],
  },
});
