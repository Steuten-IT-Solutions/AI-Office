# Spike S1c–S1e: GitHub

Plan: [`docs/etappe-0.md`](../../docs/etappe-0.md), Abschnitt 3.1. Die Skripte geben nie ein Token
oder den privaten Schlüssel aus. Ergebnis ist je Skript ein Bericht `s1<x>-bericht.md` im aktuellen
Verzeichnis.

## Voraussetzungen (einmalig, durch den CEO)

1. Öffentliches Test-Repo `Steuten-IT-Solutions/aio-spike-s1` mit README anlegen (öffentlich, weil
   Branch-Schutz für private Repos im Free-Tarif fehlt).
2. Im Test-Repo per Web-Oberfläche zwei Dateien anlegen:
   - `.github/workflows/existing.yml` (für S1c):
     ```yaml
     name: existing
     on: workflow_dispatch
     jobs:
       noop:
         runs-on: ubuntu-24.04
         steps:
           - run: echo existing
     ```
   - `.github/CODEOWNERS` mit dem Inhalt `* @ChrisSteuten` (für S1e)
3. GitHub App (`docs/etappe-0.md` Abschnitt 1.2) vorübergehend auf dem Test-Repo installieren.
4. Für S1e zusätzlich Branch-Schutz auf `main` des Test-Repos wie in Abschnitt 1.4, aber **ohne**
   Status-Checks und zunächst **ohne** die App unter „Restrict who can push to matching branches“
   (nur Sie selbst eintragen).
5. Node.js 24 und pnpm wie im Haupt-README, im Repo-Wurzelverzeichnis `pnpm install --ignore-scripts`.

## Ausführen

Auf einem Rechner Ihrer Wahl (S1c–S1e brauchen nur GitHub, nicht die VM):

```sh
export AIO_APP_ID=<App-ID von der App-Seite>
export AIO_APP_KEY_FILE=<Pfad zur .pem-Datei>
# optional: AIO_OWNER (Standard Steuten-IT-Solutions), AIO_TEST_REPO (Standard aio-spike-s1)

cd spikes/s1-github
pnpm s1c   # Workflow-Dateien ohne Berechtigung „Workflows“
pnpm s1d   # Rate-Limit beim Polling
pnpm s1e   # Merge unter Branch-Schutz (interaktiv, fordert Sie zum Approve auf)
```

S1d legt kurzzeitig zwei PRs an und schließt sie danach wieder. S1e legt einen PR an und merged ihn
am Ende in das Test-Repo.

## Was die Skripte prüfen

| Skript | Go-Kriterium |
|---|---|
| S1c | Neue, geänderte oder gelöschte Workflow-Dateien werden auf allen Wegen abgelehnt (git push, Contents-API, Git-Data-API). Eine normale Datei lässt sich pushen (Kontrolle). |
| S1d | Ein Poll-Zyklus kostet höchstens 1 + 2 Anfragen je offenem PR. Hochrechnung für 10 PRs alle 60 s unter 20 % des Limits, **oder** 304-Antworten auf bedingte Anfragen zählen nicht (dann kosten nur geänderte Daten). |
| S1e | Merge ohne Approve, nach neuem Commit und mit veraltetem SHA abgelehnt; mit Approve auf dem aktuellen SHA möglich. Gemessen wird, ob die App dafür unter „Restrict who can push“ stehen muss. |

**Hinweis zu S1d:** Ohne ETag ergibt die Formel für 10 PRs alle 60 s 21 Anfragen pro Zyklus, also
1.260 pro Stunde. Das sind 25,2 % von 5.000. Das Ergebnis hängt deshalb davon ab, ob 304-Antworten zählen.
Falls ja, muss das Intervall länger werden (z. B. 90 s ergibt 16,8 %).

Nach dem Spike: Bericht(e) an mich, danach die App vom Test-Repo deinstallieren und das Repo löschen.
