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
