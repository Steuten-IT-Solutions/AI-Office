"""mitmproxy-Addon für Spike S1b und S1g (docs/etappe-0.md 3.1, plan.md 5.7 „Netz“).

Modus `protokoll`: leitet alles weiter und protokolliert je Anfrage nur Host, Methode, Pfad ohne
Query, Art der Anmeldung und Status. Nie Header-Werte, Query oder Inhalte.
Modus `allowlist`: wie oben, lässt aber nur Anfragen durch, die
  1. nach Methode, Host und Pfadmuster in der Allowlist stehen und
  2. die dort vermerkte Anmeldung tragen; `unser` heißt: `Authorization: Bearer <setup-token>`
     (verglichen über SHA-256) und kein `x-api-key`.
  3. über HTTPS auf Port 443 laufen (nie Klartext-HTTP, nie ein anderer Port).
Alles andere beantwortet der Proxy selbst mit 403 und dem Header `x-aio-proxy: blockiert`.

Die Allowlist erzeugt `s1b.ts allowlist` aus dem Protokoll des ersten Durchgangs.
Optionen (mitmdump --set): aio_modus, aio_protokoll, aio_allowlist, aio_token_sha256.
Addon-API: https://docs.mitmproxy.org/stable/addons/overview/ (Ereignisse http_connect, request,
response).
"""

import hashlib
import json
import re
import time

from mitmproxy import ctx, http

BLOCK_HEADER = {"x-aio-proxy": "blockiert", "content-type": "text/plain"}


def normalize_path(path: str) -> str:
    """Pfad ohne Query; Abschnitte, die wie IDs aussehen, werden zu `*` (wie s1b.ts)."""
    path = path.split("?", 1)[0]
    parts = []
    for part in path.split("/"):
        if re.fullmatch(r"[0-9a-fA-F-]{16,}|[0-9]+|[A-Za-z0-9_-]{24,}", part):
            parts.append("*")
        else:
            parts.append(part)
    return "/".join(parts)


class AioProxy:
    def __init__(self) -> None:
        self.allow: list[dict] = []
        self.token_sha256 = ""

    def load(self, loader) -> None:
        loader.add_option("aio_modus", str, "protokoll", "protokoll oder allowlist")
        loader.add_option("aio_protokoll", str, "/tmp/anfragen.jsonl", "Protokolldatei")
        loader.add_option("aio_allowlist", str, "", "Allowlist (JSON)")
        loader.add_option("aio_token_sha256", str, "", "Datei mit SHA-256 des setup-token")

    def configure(self, updated) -> None:
        if ctx.options.aio_allowlist:
            with open(ctx.options.aio_allowlist, encoding="utf-8") as f:
                self.allow = json.load(f)["eintraege"]
        if ctx.options.aio_token_sha256:
            with open(ctx.options.aio_token_sha256, encoding="utf-8") as f:
                self.token_sha256 = f.read().strip()

    def auth_class(self, flow: http.HTTPFlow) -> str:
        headers = flow.request.headers
        if "x-api-key" in headers:
            return "fremd"
        value = headers.get("authorization", "")
        if not value:
            return "keins"
        scheme, _, credential = value.partition(" ")
        if scheme.lower() != "bearer" or not self.token_sha256:
            return "fremd"
        digest = hashlib.sha256(credential.strip().encode()).hexdigest()
        return "unser" if digest == self.token_sha256 else "fremd"

    def host_allowed(self, host: str) -> bool:
        return any(e["host"] == host for e in self.allow)

    def log(self, flow: http.HTTPFlow, auth: str, decision: str) -> None:
        entry = {
            "zeit": round(time.time(), 3),
            "modus": ctx.options.aio_modus,
            "methode": flow.request.method,
            "host": flow.request.host,
            "schema": flow.request.scheme,
            "port": flow.request.port,
            "pfad": normalize_path(flow.request.path),
            "auth": auth,
            "entscheidung": decision,
        }
        with open(ctx.options.aio_protokoll, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def http_connect(self, flow: http.HTTPFlow) -> None:
        # Fremde Hosts schon beim CONNECT abweisen; erlaubte Hosts werden entschlüsselt und je
        # Anfrage geprüft.
        if ctx.options.aio_modus == "allowlist" and (
            flow.request.port != 443 or not self.host_allowed(flow.request.host)
        ):
            self.log(flow, "keins", "blockiert-connect")
            flow.response = http.Response.make(403, b"blockiert\n", BLOCK_HEADER)

    def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.method == "CONNECT":
            return
        auth = self.auth_class(flow)
        if ctx.options.aio_modus != "allowlist":
            self.log(flow, auth, "weitergeleitet")
            return
        # Ziel der Weiterleitung, nicht der Host-Header: `pretty_host` bevorzugt den Header, den
        # der Client frei setzen kann (Docstring von Request.pretty_host in mitmproxy 12.3.1,
        # https://github.com/mitmproxy/mitmproxy/blob/v12.3.1/mitmproxy/http.py).
        host = flow.request.host
        if flow.request.scheme != "https" or flow.request.port != 443:
            # Sonst ginge unser Token über Klartext-HTTP oder an einen anderen Port.
            self.log(flow, auth, "blockiert")
            flow.response = http.Response.make(403, b"blockiert\n", BLOCK_HEADER)
            return
        path = normalize_path(flow.request.path)
        method = flow.request.method
        for entry in self.allow:
            if entry["host"] == host and entry["methode"] == method and entry["pfad"] == path:
                if auth in entry["auth"]:
                    self.log(flow, auth, "erlaubt")
                    return
        self.log(flow, auth, "blockiert")
        flow.response = http.Response.make(403, b"blockiert\n", BLOCK_HEADER)


addons = [AioProxy()]
