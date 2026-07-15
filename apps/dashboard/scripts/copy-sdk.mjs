// Ships the browser SDK's IIFE bundle with the dashboard so deployments serve
// it at /sdk/reprorelay.js — client sites embed the SDK from the ReproRelay
// deployment itself and pick up fixes on every deploy (no npm/CDN involved).
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "packages", "browser-sdk", "dist", "reprorelay.iife.js");
const target = join(here, "..", "dist", "sdk", "reprorelay.js");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log("Copied browser SDK bundle to dist/sdk/reprorelay.js");
