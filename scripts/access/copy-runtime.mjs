// Copies the browser runtime for on-device understanding into public/, so the browser loads it from this app and not
// a CDN, and so webpack never has to bundle it (bundling Transformers.js made the first page compile take minutes):
//   public/vendor/transformers.min.js   Transformers.js, prebuilt single-file ES module (ONNX runtime included)
//   public/ort/ort-wasm-simd-threaded.* the ONNX WebAssembly binary it loads
// Runs on install, dev and build. The files are generated, so both folders are git-ignored.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "package.json"));
let dist;
try {
  // The package doesn't export package.json, so resolve its entry (inside dist/) and step up to the package folder.
  const entry = require.resolve("onnxruntime-web", { paths: [dirname(require.resolve("@huggingface/transformers"))] });
  dist = dirname(dirname(entry));
} catch {
  console.warn("[access] onnxruntime-web not installed yet; skipping runtime copy");
  process.exit(0);
}
const vendor = join(root, "public/vendor");
mkdirSync(vendor, { recursive: true });
const transformersDist = join(dirname(require.resolve("@huggingface/transformers")), "transformers.min.js");
if (existsSync(transformersDist)) copyFileSync(transformersDist, join(vendor, "transformers.min.js"));
else console.warn("[access] transformers.min.js not found; on-device understanding will be unavailable");

const out = join(root, "public/ort");
mkdirSync(out, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  const src = join(dist, "dist", f);
  if (!existsSync(src)) {
    console.warn(`[access] ${f} not found in onnxruntime-web; on-device understanding will be unavailable`);
    continue;
  }
  copyFileSync(src, join(out, f));
}
