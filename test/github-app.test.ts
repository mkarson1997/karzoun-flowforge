import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GitHubApiClient,
  GitHubApiError,
  verifyGitHubWebhookSignature,
} from "../src/github-app.js";

describe("GitHub webhook verification", () => {
  it("accepts a valid sha256 signature", () => {
    const secret = "test-webhook-secret";
    const body = Buffer.from('{"action":"opened"}', "utf8");
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(secret, body, signature)).toBe(true);
  });

  it("rejects malformed or incorrect signatures", () => {
    const body = '{"action":"opened"}';
    expect(verifyGitHubWebhookSignature("secret", body, "sha1=abc")).toBe(false);
    expect(verifyGitHubWebhookSignature("secret", body, "sha256=xyz")).toBe(false);
    expect(verifyGitHubWebhookSignature("secret", body, `sha256=${"0".repeat(64)}`)).toBe(false);
  });
});

describe("GitHubApiClient", () => {
  it("uses installation-token authentication and safely encodes repository names", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(
        JSON.stringify({
          id: 42,
          name: "repo/name",
          full_name: "owner space/repo/name",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/owner-space/repo-name",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "installation-token", fetchImpl });
    const repository = await client.getRepository("owner space", "repo/name");

    expect(repository.id).toBe(42);
    expect(requestUrl).toBe("https://api.github.com/repos/owner%20space/repo%2Fname");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer installation-token");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("creates repository_dispatch events without exposing the token in the body", async () => {
    let body = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    };

    const client = new GitHubApiClient({ token: "secret-token", fetchImpl });
    await client.createRepositoryDispatch("owner", "repo", "flowforge.completed", {
      executionId: "run-123",
    });

    expect(JSON.parse(body)).toEqual({
      event_type: "flowforge.completed",
      client_payload: { executionId: "run-123" },
    });
    expect(body).not.toContain("secret-token");
  });

  it("surfaces status and endpoint without copying an API response body into errors", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"message":"private diagnostic"}', { status: 403 });
    const client = new GitHubApiClient({ token: "installation-token", fetchImpl });

    const request = client.getRepository("owner", "repo");
    await expect(request).rejects.toBeInstanceOf(GitHubApiError);
    await expect(request).rejects.not.toThrow(/private diagnostic/);
  });

  it("requires HTTPS for GitHub API endpoints", () => {
    expect(
      () => new GitHubApiClient({ token: "token", apiBaseUrl: "http://example.test/api/v3/" }),
    ).toThrow(/HTTPS/);
  });
});
