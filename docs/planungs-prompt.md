# Planungs-Prompt: AI-Office

> Diesen Prompt in eine neue Session geben. Ziel ist **kein Code**, sondern ein gemeinsam
> erarbeiteter, kritisch geprüfter Architektur- und Umsetzungsplan.

---

## 1. Deine Rolle und Arbeitsweise

Du bist mein Software-Architekt und kritischer Sparringspartner. Wir planen gemeinsam eine
Orchestrierungssoftware für KI-Agenten („AI-Office“). Arbeite so:

1. **Erst verstehen, dann planen.** Stelle mir Rückfragen, bevor du Annahmen triffst. Stelle sie
   gebündelt (max. 4 pro Runde), jeweils mit deiner Empfehlung und den Konsequenzen der Optionen.
2. **Kritisch sein.** Widersprich mir, wenn eine Anforderung unrealistisch, teuer, unsicher oder
   widersprüchlich ist. Benenne das klar und schlage Alternativen vor.
3. **Nur verifizierte Aussagen.** Fakten zu externen Diensten (Anthropic-Nutzungsbedingungen,
   Rate-Limits, GitHub-APIs, Bibliotheken) recherchierst du in aktuellen Primärquellen und gibst die
   Quelle an. Was du nicht verifizieren kannst, kennzeichnest du als Annahme.
4. **Schrittweise vorgehen** (siehe Abschnitt 5). Wir schließen jede Phase ab, bevor wir weitergehen.
5. **Reviewen bis keine Schwachstellen mehr bleiben.** Nach jedem Planentwurf führst du ein
   strukturiertes Review durch (Sicherheit, Kosten, Stabilität, Erweiterbarkeit, Betrieb,
   Fehlerfälle) und überarbeitest, bis du nichts Wesentliches mehr findest. Dokumentiere, was
   jede Review-Runde gefunden und geändert hat.

Ziel ist eine **saubere, stabile Basis, die sich selbst weiterentwickeln kann**.

---

## 2. Vision

Eine Software, die auf einem Linux-Server per Kommandozeile läuft und KI-Agenten an meinen
Software-Projekten arbeiten lässt. Die Agenten organisieren sich wie die Belegschaft einer Firma
in einem Bürogebäude. Ein grafisches Webinterface zeigt das Gebäude und lässt mich beobachten,
was die Agenten gerade tun. Die Software kann sowohl meine Projekte als auch **sich selbst** als
Projekt weiterentwickeln.

**Leitprinzip:** Die Agenten entwickeln sich frei und treffen selbst Entscheidungen.
**Optimierungsziel:** Anforderungen bestmöglich umsetzen bei gleichzeitig minimalen Kosten.

---

## 3. Anforderungen

### 3.1 Abbildung Firma ↔ GitHub
- Eine **GitHub-Organisation** entspricht einer **Firma**.
- Die **Repositories** der Organisation sind die **Produkte** der Firma.
- Liegt das Repository der Orchestrierungssoftware selbst in der Organisation, entwickeln die
  Agenten auch diese weiter.
- Offen: Wie wird eine neue Version **automatisch und sicher auf den Server ausgeliefert**?

### 3.2 Hierarchie und Startbelegschaft
- **Ich (Nutzer) = CEO.** Ich treffe strategische Entscheidungen und kann jederzeit Entscheidungen
  festlegen und kommunizieren, die für die Agenten verbindlich sind.
- Zu Beginn existieren genau **4 vordefinierte Agenten**: **CTO, CFO, COO, CHRO**.
  - Sie haben die für ihre Rolle am besten geeigneten Fähigkeiten und Persönlichkeiten.
  - Sie treffen die strategischen Entscheidungen ihres jeweiligen Bereichs.
- Alle weiteren Agenten werden über **Bewerbungsgespräche** eingestellt.
- Unternehmensstruktur und Organigramm sind **frei** und werden von den Agenten entwickelt.

### 3.3 Agenten
Jeder Agent hat:
- eine **Rolle** und **Spezialisierungen**,
- **persönliche Eigenschaften**: Gemüt, Einstellung, Vergangenheit, Ausbildung – diese beeinflussen
  Entscheidungen, Fähigkeiten und Wissen,
- ein **Modell** (welches LLM ihn antreibt), das ebenfalls seine Fähigkeiten beeinflusst.

### 3.4 Wirtschaft
- Die **Währung sind Tokens**.
- Kosten sollen minimiert werden; es braucht also Budgets und eine Kostenbuchhaltung (vermutlich
  Aufgabe des CFO).

### 3.5 Kundenanforderungen
- Meine Anforderungen werden als **Kundenanforderungen** ins System eingebracht.
- Wer sie entgegennimmt und bearbeitet, entscheiden die Agenten selbst.

### 3.6 Bürogebäude als Systemgrenze
- Startzustand: **1 Etage** mit Eingang, Eingangsbereich und je einem Büro für CEO, COO, CTO, CFO
  und CHRO, die an den Eingangsbereich angrenzen.
- Die Agenten können das Gebäude **vergrößern und verkleinern** (Räume, Etagen), wenn sie es für
  nötig halten. Räume haben unterschiedliche Größen und Ausstattung.
- Die Agenten dürfen **neue Regeln und Funktionalitäten** beschließen.
- Die Agenten **kommunizieren untereinander**; das Wie ist ihnen überlassen.

### 3.7 Wissen
- Jedes Büro hat ein **Bücherregal** mit Fachbüchern zum Bereich des Agenten; daraus kann er
  Wissen beziehen.
- Am Schreibtisch steht ein **Rechner mit Internetzugang**; der Agent kann recherchieren.
- Wichtiges, komplexes Wissen kann er **herunterladen und als Buch ins Regal stellen**.
- Erwartung: Langfristig richten die Agenten eine zentrale **Bibliothek** für alle ein.

### 3.8 Webinterface
- Zeigt das Bürogebäude; ich beobachte die aktuellen Tätigkeiten der Agenten.
- Agenten sind **Menschen**, deren Aussehen zufällig generiert ist, aber zu ihren Eigenschaften passt.
- Agenten **bewegen sich animiert** durch das Gebäude.
- Eigene Gedanken als **Gedankenblasen**, Gespräche als **Sprechblasen**.

### 3.9 Antrieb
- Die Agenten sollen über **mein Claude-Abo** laufen.
- **Zu klären (mit Quellen!):** Ist das mit einem normalen Claude-Abo (Pro/Max) erlaubt und
  technisch möglich – z. B. über Claude Code im Headless-Modus oder das Agent SDK? Welche
  Nutzungslimits gelten, und was ist die Alternative (API-Key, Kosten)?

---

## 4. Kritische Punkte, die du im Plan beantworten musst

Diese Punkte sind mir beim Formulieren selbst aufgefallen. Prüfe sie und ergänze eigene.

1. **Autonomie vs. Kontrolle:** Wo endet die Entscheidungsfreiheit der Agenten? Welche
   Entscheidungen brauchen meine Freigabe (z. B. Änderungen am eigenen Kern, Budgeterhöhungen,
   Löschen von Repositories, Merges in den Hauptzweig)? Gibt es eine unveränderliche „Verfassung“?
2. **Selbstmodifikation:** Wie verhindern wir, dass sich die Software durch eine fehlerhafte
   Eigenänderung selbst lahmlegt? (Tests, Staging, Health-Checks, automatischer Rollback,
   geschützter Kern, Notaus.)
3. **Auslieferung:** CI/CD-Pipeline vom GitHub-Repository auf den Server – inklusive Migrationen
   des persistenten Zustands.
4. **Tokens als Währung:** Ein Abo hat Nutzungslimits statt eines Token-Kontos. Wie messen und
   budgetieren wir Verbrauch realistisch? Was passiert, wenn das Limit erreicht ist?
5. **Kosten der Simulation:** Bewerbungsgespräche, Gespräche zwischen Agenten, Gedankenblasen und
   Gebäudeumbau kosten Tokens, ohne direkt Kundenanforderungen umzusetzen. Wie verhindern wir,
   dass die Simulation die eigentliche Arbeit auffrisst? Was davon ist echte Logik, was reine
   Visualisierung?
6. **Was bedeutet das Gebäude technisch?** Wofür stehen Räume, Etagen, Ausstattung real
   (z. B. Arbeitsbereiche, parallele Ausführung, Werkzeuge, Rechte)? Hat Ausbau reale Kosten?
7. **Persönlichkeit und Wissen:** Wie wirken Gemüt, Vergangenheit und Ausbildung tatsächlich
   (System-Prompt, Werkzeugrechte, Wissensquellen)? Was ist realistisch – ein Modell lernt
   dadurch nicht dauerhaft dazu.
8. **Gedächtnis und Zustand:** Wie behalten Agenten Wissen, Beziehungen und Arbeitsstand über
   Sitzungen hinweg? Wie wird das Bücherregal technisch umgesetzt (Dateien, Suche, RAG)?
9. **Modelle:** Nur Claude-Modelle oder auch andere Anbieter? Wer entscheidet, welches Modell ein
   Agent bekommt?
10. **Sicherheit:** Prompt-Injection aus dem Internet, Rechte der GitHub-Zugänge, Isolation der
    Agenten (Sandbox/Container), Geheimnisse, Zugriffsschutz für das Webinterface.
11. **Begrenzungen:** Maximale Anzahl Agenten, parallele Ausführung, Laufzeit, Schleifen- und
    Endloserkennung.
12. **Nachvollziehbarkeit:** Protokoll aller Entscheidungen, Kosten und Änderungen; wie greife ich
    als CEO ein, überstimme oder stoppe?
13. **Webinterface-Technik:** 2D-Draufsicht, isometrisch oder 3D? Echtzeitübertragung der Zustände?
    Wie entsteht das zufällige, aber passende Aussehen?
14. **Server und Betrieb:** Hardwareanforderungen, Installation, Updates, Backups.

---

## 5. Vorgehen

1. **Klärung:** Rückfragen zu Zielen, Rahmenbedingungen und den kritischen Punkten.
2. **Recherche:** Abo-/Lizenzfrage und technische Optionen mit Quellen klären.
3. **Grobarchitektur:** Komponenten, Datenflüsse, Zustandsmodell, Technologie-Stack mit Begründung.
4. **Governance-Modell:** Autonomiegrenzen, Freigaben, Budgets, Notaus, Selbstmodifikation.
5. **Detailplanung je Komponente:** Agenten-Laufzeit, Kommunikation, Wissen, Wirtschaft, Gebäude,
   GitHub-Anbindung, Deployment, Webinterface.
6. **MVP-Schnitt und Roadmap:** Was ist die kleinste lauffähige Version, die sich danach selbst
   weiterentwickeln kann? In welchen Etappen geht es weiter?
7. **Review-Schleifen** bis keine wesentlichen Schwachstellen mehr bleiben.

## 6. Ergebnis

Ein Planungsdokument im Repository (z. B. `docs/plan.md`) mit:
- Zusammenfassung der Entscheidungen und ihrer Begründungen,
- Architektur (inkl. Diagramm),
- Governance- und Sicherheitskonzept,
- Kosten- und Limitkonzept,
- MVP-Definition und Roadmap,
- Liste offener Punkte und Risiken,
- Protokoll der Review-Runden.

Starte mit Phase 1 und stelle mir deine ersten Fragen.
