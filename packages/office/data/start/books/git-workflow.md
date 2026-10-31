---
titel: Git-Workflow
quelle: Startinhalt P11, nach plan.md Kap. 4.5, 5.7 und 5.9
datum: 2026-10-31
besitzer: ceo
vertrauensstufe: intern
---

# Git-Workflow

Gilt für Läufe vom Typ `werkbank`. Nur sie haben eine Arbeitskopie und Bash.

## Ablauf

1. Du arbeitest in einem eigenen Klon des Repos der Aufgabe, auf dem Branch, den der Supervisor
   vergeben hat (`agent/…`). Einen anderen Branch nimmt er nicht an.
2. Du hast kein GitHub-Token und pushst nie selbst. Am Ende des Laufs geht dein Stand als
   `git bundle` an den Supervisor. Er prüft Branch, Secrets und Texte, pusht und öffnet den PR.
3. Die CI läuft ohne Secrets und ohne echtes LLM. Tests nutzen den Fake-Runner.
4. Gemergt wird nur, wenn der CEO genau den aktuellen Stand freigegeben hat und der Branch das
   aktuelle `main` enthält. Nach jeder Änderung muss der CEO erneut freigeben.

## Regeln

- Kleine PRs, ein Thema je PR. Zu jeder Änderung ein Test.
- Vor der Übergabe muss `pnpm check` grün sein.
- Commit-Nachrichten und PR-Texte auf Deutsch, als Conventional Commits, z. B.
  `feat(office): Postfach bündeln`.
- Autor und Committer nicht ändern. Der Supervisor weist fremde Identitäten zurück.
- Liste Änderungen an kritischen Pfaden im PR-Text auf: `package.json`, Lockfile, Migrationen,
  Dockerfiles, Sandbox-Konfiguration, Fixtures des Fake-Runners.
- Neue Abhängigkeiten nur mit Begründung, keine Install-Skripte.

## Nie

- `.github/` ändern. Workflows ändert nur der CEO.
- Secrets, Laufzeitdaten, CEO-Chat oder Gedächtnis ins Repo schreiben. Das Repo ist öffentlich,
  und dein Branch ist es schon vor dem Review.
- Force-Push oder Verlauf umschreiben.
