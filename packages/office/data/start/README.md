# Startdaten

Versionierte Daten für den Startzustand der Firma (P05). Sie werden beim ersten Start als
Ereignisse `agent.hired` ins Ereignisprotokoll geschrieben (`seedStartAgents`). Danach ist das
Ereignisprotokoll maßgeblich; eine Änderung an diesen Dateien wirkt nur auf eine neue, leere
Datenbank. Profiländerungen im Betrieb laufen über `agent.profile_changed`.

Es sind fiktive Personen (plan.md Kap. 5.12). Laufzeitdaten gehören nicht hierher (E18).

| Datei | Quelle |
|---|---|
| `agents/*.json` | plan.md Kap. 5.12, Tabelle der Startbelegschaft (Werte wörtlich übernommen) |
| `building.json` | plan.md Kap. 5.6, „Startzustand“: 1 Etage, Eingang, Eingangsbereich, je ein Büro für CEO, COO, CTO, CFO und CHRO |

Die Persona-Texte für den Prompt und die Startbücher gehören zu P11.

## Festlegungen ohne Grundlage im Plan

Diese Werte stehen nicht im Plan. Der CEO hat sie am 31.10.2026 im Review von P05 bestätigt:

- **Vorgesetzter** aller vier Startagenten ist der CEO (`supervisorId: "ceo"`). Der Plan nennt
  das Feld (Kap. 5.1), aber keine Berichtslinie der Startbelegschaft.
- **Arbeitsplätze:** 1 je Agentenbüro, 0 im Büro des CEO, im Eingang und im Eingangsbereich.
  Der CEO arbeitet nicht in Läufen. Die Grenze aus der Statik setzt ohnehin der Supervisor.
- **Ausstattung der Räume** = Ausstattung des Agenten, der dort sitzt (Kap. 5.12). Das Büro des
  CEO hat keine Ausstattung.
- **IDs** (`jonas-albrecht`, `buero-cto`, …), `avatarSeed` gleich der ID, Gebäudename.
- Das Feld **Budget** aus Kap. 5.1 ist noch nicht modelliert, weil der Plan es nicht festlegt
  (Weckbudget liegt im Supervisor, Abteilungsbudgets kommen in Etappe 3).
