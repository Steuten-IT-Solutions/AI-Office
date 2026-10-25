import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export interface Config {
  appId: string;
  privateKey: KeyObject;
  owner: string;
  repo: string;
}

/** Liest die Konfiguration aus Umgebungsvariablen. Der Schlüssel bleibt in der Datei des CEO. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appId = required(env, "AIO_APP_ID");
  const keyFile = required(env, "AIO_APP_KEY_FILE");
  return {
    appId,
    privateKey: createPrivateKey(readFileSync(keyFile)),
    owner: env["AIO_OWNER"] ?? "Steuten-IT-Solutions",
    repo: env["AIO_TEST_REPO"] ?? "aio-spike-s1",
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`Umgebungsvariable ${name} fehlt`);
  }
  return value;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** JWT für die App-Authentifizierung (RS256, höchstens 10 Minuten gültig laut GitHub). */
export function createAppJwt(appId: string, key: KeyObject, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  used: number;
  resource: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  etag: string | null;
  rate: RateLimit | null;
}

function readRate(headers: Headers): RateLimit | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const used = headers.get("x-ratelimit-used");
  if (limit === null || remaining === null || used === null) {
    return null;
  }
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    used: Number(used),
    resource: headers.get("x-ratelimit-resource") ?? "unbekannt",
  };
}

export async function api(
  token: string,
  method: string,
  path: string,
  options: { body?: unknown; etag?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "aio-spike-s1",
  };
  if (options.etag !== undefined) {
    headers["If-None-Match"] = options.etag;
  }
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: response.status,
    body,
    etag: response.headers.get("etag"),
    rate: readRate(response.headers),
  };
}

/** Holt ein Installations-Token für das Test-Repo. Das Token wird nie ausgegeben. */
export async function installationToken(config: Config): Promise<string> {
  const jwt = createAppJwt(config.appId, config.privateKey, Math.floor(Date.now() / 1000));
  const installation = await api(jwt, "GET", `/repos/${config.owner}/${config.repo}/installation`);
  if (installation.status !== 200) {
    throw new Error(
      `App ist auf ${config.owner}/${config.repo} nicht installiert (HTTP ${String(installation.status)})`,
    );
  }
  const id = (installation.body as { id: number }).id;
  const token = await api(jwt, "POST", `/app/installations/${String(id)}/access_tokens`, {
    body: { repositories: [config.repo] },
  });
  if (token.status !== 201) {
    throw new Error(`Installations-Token nicht erhalten (HTTP ${String(token.status)})`);
  }
  return (token.body as { token: string }).token;
}

/** Kurze Fehlermeldung aus einer API-Antwort, ohne Header oder Tokens. */
export function message(response: ApiResponse): string {
  const body = response.body;
  if (typeof body === "object" && body !== null && "message" in body) {
    return String(body.message);
  }
  return "";
}
