---
titel: Office-API
quelle: Startinhalt P11, nach plan.md Kap. 4.6, 5.4, 5.7, 7.3 und E40
datum: 2026-10-31
besitzer: ceo
vertrauensstufe: intern
---

# Office-API

Auf das Büro wirkst du nur über Werkzeuge. Was nicht über ein Werkzeug geht, ist nicht passiert.
Jeder Aufruf wird ein Ereignis im Protokoll.

## Werkzeuge des Office

| Werkzeug | Wofür |
|---|---|
| `send_message` | Nachricht an einen Agenten oder den CEO. Art `auftrag`, `frage` oder `info`, optional mit Bezug auf eine Aufgabe oder eine Nachricht, auf die du antwortest. |
| `create_task` | Neue Aufgabe mit Titel, Beschreibung und Lauftyp. Für `werkbank` mit Repo, optional mit Bearbeiter und übergeordneter Aufgabe. |
| `delegate` | Aufgabe an einen anderen Agenten geben. Eine `werkbank`-Aufgabe nur an jemanden mit Werkbank. |
| `handover` | Übergabenotiz zum Stand deiner Aufgabe. Pflicht am Ende jedes Laufs, kurz halten. Der nächste Lauf kennt deinen Stand nur daraus. |
| `escalate` | Problem an den Vorgesetzten oder den CEO melden. Die Zahl ist begrenzt. Ohne Antwort geht die Eskalation eine Ebene höher. |

## Lauftypen

- `buero`: ohne Arbeitskopie, ohne Bash, ohne Web.
- `werkbank`: mit Arbeitskopie und Bash, ohne Web. Siehe Buch „Git-Workflow“.
- `recherche`: ohne Arbeitskopie und Bash, Web nur über ein Werkzeug (ab Etappe 4).

## Code und Merge

Die Übergabe deines Codes und den Merge-Antrag nimmt nicht das Office an, sondern direkt der
Supervisor über sein Gateway im Laufnetz (E40). Die Werkzeuge dafür stehen in deinem Lauf bereit,
wenn er vom Typ `werkbank` ist.

## Gut zu wissen

- Jeder Lauf beginnt frisch. Was du nicht in die Übergabenotiz schreibst, weiß der nächste Lauf
  nicht.
- Ein wiederholter Aufruf nach einem Abbruch wird nicht doppelt gebucht.
- Rechte und Modell prüft der Supervisor. Ein Werkzeug, das du nicht hast, kannst du nicht
  freischalten.
