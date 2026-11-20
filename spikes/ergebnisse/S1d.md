# Ergebnis S1d – Rate-Limit für Polling

Lauf unter Windows am 20.11.2026 mit `spikes/s1-github` (`pnpm s1d`) gegen das Test-Repo
`Steuten-IT-Solutions/aio-spike-s1`, zwei Läufe (gegen 18:08 und 18:18 UTC). Der zweite Lauf
nutzt die geänderte Messung aus diesem PR. Der Bericht des zweiten Laufs steht unten. Korrigiert ist nur die Kodierung der Umlaute aus der PowerShell-Ausgabe.

## Einordnung

**Ergebnis: Go, wenn das Polling bedingte Anfragen mit ETag nutzt.**

- Das Limit der Installation ist 5.000 Anfragen pro Stunde, der Mindestwert laut
  [GitHub-Doku](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- Ein Poll-Zyklus kostet genau 1 + 2 Anfragen je offenem PR (gemessen: 5 bei 2 PRs, Mittel aus
  3 Zyklen).
- 10 bedingte Anfragen mit `If-None-Match` liefern HTTP 304 und erhöhen den Zähler nicht. Das
  deckt sich mit der [GitHub-Doku](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api):
  „Making a conditional request does not count against your primary rate limit if a `304`
  response is returned and the request was made while correctly authorized with an
  `Authorization` header.“
- Ohne ETag kosten 10 offene PRs bei 60 s Intervall 25,2 % des Limits, also mehr als die Grenze
  von 20 %. Mit ETag kosten nur Abfragen, deren Daten sich geändert haben. Im ungünstigsten Fall,
  wenn sich in jedem Zyklus alles ändert, bleibt es bei 25,2 %.

**Vorschlag:** In plan.md Kap. 5.9 („Polling, kein Webhook“) die [Annahme] ersetzen durch:
Polling mit bedingten Anfragen (`If-None-Match`), Intervall 60 s. Steigt der Verbrauch über 20 %
des Limits (Header `x-ratelimit-used`), verlängert der Adapter das Intervall, z. B. auf 90 s
(16,8 % ohne ETag).

## Erster Lauf (verworfen)

Der erste Lauf verglich Einzelwerte aus dem Header `x-ratelimit-used` direkt nach dem Anlegen der
Test-PRs. Ergebnis: Poll-Zyklus 15 statt 5 Anfragen, und über eine einzige 304-Anfrage stieg der
Zähler um 13, obwohl dazwischen laut Doku nichts zählte (`GET /rate_limit` zählt laut
[Doku](https://docs.github.com/en/rest/rate-limit/rate-limit) ebenfalls nicht). Die Werte waren
also nicht dem Skript zuzuordnen. Vermutlich bucht GitHub die vorangegangenen schreibenden
Anfragen verzögert **[Annahme: in der Doku nicht beschrieben]**. Das Skript misst seitdem über
`GET /rate_limit`, erst wenn der Zähler still steht, und prüft die Messung mit einer Ruhemessung
(+0 in 15 s) und einer Kontrolle (10 normale Anfragen = +10). Beides hat im zweiten Lauf gestimmt.

Konsolenausgabe des ersten Laufs:

```text
[erwartet] Limit der Installation: 5000/h
[ABWEICHUNG] Kosten eines Poll-Zyklus mit 2 offenen PRs: 15 Anfragen
[erwartet] Bedingte Anfrage (If-None-Match): HTTP 304, Zähler danach +13
[info] Zählt eine 304-Antwort gegen das Limit?: ja (+13)
[ABWEICHUNG] Hochrechnung: 10 offene PRs, Intervall 60 s, ohne ETag: 25.2 %
[info] Aufräumen: 2 PRs, 2 Branches
```

## Bericht des Skripts (zweiter Lauf)

### S1d – Rate-Limit für Polling

Zeitpunkt: 2026-11-20T18:18:55.383Z
Gesamtergebnis: Go (alle Prüfungen wie erwartet)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Limit der Installation | ≥ 5.000/h | 5000/h | erwartet |
| Ruhemessung: 15 s ohne Anfragen | +0 | +0 | erwartet |
| Kontrolle: 10 normale GET-Anfragen | +10 | +10 | erwartet |
| Kosten eines Poll-Zyklus mit 2 offenen PRs (Mittel aus 3) | 5 Anfragen (1 + 2 je PR) | 5 Anfragen | erwartet |
| Bedingte Anfragen (If-None-Match), 10 Stück | alle HTTP 304 | HTTP 304 | erwartet |
| Zählen 304-Antworten gegen das Limit? | messen (Doku: nein) | nein (+0) | info |
| Hochrechnung: 10 offene PRs, Intervall 60 s, ohne ETag | < 20 % des Limits, oder 304-Antworten zählen nicht | 25.2 % (mit ETag fallen unveränderte Abfragen weg) | erwartet |
| Aufräumen | PRs geschlossen, Branches gelöscht | 2 PRs, 2 Branches | info |
