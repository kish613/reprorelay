import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../apps/api/src/app.js";
import { createRecoveringLoader } from "../apps/api/src/app-loader.js";
import { loadConfig } from "../apps/api/src/config.js";

const getApp = createRecoveringLoader(async () => {
  const app = await buildApp({ config: loadConfig() });
  await app.ready();
  return app;
});

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const app = await getApp();
  request.url = normalizeRequestUrl(request.url ?? "/");

  await new Promise<void>((resolve) => {
    response.once("finish", resolve);
    response.once("close", resolve);
    app.server.emit("request", request, response);
  });
}

function normalizeRequestUrl(value: string): string {
  const url = new URL(value, "http://reprorelay.local");
  const routedPath = url.searchParams.get("__reprorelay_path") ?? "/__invalid_function_route";
  url.searchParams.delete("__reprorelay_path");
  const query = url.searchParams.toString();
  return `${routedPath}${query ? `?${query}` : ""}`;
}
