// Lets Node (22.15+ / 24, which run .ts files natively) resolve the extensionless relative imports used in lib/,
// so the training script needs no extra dependency. Usage: node --import ./scripts/personalisation/ts-resolve.mjs <script.ts>
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (/^\.{1,2}\//.test(specifier) && !/\.(m?[jt]s|json)$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});
