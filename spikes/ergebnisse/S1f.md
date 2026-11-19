# Ergebnis S1f – Einstellungen und MCP-Server aus dem Arbeitsbereich

Lauf in der VM `aio-dev` am 19.11.2026 mit `spikes/vm/s1f.sh` und `AIO_SANDBOX=ohne` (die
Bash-Sandbox startet im Container nicht, siehe S1a). Ubuntu 26.04.1, Docker 29.9.3, CLI 2.1.312.
Der Bericht des Skripts steht unverändert unten.

## Einordnung

**Ergebnis: für Hooks und MCP Go, formal „ungültig“ wegen eines Kontrollkanals.**

- Ohne die Flags aus plan.md 5.7 lädt `claude -p` aus dem Arbeitsbereich alle vier Hooks und
  startet den fremden MCP-Server aus `.mcp.json`; er steht auch in `system/init`. Das Risiko
  besteht also wirklich.
- Mit den Flags aus 5.7 (`--setting-sources user`, `--settings` mit `disableAllHooks`) wird
  nichts davon geladen. Das gilt auch mit zusätzlichem `--strict-mcp-config` und schon mit
  `--setting-sources user` allein.
- Der Skript-Bericht nennt die Kontrolle ungültig, weil die Bash-Freigabe aus
  `.claude/settings.json` (`Bash(touch MARKER-bash)`) auch ohne Flags nicht wirkte: Der Aufruf
  steht in `permission_denials`, im Modus `dontAsk` mit `--allowedTools Read`. Ob das CLI
  Freigaben aus dem Arbeitsbereich in diesem Modus grundsätzlich nicht übernimmt oder
  `--allowedTools` sie ersetzt, ist offen **[Annahme]**. Für die Frage von S1f ist das günstig,
  denn eine Freigabe aus dem Arbeitsbereich gilt ohnehin nicht.

**Vorschlag:** Die Bash-Freigabe in der Kontrolle von S1f nur als Information werten. Dann ist
S1f Go und plan.md 5.7 bleibt unverändert.

## Bericht des Skripts

Zeitpunkt: 2026-11-19T21:24:36.493Z
Image: aio-spike-lauf:ohne (sha256:a24d8711ac98)
CLI: 2.1.312 (Claude Code)
Docker: 29.9.3, Kernel: 7.0.0-43-generic
Gesamtergebnis: Ungültig (eine Kontrolle ist fehlgeschlagen, Messung wiederholen)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Kontrolle: ohne --setting-sources und --settings (Kontrolle: muss alles laden) | Hooks, Bash-Freigabe und MCP wirken | geladen (Hooks: SessionStart, UserPromptSubmit, PreToolUse, Stop; Bash-Freigabe genutzt: nein; fremder MCP gestartet: ja, in system/init: ja); nicht gezeigt: Bash-Freigabe | ungültig |
| Flags aus plan.md 5.7 (--setting-sources user, --settings mit disableAllHooks) | keine Markerdatei, kein fremder MCP-Server | nichts geladen (Hooks: keine; Bash-Freigabe genutzt: nein; fremder MCP gestartet: nein, in system/init: nein) | erwartet |
| wie plan, zusätzlich --strict-mcp-config (Information für die Folge bei No-Go) | keine Markerdatei, kein fremder MCP-Server | nichts geladen (Hooks: keine; Bash-Freigabe genutzt: nein; fremder MCP gestartet: nein, in system/init: nein) | info |
| nur --setting-sources user, ohne disableAllHooks (Information) | keine Markerdatei, kein fremder MCP-Server | nichts geladen (Hooks: keine; Bash-Freigabe genutzt: nein; fremder MCP gestartet: nein, in system/init: nein) | info |

### Beobachtungen je Variante

| Variante | Hooks | Bash-Freigabe | MCP gestartet | MCP in init | CLAUDE.md befolgt | Ergebnis |
|---|---|---|---|---|---|---|
| kontrolle | SessionStart, UserPromptSubmit, PreToolUse, Stop | nein | ja | ja | nein | success |
| plan | keine | nein | nein | nein | nein | success |
| plan-strikt | keine | nein | nein | nein | nein | success |
| nur-quellen | keine | nein | nein | nein | nein | success |

### Hinweis zu CLAUDE.md

Ob CLAUDE.md aus dem Arbeitsbereich geladen wird, ist hier nur Information: Die Spalte zeigt, ob
die Antwort mit ZITRONE beginnt. Das Modell kann die Anweisung auch ignorieren.

### Folge laut Plan

No-Go: zusätzliche Flags (z. B. --strict-mcp-config) oder Dateien vor dem Lauf entfernen;
Plan anpassen (plan.md 5.7). Die Variante plan-strikt zeigt, ob --strict-mcp-config reicht.
