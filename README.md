# AI-Office

AI Orchestration Office. Architektur und Vorgehen: [`docs/plan.md`](docs/plan.md).

## Entwicklung

Voraussetzungen: Node.js 24 (LTS, siehe `.nvmrc`) und pnpm in der Version aus `packageManager`
(`corepack enable` aktiviert sie).

```sh
pnpm install --ignore-scripts
pnpm check   # Typecheck, Lint, Format, Tests
```

Regeln für Abhängigkeiten (`pnpm-workspace.yaml`): Keine Install-Skripte, neue Versionen erst nach
7 Tagen. CI und Tests rufen nie ein echtes LLM auf (E23).

## Aufbau

Der Code liegt in zwei Paketen unter `packages/`:

- [`packages/office`](packages/office) (`@ai-office/office`): Das Büro selbst mit Domänenmodell, Ereignisprotokoll, Gateway samt Web-Oberfläche (`web/`), Office-API für die Agenten, Planer, Git-Verfolgung und Anbindung an den Supervisor.
- [`packages/lauf`](packages/lauf) (`@ai-office/lauf`): Image (`image/Dockerfile`) und Startprozess für die Agenten-Läufe, siehe [`packages/lauf/README.md`](packages/lauf/README.md).
