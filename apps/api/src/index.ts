import Fastify from "fastify";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 3001);

app.get("/health", async () => ({ status: "ok", service: "dlr-api" }));

app.get("/api/summary", async () => ({
  internalFiles: 0,
  chatFiles: 0,
  ecommerceProducts: 0,
  assets: 0,
  note: "数据库接入后由真实统计替换",
}));

await app.listen({ port, host: "0.0.0.0" });
