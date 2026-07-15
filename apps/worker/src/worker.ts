import { loadWorkerConfig } from "./config.js";
import { runWorkerOnce } from "./run-once.js";

const config = loadWorkerConfig();

async function tick(): Promise<void> {
  const result = await runWorkerOnce();
  console.log(`[reprorelay-worker] processed=${result.processed} github=${result.github}`);
}

await tick();

if (process.argv.includes("--once")) {
  process.exit(0);
}

setInterval(() => {
  tick().catch((error) => {
    console.error("[reprorelay-worker] tick failed", error);
  });
}, config.intervalMs);
