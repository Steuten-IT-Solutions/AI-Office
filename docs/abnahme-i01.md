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
| Supervisor-Release | `b8985ec` (Baum gleich `main` `1a4865f`), ab 24.11. 18:35 `a8595d7` (Baum gleich `main` `171be46`, Supervisor-PR #27) |
| Office-Release vor dem Test | `f6761ff`, ab AK 3 `2d47bb7` (`main`) |
| Benachrichtigung (E37, S14) | nicht konfiguriert, kein Mailanbieter |
| Merge-Gate (S09) | nicht konfiguriert (`mergeGate` fehlt); für AK 1 am 24.11. eingeschaltet (`i01-ak1-vorbereiten.sh`), App `aio-supervisor` zusätzlich in der Push-Liste von `main`, Regel sonst Stufe 5.2 (Entscheidung des CEO) |
| Browserzugang des CEO | eingerichtet am 24.11.2026: hosts, Stamm-CA (Fingerabdruck `C3664B87…2A239606`, nur `.internal`), Firefox 160 mit Richtlinie aus `einrichtung.md` Teil 6 |

## 3. Ergebnisse je Kriterium

| AK | Kriterium (kurz) | Prüfung | Ergebnis |
|---|---|---|---|
| 1 | Kernkreislauf | Teil 2 | offen |
| 2 | Workflow-PR wird nicht gemergt | Teil 2 | offen |
| 3 | Rollback | Teil 1 | **bestanden** (24.11.) |
| 4 | Speicher voll | Teil 1 | **bestanden** (24.11.) |
| 5 | Notaus in drei Stufen, ≤ 10 s | Teil 1 | **bestanden** (24.11.) |
| 6 | Kontingent unter realer Last | Teil 2 | offen |
| 7 | Zyklus, Weckbudget, E-Mail | Teil 1 + 2 | Weckbudget bestanden, Zyklus und E-Mail offen |
| 8 | Negativ- und Sandbox-Tests | Teil 1 | **bestanden** (24.11.) |
| 9 | XSS nur als Text | Teil 2 | offen |
| 10 | Neustart ohne Eingriff | Teil 2 | **bestanden** (24.11.) |
| 11 | Zeitleiste mit Agent, Kosten, Zeit | Teil 1 | **bestanden** (24.11.) |
| 12 | Rücksicherung | Teil 1 | **bestanden** nach Fix (24.11.) |

### 3.1 Teil 1 (automatisch, 24.11.2026, 18:12–18:25 CET)

Bericht in der VM: `/opt/aio-spikes/berichte/I01-teil1.md`.

- **AK 8:** Health-Check mit allen Negativ- und Sandbox-Prüfungen: 95 von 95 in 61 s. Bei
  akzeptiertem R5 erscheinen die Hinweise `sandbox.a-umgebung` und `sandbox.b-umgebung` mit
  `token_sichtbar`, wie in Kap. 5.13 als Ausnahme beschrieben.
- **AK 5:** Probe-Lauf (`coo`, haiku). `pause` lehnt neue Anträge nach 0,2 s ab. `stopp` und
  `hart` beenden den laufenden Container jeweils nach 0,4 s. `hart` stoppt zusätzlich das Office
  nach 0,2 s; nach Aufheben des Notaus läuft es wieder. Alle Werte liegen unter dem Zielwert 10 s.
- **AK 7 (Weckbudget):** Mit `wakeBudgetPerDay = 1` lehnt der Supervisor den zweiten Lauf des
  Tages mit Regel `wake_budget` ab („2 von 1 Läufen heute“). Die E-Mail dazu fehlt noch (kein
  Mailanbieter), der Zyklus braucht Läufe der Agenten (Teil 2).
- **AK 4:** Nachgestellt über `admission.minFreeBytes` = freier Platz + 20 GiB. Der Antrag wird
  mit Regel `disk` abgelehnt, der Health-Check urteilt `umgebungsfehler`, eine Auslieferung
  endet als `umgebungsfehler` ohne Build und ohne Rollback; das Office bleibt unverändert.
- **AK 3:** Auslieferung von `2d47bb7`, in der Beobachtungszeit wird das Office mit SIGKILL
  beendet. Rollback nach 95 s auf das vorige Release, die Office-DB ist erhalten (Kopf seq 22 mit
  gleichem Hash), ein Revert-PR wird angelegt (AI-Office #48, danach geschlossen), Merges sind
  gesperrt. Nach Aufheben der Sperre wird `2d47bb7` erneut ausgeliefert, ohne Neubau.
- **AK 11:** 26 Ereignisse im Protokoll, keines ohne Akteur oder Zeitpunkt; jede Handlung aus
  einem Lauf hat Agent und Kosten (`spikes/vm/i01/zeitleiste.js`).
- **AK 12:** Erster Durchlauf **rot**, siehe Funde. Nach dem Fix (Supervisor-PR #27) grün:
  Sicherung und Rücksicherung, bis beide Dienste laufen 2,3 s, Köpfe von Audit- und Office-Kette
  stimmen mit der Sicherung überein, der alte Stand liegt beiseite, Health-Check `gesund`,
  `NRestarts = 0`.

### 3.2 Teil 2 (mit dem CEO)

- **Browserzugang (Voraussetzung AK 1, 9):** Firefox 160 auf dem Windows-Rechner, geprüft nach
  `einrichtung.md` 6.2 am 24.11.: `about:policies` zeigt `Preferences` aktiv
  (`media.peerconnection.enabled` = `false`, `locked`) und `Certificates.ImportEnterpriseRoots`;
  `about:config` zeigt `false` mit Schloss; `typeof RTCPeerConnection` ergibt `"undefined"`.
  Anmeldung am Webinterface mit dem CEO-Passwort gelingt, keine Zertifikatswarnung. Damit ist
  die **[Annahme]** aus E49 für diesen Firefox geprüft.
- **AK 1:** Der CEO bestellt am 24.11. um 19:09 im Chat beim CTO einen Abschnitt in der README.
  Der Supervisor lehnt den Lauf ab: „Kontingent: seven_day bei 24 %, Pause ab 23,6 %
  (Tages-Zielkurve)“. Das ist das Verhalten aus Kap. 6 (E12): Am dritten Tag der Kontingentwoche
  gilt 55 % × 3/7. Der Planer fragt alle 5 Minuten erneut an. Der CEO hat entschieden zu warten;
  die Kette läuft nach dem nächsten Tageswechsel der Kontingentwoche weiter. Ergebnis offen.
- **AK 10:** Zustand vor und nach dem Neustart mit `spikes/vm/i01-ak10-pruefen.sh` (ohne sudo).
  Hyper-V: `AutomaticStartAction = Start`, `AutomaticStartDelay = 0`,
  `AutomaticStopAction = ShutDown`, also ein echter Boot der VM auch beim Neustart von Windows.
  - Neustart der VM (`sudo reboot`, 19:30): Boot 19:30:33, `aio-nftables` 19:30:37, Docker,
    Supervisor und Office 19:30:44, alle ohne Neustart durch systemd, keine fehlgeschlagene Unit,
    dieselben Ports, Webinterface 200, Konsole 303 (Weiterleitung zur Anmeldung). Das Office meldet
    Räume und Profile beim Supervisor an und nimmt die wartende Arbeit sofort wieder auf.
  - Neustart von Windows: Boot der VM 19:37:06 ohne Eingriff, Supervisor und Office
    19:37:15, sonst wie oben.

## 4. Funde

- **AK 12, Start des Supervisors bei gestopptem Office (behoben):** Nach der Rücksicherung
  wartete der Supervisor vor `READY=1` auf `systemctl start aio-office`, das Office wegen
  `After=aio-supervisor.service` auf den Supervisor. Nach `TimeoutStartSec` (60 s) startete systemd
  den Supervisor neu, erst dann lief alles. Dasselbe wäre bei jedem Boot passiert (AK 10). Fix:
  Supervisor-PR #27 startet das Office dort mit `--no-block`; VM-Test
  `spikes/vm/i01-start-vmtest.sh` grün, gemergt 24.11. (`171be46`).
- **Firefox-Zugang:** `curl.exe` unter Windows (Schannel) lehnt die Zertifikate des Webinterface
  ohne `--ssl-no-revoke` mit `CRYPT_E_NO_REVOCATION_CHECK` ab, weil sie keine Sperrinformation
  (CRL, OCSP) enthalten. Mit `--ssl-no-revoke` antworten Webinterface (200) und Konsole (303).
  Ob Firefox das bemängelt, prüft Teil 2 **[Annahme: nein]**.
