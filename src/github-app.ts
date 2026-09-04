import { createHmac, timingSafeEqual } from "node:crypto";

export interface GitHubApiClientOptions {
  token: string;
  apiBaseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubRepositorySummary {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

export interface GitHubWorkflowRunSummary {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
}

export interface GitHubWorkflowRunsResponse {
  total_count: number;
  workflow_runs: GitHubWorkflowRunSummary[];
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(`GitHub API request failed: ${method} ${path} returned HTTP ${status}`);
    this.name = "GitHubApiError";
  }
}

export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
): boolean {
  if (secret.length === 0 || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const suppliedHex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export class GitHubApiClient {
  private readonly token: string;
  private readonly apiBaseUrl: URL;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubApiClientOptions) {
    if (options.token.trim().length === 0) {
      throw new Error("GitHub installation token must not be empty");
    }

    const apiBaseUrl = new URL(options.apiBaseUrl ?? "https://api.github.com/");
    if (apiBaseUrl.protocol !== "https:") {
      throw new Error("GitHub API base URL must use HTTPS");
    }
    if (apiBaseUrl.username || apiBaseUrl.password || apiBaseUrl.search || apiBaseUrl.hash) {
      throw new Error("GitHub API base URL must not contain credentials, a query, or a fragment");
    }
    if (!apiBaseUrl.pathname.endsWith("/")) {
      apiBaseUrl.pathname += "/";
    }

    this.token = options.token;
    this.apiBaseUrl = apiBaseUrl;
    this.userAgent = options.userAgent ?? "karzoun-flowforge";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepositorySummary> {
    return this.request<GitHubRepositorySummary>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    branch?: string,
  ): Promise<GitHubWorkflowRunsResponse> {
    const query = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    return this.request<GitHubWorkflowRunsResponse>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs${query}`,
    );
  }

  async createRepositoryDispatch(
    owner: string,
    repo: string,
    eventType: string,
    clientPayload: Record<string, unknown> = {},
  ): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(eventType)) {
      throw new Error("GitHub repository_dispatch event type is invalid");
    }

    await this.request<void>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
      {
        event_type: eventType,
        client_payload: clientPayload,
      },
    );
  }

  private buildUrl(path: string): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
      throw new Error("GitHub API path must be an absolute API path without traversal");
    }

    const url = new URL(path.slice(1), this.apiBaseUrl);
    if (url.origin !== this.apiBaseUrl.origin) {
      throw new Error("GitHub API request escaped the configured origin");
    }
    return url;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "user-agent": this.userAgent,
      "x-github-api-version": "2022-11-28",
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(this.buildUrl(path), init);
    if (!response.ok) {
      throw new GitHubApiError(response.status, method, path);
    }
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
