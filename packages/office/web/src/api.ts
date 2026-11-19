/**
 * Zugriff auf das Office-Gateway (P09) aus dem Browser. Lesend per GET, schreibend per POST mit
 * JSON und dem CSRF-Token der Sitzung im Header `X-CSRF-Token` (plan.md Kap. 5.11). Das Cookie
 * setzt das Gateway mit `HttpOnly`; der Browser-Code sieht es nie.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function body(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(res.status, "Antwort ist kein JSON");
  }
}

function errorText(data: unknown, status: number): string {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const message = (data as Record<string, unknown>)["error"];
    if (typeof message === "string") {
      return message;
    }
  }
  return `Fehler ${String(status)}`;
}

export class Api {
  csrfToken: string | null = null;
  private readonly fetch: typeof fetch;

  constructor(fetchFn?: typeof fetch) {
    this.fetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get(path: string): Promise<unknown> {
    const res = await this.fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const data = await body(res);
    if (!res.ok) {
      throw new ApiError(res.status, errorText(data, res.status));
    }
    return data;
  }

  async post(path: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.csrfToken !== null) {
      headers["x-csrf-token"] = this.csrfToken;
    }
    const res = await this.fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await body(res);
    if (!res.ok) {
      throw new ApiError(res.status, errorText(data, res.status));
    }
    return data;
  }
}
