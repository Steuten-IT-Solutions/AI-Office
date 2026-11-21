# Lauf-Image (P12)

Image und Startprozess für die Agenten-Läufe. Grundlage: [`plan.md`](../../docs/plan.md) Kap. 4.7
und 5.7, E27, E28, E42; Paket P12 in [`etappe-0.md`](../../docs/etappe-0.md) Kap. 4.1. Den
Container startet nur der Supervisor (E25, Paket S05). Dieses Paket legt fest, **was im Image
steckt** und **wie ein Lauf darin endet**.

**Kritischer Pfad** (plan.md Kap. 4.5 Nr. 3): `image/Dockerfile` und der Startprozess unter
`src/`.

## Inhalt des Images

| Teil | Festlegung | Quelle |
|---|---|---|
| Basis | `node:24.22.1-trixie-slim` mit Digest, wie in den Spikes | `spikes/vm/image/Dockerfile` |
| CLI | Claude Code 2.1.312 als natives Binary, SHA-256 des Tarballs fest eingetragen, ohne Install-Skript | R9, Spikes S1a–S1g liefen mit dieser Version |
| Auto-Updater | aus über `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (laut [Doku](https://code.claude.com/docs/en/env-vars) „auto-updates, telemetry, error reporting …“); zusätzlich kann das Binary im schreibgeschützten Root-Dateisystem nichts ersetzen | plan.md Kap. 5.10 |
| Hintergrundaufgaben | aus über `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | E32 |
| Bash-Sandbox | **aus**; sie startet im gehärteten Container nicht, der CEO hat R5 am 19.11.2026 akzeptiert | `spikes/ergebnisse/S1a.md` |
| Managed Settings | **nicht im Image**; nur der leere Einhängepunkt `/etc/claude-code` (siehe unten) | E50, plan.md Kap. 5.7 |
| pnpm | 10.34.8 über Corepack im Image abgelegt, lädt im Lauf nichts nach | `package.json` (`packageManager`), E29 |
| Werkzeuge | `git`, `ripgrep`, `tini`; kein `curl`, kein `bubblewrap` | – |
| Nutzer | `agent`, UID/GID 10001 | wie in den Spikes |

Bewusst **nicht** im Image: Token, CA des Proxys, MCP-Konfiguration, CLI-Aufruf und Managed
Settings. Das alles setzt der Supervisor je Lauf (S05, S06).

### Managed Settings (E50)

Die Datei liegt im Supervisor-Repo, das die Agenten nicht ändern können. Der Container-Manager
(S05) bindet das **ganze Verzeichnis** `/etc/claude-code` schreibgeschützt ein, nicht nur die
Datei: Laut [Doku](https://code.claude.com/docs/en/managed-settings) führt das CLI
`managed-settings.json` mit jeder `*.json` aus `managed-settings.d/` zusammen. Die Einbindung des
Verzeichnisses verdeckt alles, was ein Image dort ablegt.

Der Startprozess prüft vor dem Start des CLI, dass `/etc/claude-code/managed-settings.json` lesbar
ist und ein nicht leeres JSON-Objekt enthält (`src/richtlinie.ts`), sonst Exit 125. Grund: Darf
das Betriebssystem die Datei nicht lesen, startet das CLI laut Doku „without that source's
policies“ und meldet das bei `-p` nur auf stderr. Den Inhalt prüft der Startprozess nicht, ihn legt
allein der Supervisor fest.

Das Image bleibt trotzdem ein kritischer Pfad: Ein PR auf das Image könnte etwa das CLI oder den
Startprozess austauschen.

## Startprozess

`tini` ist PID 1 und startet `node /opt/aio-lauf/start.ts <CLI-Aufruf>`. Node 24 führt die
TypeScript-Dateien direkt aus (Type Stripping), so wie in den Spikes.

1. Konfiguration (unten) und Managed Settings (oben) prüfen. Ist etwas ungültig, startet nichts
   (Exit 125).
2. CLI in eigener Prozessgruppe starten; stdin, stdout (`stream-json`) und stderr gehen
   unverändert durch.
3. **Harte Lease (E42):** Nach `AIO_LEASE_SEKUNDEN` bekommt das CLI SIGINT, nach je
   `AIO_STOPP_STUFE_SEKUNDEN` SIGTERM und zuletzt die ganze Prozessgruppe SIGKILL. Dieselbe
   Kaskade läuft bei `docker stop` (SIGTERM an `tini`, weiter an den Startprozess). Die Lease greift
   auch, wenn der Supervisor nicht mehr läuft.
4. Nach dem Ende des CLI erhält dessen Prozessgruppe SIGKILL, damit kein Hintergrundprozess die
   Arbeitskopie noch ändert.
5. **Bundle (E28):** Bei Werkbank-Läufen `git bundle create` nur für den vergebenen Ref, mit
   `AIO_BUNDLE_BASIS` als Voraussetzung (nur neue Commits). Hooks und System-/Nutzerkonfiguration
   von Git sind dabei aus. Auch nach Ablauf der Lease, mit eigener Zeitgrenze.
6. `ergebnis.json` schreiben und mit dem Exit-Code des CLI enden; nach Ablauf der Lease 124.

Ein Agent mit Bash läuft unter derselben UID und kann den Startprozess beenden. Das verkürzt den
Lauf nur: Endet der Startprozess, endet `tini` und damit der Container. Bundle und Ergebnisdatei
sind für den Supervisor **nicht vertrauenswürdig**; geprüft wird im Git-Gate (S08).

### Umgebungsvariablen (setzt S05)

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `AIO_LAUF_ID` | ja | `[a-z0-9][a-z0-9-]{0,63}` |
| `AIO_LEASE_SEKUNDEN` | ja | 1 bis 21600 (6 h) |
| `AIO_STOPP_STUFE_SEKUNDEN` | nein (10) | Wartezeit je Stufe, höchstens 120 |
| `AIO_AUSGABE` | nein (`/aio/ausgabe`) | Verzeichnis für `ergebnis.json` und `lauf.bundle`; muss den Container überdauern |
| `AIO_ARBEITSKOPIE` | nur Werkbank | absoluter Pfad des Klons |
| `AIO_BUNDLE_REF` | mit Arbeitskopie | `refs/heads/agent/<id>` |
| `AIO_BUNDLE_BASIS` | nein | SHA von `main` beim Klonen |
| `AIO_BUNDLE_SEKUNDEN` | nein (120) | Zeitgrenze für das Bundle, höchstens 600 |

Variablen mit Präfix `AIO_` gibt der Startprozess nicht an das CLI weiter.

### `ergebnis.json`

```json
{
  "version": 1,
  "laufId": "r-7f3a9c",
  "lauf": { "beendet": "lease", "exitCode": null, "signal": "SIGINT", "stoppStufe": "SIGINT", "dauerMs": 1800012 },
  "bundle": { "status": "erstellt", "datei": "lauf.bundle", "bytes": 4711, "sha256": "…", "head": "…" },
  "fehler": null
}
```

`beendet`: `normal`, `lease` oder `stopp`. `bundle.status`: `nicht_verlangt`, `erstellt`,
`kein_branch`, `keine_aenderung` oder `fehler`.

## Bauen und prüfen

```bash
docker build -f packages/lauf/image/Dockerfile -t aio-lauf packages/lauf
docker run --rm --network none --cap-drop ALL --read-only \
  --mount type=bind,src=/pfad/zu/claude-code,dst=/etc/claude-code,readonly \
  --tmpfs /aio/ausgabe:uid=10001,gid=10001 \
  -e AIO_LAUF_ID=probe -e AIO_LEASE_SEKUNDEN=30 aio-lauf claude --version
```

`/pfad/zu/claude-code` ist ein Verzeichnis mit `managed-settings.json` (für `agent` lesbar). Ohne
die Einbindung endet der Container mit 125.

Der Kontext ist `packages/lauf`; `.dockerignore` lässt nur den Startprozess (ohne Tests) hinein. Das CLI braucht ein beschreibbares `/tmp` (sonst `EROFS` beim Start) und
ein beschreibbares `CLAUDE_CONFIG_DIR` (`/home/agent/.claude`), beide als `tmpfs` (plan.md
Kap. 4.7).

Die Tests (`src/*.test.ts`) nutzen eine Attrappe statt des CLI (E23).
