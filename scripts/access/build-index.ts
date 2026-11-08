// Precomputes the example index the browser loads (public/models/access-index.json). Run after editing
// lib/access/catalogue.ts:  npm run access:index   (a test fails if the committed index is out of date).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeIndex } from "../../lib/access/index-codec";
import { buildIndex } from "../../lib/access/understand";
import { nodeEmbed } from "./embed-node";

const out = fileURLToPath(new URL("../../public/models/access-index.json", import.meta.url));
const file = encodeIndex(await buildIndex(nodeEmbed()));
writeFileSync(out, `${JSON.stringify(file)}\n`);
console.log(`Wrote ${file.labels.length} examples (${file.dims} dimensions, hash ${file.hash}) to public/models/access-index.json`);
