# Abnahme I01 – Testprotokoll und Bericht

> **Paket:** I01 aus [`etappe-0.md`](etappe-0.md) Kap. 4.1, Abnahmekriterien aus
> [`plan.md`](plan.md) Kap. 7.4. **Umgebung:** VM `aio-dev` (Hyper-V auf der Entwicklungsmaschine
> des CEO, `etappe-0.md` Kap. 1.1). **Stand:** in Arbeit.
> **Konvention:** wie in `plan.md`. Was nicht gemessen wurde, steht als **[Annahme]** da.

## 1. Vorgehen

Jedes Paket hat seinen eigenen VM-Test schon bestanden. Die Abnahme prüft das Zusammenspiel am
laufenden System: Supervisor und Office in ihren Releases, mit echter Konfiguration, echtem
Kontingent und echtem GitHub.

- **Teil 1 (automatisch):** [`spikes/vm/i01.sh`](../spikes/vm/i01.sh) prüft AK 3, 4, 5, 7
  (Weckbudget im Supervisor), 8, 11 und 12 ohne Eingriff des CEO. Es läuft als systemd-Unit
  `aio-i01`, schreibt den Bericht nach `/opt/aio-spikes/berichte/I01-teil1.md` und stellt
  geänderte Konfiguration selbst wieder her. Läufe startet es nur mit dem Probe-Profil `coo`
  (haiku), Agenten des Office laufen dabei nicht.
- **Teil 2 (mit dem CEO):** AK 1 (Auftrag im Chat, Approve in GitHub), 2, 6, 7 (Zyklus und
  E-Mail), 9 (Anzeige im Browser) und 10 (Neustart von Windows).

Wo der Test einen Zustand nachstellt statt ihn herbeizuführen, steht das beim Kriterium.

## 2. Ausgangslage

| Punkt | Stand |
|---|---|
| Supervisor-Release | `b8985ec` (Baum gleich `main` `1a4865f`) |
| Office-Release vor dem Test | `f6761ff` |
| Benachrichtigung (E37, S14) | nicht konfiguriert, kein Mailanbieter |
| Merge-Gate (S09) | nicht konfiguriert (`mergeGate` fehlt) |
| Browserzugang des CEO | eingerichtet am 24.11.2026: hosts, Stamm-CA (Fingerabdruck `C3664B87…2A239606`, nur `.internal`), Firefox 160 mit Richtlinie aus `einrichtung.md` Teil 6 |

## 3. Ergebnisse je Kriterium

| AK | Kriterium (kurz) | Prüfung | Ergebnis |
|---|---|---|---|
| 1 | Kernkreislauf | Teil 2 | offen |
| 2 | Workflow-PR wird nicht gemergt | Teil 2 | offen |
| 3 | Rollback | Teil 1 | offen |
| 4 | Speicher voll | Teil 1 | offen |
| 5 | Notaus in drei Stufen, ≤ 10 s | Teil 1 | offen |
| 6 | Kontingent unter realer Last | Teil 2 | offen |
| 7 | Zyklus, Weckbudget, E-Mail | Teil 1 + 2 | offen |
| 8 | Negativ- und Sandbox-Tests | Teil 1 | offen |
| 9 | XSS nur als Text | Teil 2 | offen |
| 10 | Neustart ohne Eingriff | Teil 2 | offen |
| 11 | Zeitleiste mit Agent, Kosten, Zeit | Teil 1 | offen |
| 12 | Rücksicherung | Teil 1 | offen |

## 4. Funde

- **Firefox-Zugang:** `curl.exe` unter Windows (Schannel) lehnt die Zertifikate des Webinterface
  ohne `--ssl-no-revoke` mit `CRYPT_E_NO_REVOCATION_CHECK` ab, weil sie keine Sperrinformation
  (CRL, OCSP) enthalten. Mit `--ssl-no-revoke` antworten Webinterface (200) und Konsole (303).
  Ob Firefox das bemängelt, prüft Teil 2 **[Annahme: nein]**.
