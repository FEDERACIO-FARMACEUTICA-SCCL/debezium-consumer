import { logger } from "../logger";

export interface ApiClientConfig {
  baseUrl: string;
  username: string;
  password: string;
}

const FETCH_TIMEOUT_MS = 30_000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;

  private accessToken: string | null = null;
  private expiresAt = 0;
  private authPromise: Promise<string> | null = null;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
  }

  async request(
    method: string,
    path: string,
    body: unknown
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    let result = await this.doFetch(method, path, body, token);

    if (result.status === 401) {
      logger.info({ tag: "API" }, "Received 401, renewing token and retrying");
      const freshToken = await this.authenticate();
      result = await this.doFetch(method, path, body, freshToken);
    }

    if (!result.ok) {
      throw new Error(`API call failed: ${method} ${path} → ${result.status}`);
    }

    return { status: result.status, body: result.body };
  }

  private async doFetch(
    method: string,
    path: string,
    body: unknown,
    token: string
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    const start = Date.now();

    logger.debug({ tag: "API", method, path, requestBody: body }, "API request");

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const durationMs = Date.now() - start;
    let responseBody: unknown;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      responseBody = await res.json();
    } else {
      responseBody = await res.text();
    }

    if (res.ok) {
      logger.info(
        { tag: "API", method, path, status: res.status, durationMs },
        `${method} ${path} → ${res.status} (${durationMs}ms)`
      );
      logger.debug({ tag: "API", responseBody }, "API response body");
    } else {
      logger.error(
        { tag: "API", method, path, status: res.status, durationMs },
        `${method} ${path} → ${res.status} (${durationMs}ms)`
      );
      logger.debug(
        { tag: "API", method, path, responseBody },
        "API error response body"
      );
    }

    return { status: res.status, ok: res.ok, body: responseBody };
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    if (this.authPromise) return this.authPromise;
    this.authPromise = this.authenticate().finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  }

  private async authenticate(): Promise<string> {
    const url = `${this.baseUrl}/ingest-api/token`;
    const start = Date.now();

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const durationMs = Date.now() - start;

    if (!res.ok) {
      const errorBody = await res.text();
      logger.error(
        { tag: "API", action: "authenticate", status: res.status, durationMs },
        `Authentication failed → ${res.status} (${durationMs}ms)`
      );
      logger.debug(
        { tag: "API", action: "authenticate", errorBody },
        "Authentication error response body"
      );
      throw new Error(`Authentication failed: ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000 - 60_000;

    logger.info(
      { tag: "API", action: "authenticate", expiresIn: data.expires_in, durationMs },
      `Token obtained, expires in ${data.expires_in}s`
    );

    return this.accessToken;
  }
}
