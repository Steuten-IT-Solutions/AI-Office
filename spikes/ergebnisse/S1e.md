# Ergebnis S1e – Merge der App unter Branch-Schutz

Lauf unter Windows am 20.11.2026 mit `spikes/s1-github` (`pnpm s1e`) gegen das Test-Repo
`Steuten-IT-Solutions/aio-spike-s1`. Schutzregel auf `main` nach docs/einrichtung.md 3.4:
PR mit 1 Approve, veraltete Approves verwerfen, Review der Code Owners (`* @ChrisSteuten`),
Approve des letzten Pushs, „Restrict who can push“, kein Bypass. Der Bericht des Skripts steht unten. Korrigiert ist nur die Kodierung der Umlaute aus der PowerShell-Ausgabe.

## Einordnung

**Ergebnis: Go.** Die App kann nur mergen, wenn der CEO den aktuellen Head approvt hat.

- Ohne Approve: HTTP 405 („Waiting on code owner review from ChrisSteuten. You're not authorized
  to push to this branch.“).
- Nach einem neuen Commit ist das alte Approve ungültig: HTTP 405 („Pull Request is not
  mergeable“).
- Mit veraltetem SHA im Parameter `sha`: HTTP 409 („Head branch was modified“).
- Mit Approve auf dem aktuellen Head, aber ohne die App in „Restrict who can push to matching
  branches“: HTTP 405 („You're not authorized to push to this branch“).
- Mit der App in dieser Liste: gemergt.
- Nicht geprüft: ein direkter Push der App auf `main`, während sie in der Liste steht. Wegen
  „Require a pull request before merging“ ohne Bypass sollte GitHub ihn ablehnen **[Annahme: im
  Spike nicht gemessen]**.

**Vorschlag:** In etappe-0.md 1.4 die [Annahme] zu „Restrict who can push“ streichen, weil
geklärt: Die App muss in der Liste stehen. In einrichtung.md 5.3 die App fest eintragen statt
„nur, wenn der Bericht von S1e zeigt, dass sie dort stehen muss“.

## Bericht des Skripts

### S1e – Merge der App unter Branch-Schutz

Zeitpunkt: 2026-11-20T18:16:28.937Z
Gesamtergebnis: Go (alle Prüfungen wie erwartet)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Branch-Schutz auf main aktiv | ja (Einrichtung laut README) | ja | erwartet |
| Merge ohne Approve | abgelehnt | HTTP 405 Waiting on code owner review from ChrisSteuten. You're not authorized to push to this branch. Visit https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches for more infor | erwartet |
| Merge nach neuem Commit (Approve veraltet) | abgelehnt | HTTP 405 Pull Request is not mergeable | erwartet |
| Merge mit veraltetem SHA im Parameter `sha` | abgelehnt (409) | HTTP 409 Head branch was modified. Review and try the merge again. | erwartet |
| Merge mit Approve auf aktuellem SHA, App NICHT in „Restrict who can push“ | messen | abgelehnt: HTTP 405 You're not authorized to push to this branch. Visit https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches for more information. | info |
| Merge mit Approve auf aktuellem SHA, App in „Restrict who can push“ | gemergt | gemergt | erwartet |
