# Aufgezeichnete Läufe für den Fake-Runner

Diese Dateien ersetzen in Tests jeden echten `claude -p`-Lauf (E23). Sie sind ein **kritischer
Pfad** (plan.md Kap. 4.5 Nr. 3): Eine Änderung hier ändert, was die Tests für einen gültigen Lauf
halten.

**Stand:** Die Dateien sind **synthetisch**. Ich habe sie von Hand nach den Nachrichtentypen der
[Agent-SDK-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript) geschrieben. Sie werden
durch echte, um Inhalte bereinigte Aufzeichnungen aus Spike S2 ersetzt, sobald die gepinnte
CLI-Version feststeht. Erst dann ist belegt, dass der Parser das tatsächliche Format liest.

| Datei | Fall |
|---|---|
| `buero-erfolg` | Lauf ohne Werkzeuge, Erfolg |
| `werkbank-werkzeug` | Werkzeugaufruf mit Ergebnis, eine Nachricht eines Subagenten (muss ignoriert werden), zwei Modelle |
| `budget-ueberschritten` | Warnung zum Kontingent, API-Wiederholung, Abbruch mit `error_max_budget_usd` |
| `abgestuerzt` | Strom endet ohne Ergebnisnachricht, letzte Zeile unvollständig |
