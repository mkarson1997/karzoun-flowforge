import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export type ReadinessCheck = () => boolean | Promise<boolean>;

export interface OperationalHandlerOptions {
  readinessChecks?: Readonly<Record<string, ReadinessCheck>>;
}

export function createOperationalHandler(options: OperationalHandlerOptions = {}): RequestListener {
  const readinessChecks = options.readinessChecks ?? {};

  return (request, response) => {
    void handleOperationalRequest(request, response, readinessChecks).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) writeJson(response, { status: "error" });
    });
  };
}

async function handleOperationalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  readinessChecks: Readonly<Record<string, ReadinessCheck>>,
): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    response.statusCode = 405;
    writeJson(response, { status: "method_not_allowed" }, method === "HEAD");
    return;
  }

  const path = new URL(request.url ?? "/", "http://flowforge.local").pathname;

  if (path === "/healthz") {
    response.statusCode = 200;
    writeJson(response, { status: "ok" }, method === "HEAD");
    return;
  }

  if (path === "/readyz") {
    const results = await Promise.all(
      Object.entries(readinessChecks).map(async ([name, check]) => {
        try {
          return [name, (await check()) ? "ok" : "failed"] as const;
        } catch {
          return [name, "failed"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, status]) => status === "ok");
    response.statusCode = ready ? 200 : 503;
    writeJson(response, { status: ready ? "ready" : "not_ready", checks }, method === "HEAD");
    return;
  }

  response.statusCode = 404;
  writeJson(response, { status: "not_found" }, method === "HEAD");
}

function writeJson(response: ServerResponse, value: unknown, headOnly = false): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (headOnly) {
    response.end();
    return;
  }
  response.end(JSON.stringify(value));
}
