# Ergebnis S1b – Endpunkte und Proxy mit Allowlist

Lauf in der VM `aio-dev` am 19.11.2026 mit `spikes/vm/s1b.sh` und `AIO_SANDBOX=ohne` (die
Bash-Sandbox startet im Container nicht, siehe S1a). Ubuntu 26.04.1, Docker 29.9.3, CLI 2.1.312.
Der Bericht des Skripts steht unverändert unten.

## Einordnung

**Ergebnis: Go.**

- Das CLI braucht in allen drei Läufen (Text, Werkzeuge, MCP) nur `api.anthropic.com` mit drei
  Endpunkten: `GET /api/claude_code/policy_limits`, `GET /api/claude_code/settings` und
  `POST /v1/messages`.
- Mit dieser Allowlist laufen alle drei Läufe. Fremder API-Key, fremdes Bearer-Token, unser Token
  plus fremder Key, die Files-API, ein fremder Host mit gefälschtem `Host`-Header und ein fremder
  Host scheitern am Proxy.
- Ein erster Lauf mit eingeschalteter Sandbox war für den Werkzeug-Lauf ungültig, weil Bash dort
  nicht startet. Für die Frage nach Endpunkten spielt die Sandbox keine Rolle
  (spikes/vm/README.md).

## Bericht des Skripts

Zeitpunkt: 2026-11-19T21:25:22.293Z
Image: aio-spike-lauf:ohne (sha256:a24d8711ac98)
CLI: 2.1.312 (Claude Code)
Docker: 29.9.3, Kernel: 7.0.0-43-generic
Gesamtergebnis: Go (alle Prüfungen wie erwartet)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Durchgang 1 (nur Protokoll): Lauf text | erfolgreich, mit den vorgegebenen Werkzeugaufrufen | success | erwartet |
| Durchgang 1 (nur Protokoll): Lauf werkzeuge | erfolgreich, mit den vorgegebenen Werkzeugaufrufen | success | erwartet |
| Durchgang 1 (nur Protokoll): Lauf mcp | erfolgreich, mit den vorgegebenen Werkzeugaufrufen | success, MCP: attrappe=connected | erwartet |
| Durchgang 2 (Allowlist): Lauf text | erfolgreich, mit den vorgegebenen Werkzeugaufrufen | success | erwartet |
| Durchgang 2 (Allowlist): Lauf werkzeuge | erfolgreich, mit den vorgegebenen Werkzeugaufrufen | success | erwartet |
| Durchgang 2 (Allowlist): Lauf mcp | erfolgreich, mit den vorgegebenen Werkzeugaufrufen | success, MCP: attrappe=connected | erwartet |
| Hosts in Durchgang 1 | nur Anthropic | api.anthropic.com | info |
| Durchgang 2: vom Proxy blockierte Anfragen der Läufe | keine | POST api.anthropic.com/v1/messages (fremd); POST api.anthropic.com/v1/messages (fremd); POST api.anthropic.com/v1/messages (fremd); GET api.anthropic.com/v1/files (unser); POST api.anthropic.com.invalid/v1/messages (unser); CONNECT example.com (keins) | info |
| Blockiert: fremder API-Key (x-api-key) auf /v1/messages | vom Proxy blockiert | blockiert (403, curl Exit 0) | erwartet |
| Blockiert: fremdes Bearer-Token auf /v1/messages | vom Proxy blockiert | blockiert (403, curl Exit 0) | erwartet |
| Blockiert: unser Token plus fremder x-api-key auf /v1/messages | vom Proxy blockiert | blockiert (403, curl Exit 0) | erwartet |
| Blockiert: unser Token auf der Files-API (/v1/files) | vom Proxy blockiert | blockiert (403, curl Exit 0) | erwartet |
| Blockiert: unser Token an fremden Host mit Host-Header api.anthropic.com | vom Proxy blockiert | blockiert (403, curl Exit 0) | erwartet |
| Blockiert: fremder Host (example.com) | vom Proxy blockiert | blockiert (CONNECT 403, curl Exit 56) | erwartet |

### Endpunkte in Durchgang 1

| Methode | Host | Pfad | Anmeldung | Entscheidung | Anzahl |
|---|---|---|---|---|---|
| GET | api.anthropic.com | /api/claude_code/policy_limits | unser | weitergeleitet | 3 |
| GET | api.anthropic.com | /api/claude_code/settings | unser | weitergeleitet | 3 |
| POST | api.anthropic.com | /v1/messages | unser | weitergeleitet | 7 |

### Anfragen in Durchgang 2

| Methode | Host | Pfad | Anmeldung | Entscheidung | Anzahl |
|---|---|---|---|---|---|
| CONNECT | example.com |  | keins | blockiert-connect | 1 |
| GET | api.anthropic.com | /api/claude_code/policy_limits | unser | erlaubt | 3 |
| GET | api.anthropic.com | /api/claude_code/settings | unser | erlaubt | 3 |
| GET | api.anthropic.com | /v1/files | unser | blockiert | 1 |
| POST | api.anthropic.com.invalid | /v1/messages | unser | blockiert | 1 |
| POST | api.anthropic.com | /v1/messages | unser | erlaubt | 7 |
| POST | api.anthropic.com | /v1/messages | fremd | blockiert | 3 |

### Allowlist (aus Durchgang 1 erzeugt)

```json
{
  "eintraege": [
    {
      "methode": "GET",
      "host": "api.anthropic.com",
      "pfad": "/api/claude_code/policy_limits",
      "auth": [
        "unser"
      ],
      "anzahl": 3
    },
    {
      "methode": "GET",
      "host": "api.anthropic.com",
      "pfad": "/api/claude_code/settings",
      "auth": [
        "unser"
      ],
      "anzahl": 3
    },
    {
      "methode": "POST",
      "host": "api.anthropic.com",
      "pfad": "/v1/messages",
      "auth": [
        "unser"
      ],
      "anzahl": 7
    }
  ]
}
```

### Folge laut Plan

Go: Die Läufe funktionieren mit Allowlist, fremde Schlüssel werden blockiert. No-Go: Kanal als
Restrisiko unter R6 entscheiden (plan.md 5.7).
