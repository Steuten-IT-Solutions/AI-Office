/**
 * Zugriff auf das Office-Gateway (P09) aus dem Browser. Lesend per GET, schreibend per POST mit
 * JSON und dem CSRF-Token der Sitzung im Header `X-CSRF-Token` (plan.md Kap. 5.11). Das Cookie
 * setzt das Gateway mit `HttpOnly`; der Browser-Code sieht es nie.
 */

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function body(res) {
  const text = await res.text();
  if (text === "") {
    return null;
  }
  try {
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    throw new ApiError(res.status, "Antwort ist kein JSON");
  }
}

/**
 * @param {unknown} data
 * @param {number} status
 * @returns {string}
 */
function errorText(data, status) {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const message = /** @type {Record<string, unknown>} */ (data)["error"];
    if (typeof message === "string") {
      return message;
    }
  }
  return `Fehler ${String(status)}`;
}

export class Api {
  /** @type {string | null} */
  csrfToken = null;

  /**
   * @param {typeof fetch} [fetchFn]
   */
  constructor(fetchFn) {
    this.fetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * @param {string} path
   * @returns {Promise<unknown>}
   */
  async get(path) {
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

  /**
   * @param {string} path
   * @param {unknown} payload
   * @returns {Promise<unknown>}
   */
  async post(path, payload) {
    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/json", accept: "application/json" };
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
