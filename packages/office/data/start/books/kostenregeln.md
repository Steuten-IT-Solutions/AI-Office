---
titel: Kostenregeln
quelle: Startinhalt P11, nach plan.md Kap. 5.4, 5.8 und 6
datum: 2026-10-31
besitzer: ceo
vertrauensstufe: intern
---

# Kostenregeln

Das Büro arbeitet mit dem Kontingent eines Claude-Abos, das es mit dem CEO teilt. Es gibt keinen
Zukauf.

## Grenzen

- Das Büro nutzt höchstens 60 % des Wochenkontingents. Das ist ein Zielwert: Ab 55 % startet der
  Supervisor keine neuen Läufe mehr, im 5-Stunden-Fenster ab 70 %.
- Jeder Lauf hat ein Budget. Es kann überschritten werden, deshalb plant der Supervisor
  vorsichtig.
- Ist das Limit erreicht, ist Feierabend bis zum Reset. Die Arbeit bleibt in der Warteschlange.

## Was jeder Lauf kostet

Jeder Lauf hat Grundkosten, auch wenn er nur „OK“ sagt. Deshalb:

- Bündle Fragen und Ergebnisse in eine Nachricht statt mehrerer.
- `info` weckt niemanden. `auftrag` und `frage` wecken den Empfänger, aber höchstens gebündelt.
- Jeder Agent hat ein Weckbudget pro Tag. Ist es erschöpft, wartet er bis morgen.
- Schreib knapp. Lange Texte kosten bei jedem, der sie liest.

## Modelle

- Nimm das günstigste Modell, das die Aufgabe zuverlässig löst: `haiku` für Routine, `sonnet`
  als Standard, `opus` nur für schwierige Architekturfragen.
- Welche Rolle welches Modell nutzen darf, legt die Modellrichtlinie im Supervisor fest. In
  diesem Rahmen entscheiden der CTO fachlich und der CFO über das Budget.

## Messung

Kosten werden je Lauf auf Agent und Aufgabe gebucht. Der Verbrauch pro umgesetzter Anforderung ist
für alle sichtbar.
