import Fastify from "fastify";
import { createStore, type Mode } from "./store.js";

const actorIdFrom = (header: string | string[] | undefined) =>
  typeof header === "string" ? header : "anonymous";

export const buildServer = (mode: Mode) => {
  const app = Fastify({ logger: false });
  const store = createStore(mode);

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { userId: string } }>("/__state/:userId", async (request) =>
    store.snapshot(request.params.userId),
  );

  app.post<{ Body: { itemId: "sword"; price: number } }>(
    "/api/purchase",
    async (request, reply) => {
      const result = store.purchase(
        actorIdFrom(request.headers["x-actor-id"]),
        request.body,
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Body: { itemId: string; toUserId: string } }>(
    "/api/transfer",
    async (request, reply) => {
      const result = store.transfer(
        actorIdFrom(request.headers["x-actor-id"]),
        request.body,
      );
      return reply.code(result.status).send(result.body);
    },
  );

  return app;
};
