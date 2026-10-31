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
| `books/*.md` | Startbücher (P11): Firmenhandbuch, Git-Workflow, Kostenregeln, Office-API (Kap. 5.3). Die Verfassung liegt im Supervisor-Repo (Kap. 4.1). |
| `personas/*.md` | Persona-Texte der Startagenten für den System-Prompt (P11, Kap. 5.1 und 5.12) |

Bücher und Personas haben einen Kopf zwischen zwei Zeilen `---` mit je einer Angabe `schlüssel: wert`.
Bücher: `titel`, `quelle`, `datum`, `besitzer`, `vertrauensstufe` (Kap. 5.3). Personas: `agent`,
`datum`. Startbücher sind `intern`.

Wer die Office-API (P08) oder die Regeln in `plan.md` ändert, muss die betroffenen Bücher mit
anpassen. Die Bücher sind das, was die Agenten über das Büro wissen.

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

## Annahmen aus P11, noch nicht bestätigt

- **Persona-Texte (P11):** Die Sätze zu Vergangenheit, Einstellung, Verhaltensregeln und Begrenzung
  der Schwäche stammen aus Kap. 5.12. Die übrigen Sätze habe ich aus dem Gemüt abgeleitet, z. B.
  niedrige Extraversion → „schreibt wenig“. Sie sind meine Formulierung und noch nicht bestätigt.
- **Token-Grenzen (P11):** Personas höchstens 300 Tokens (Kap. 5.1). Das Startbuch
  „Firmenhandbuch“ höchstens 600 der 2.000 Tokens des generierten Handbuchs. Gezählt wird mit
  einer vorsichtigen Schätzung von 3 Zeichen je Token, nicht mit dem echten Tokenizer.
