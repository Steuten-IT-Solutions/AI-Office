# Ergebnis S1c – Workflow-Dateien ohne Berechtigung „Workflows“

Lauf unter Windows am 20.11.2026 mit `spikes/s1-github` (`pnpm s1c`, Node 24.15.0, Git 2.52.0)
gegen das Test-Repo `Steuten-IT-Solutions/aio-spike-s1`. Die App `aio-supervisor` hat die
Berechtigung „Workflows“ nicht (No access, E30). Der Bericht des Skripts steht unten. Korrigiert ist nur die Kodierung der Umlaute aus der PowerShell-Ausgabe.

## Einordnung

**Ergebnis: Go.** Die Annahme zu Plan-Fakt 17 ist damit im Test bestätigt.

- GitHub lehnt mit dem Installations-Token jede Änderung unter `.github/workflows/` ab: neue Datei
  per `git push` („refusing to allow a GitHub App to create or update workflow … without
  `workflows` permission“), neue, geänderte und gelöschte Datei per Contents-API (HTTP 403) und
  ein neuer Tree per Git-Data-API (HTTP 403).
- Die Kontrolle zeigt, dass das Token sonst schreiben darf: Branch per API und normale Datei per
  `git push` gehen.
- Der Pfadfilter im Git-Gate, den etappe-0.md als Ausweichweg nennt, ist damit nicht nötig.
- **Vorschlag:** In plan.md Fakt 17 die [Annahme] durch einen Verweis auf dieses
  Ergebnis ersetzen.

## Bericht des Skripts

### S1c – Workflow-Dateien ohne Berechtigung „Workflows“

Zeitpunkt: 2026-11-20T18:06:42.421Z
Gesamtergebnis: Go (alle Prüfungen wie erwartet)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Kontrolle: Branch per API anlegen | erlaubt (201) | HTTP 201 | erwartet |
| Kontrolle: normale Datei per git push | erlaubt | erlaubt | erwartet |
| Neue Workflow-Datei per git push | abgelehnt | abgelehnt: ! [remote rejected] spike/s1c-1795197993598 -> spike/s1c-1795197993598 (refusing to allow a GitHub App to create or update workflow `.github/workflows/s1c-git.yml` without `workflows` permission) | erwartet |
| Neue Workflow-Datei per Contents-API | abgelehnt (4xx) | HTTP 403 Resource not accessible by integration | erwartet |
| Bestehende Workflow-Datei per Contents-API ändern | abgelehnt (4xx) | HTTP 403 Resource not accessible by integration | erwartet |
| Bestehende Workflow-Datei per Contents-API löschen | abgelehnt (4xx) | HTTP 403 Resource not accessible by integration | erwartet |
| Neue Workflow-Datei per Git-Data-API (Tree, Commit, Ref) | spätestens beim Ref abgelehnt | Tree: HTTP 403 Resource not accessible by integration | erwartet |
| Aufräumen: Test-Branch löschen | 204 | HTTP 204 | info |
