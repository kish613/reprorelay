import Fastify from "fastify";
import { registerWorkerTrigger } from "./worker-trigger.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "reprorelay-worker" }));
registerWorkerTrigger(app);

try {
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4001) });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
