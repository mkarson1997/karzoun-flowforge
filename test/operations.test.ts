import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createOperationalHandler } from "../src/index.js";

describe("operational handler", () => {
  it("serves liveness and readiness without exposing check errors", async () => {
    const server = createServer(
      createOperationalHandler({
        readinessChecks: {
          database: () => true,
          queue: () => {
            throw new Error("postgresql://secret@internal.example/flowforge");
          },
        },
      }),
    );

    const baseUrl = await listen(server);
    try {
      const health = await fetch(`${baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const readiness = await fetch(`${baseUrl}/readyz`);
      expect(readiness.status).toBe(503);
      const body = await readiness.text();
      expect(JSON.parse(body)).toEqual({
        status: "not_ready",
        checks: { database: "ok", queue: "failed" },
      });
      expect(body).not.toContain("secret");
      expect(body).not.toContain("internal.example");
    } finally {
      await close(server);
    }
  });

  it("returns ready when all readiness checks pass", async () => {
    const server = createServer(
      createOperationalHandler({
        readinessChecks: {
          database: async () => true,
          workerQueue: () => true,
        },
      }),
    );

    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "ready",
        checks: { database: "ok", workerQueue: "ok" },
      });
    } finally {
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
