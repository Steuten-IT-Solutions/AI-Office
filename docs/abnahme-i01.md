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
| Supervisor-Release | `b8985ec` (Baum gleich `main` `1a4865f`), ab 24.11. 18:35 `a8595d7` (Baum gleich `main` `171be46`, Supervisor-PR #27), ab 24.11. 22:44 `bafb27f` (Baum gleich `main` `80389ab`, Supervisor-PR #28, E58), ab 25.11. 11:28 `207b3c0` (Baum gleich `main` `cea2bcc`, Supervisor-PR #29, E59) |
| Office-Release vor dem Test | `f6761ff`, ab AK 3 `2d47bb7` (`main`), ab 25.11. 15:35 `ba9c805` (AI-Office-PR #47, E60 und E61, ausgeliefert mit `aioffice ausliefern`) |
| Benachrichtigung (E37, S14) | nicht konfiguriert, kein Mailanbieter; eingerichtet am 24.11. 20:02 über ein eigenes GMX-Postfach nur für den Supervisor (SMTP mit TLS, Port 465, `spikes/vm/i01-mail-einrichten.sh`), Testmail kam an |
| Merge-Gate (S09) | nicht konfiguriert (`mergeGate` fehlt); für AK 1 am 24.11. eingeschaltet (`i01-ak1-vorbereiten.sh`), App `aio-supervisor` zusätzlich in der Push-Liste von `main`, Regel sonst Stufe 5.2 (Entscheidung des CEO); ab 25.11. gilt jeder PR aus einer Übergabe als beantragt (E59) |
| Browserzugang des CEO | eingerichtet am 24.11.2026: hosts, Stamm-CA (Fingerabdruck `C3664B87…2A239606`, nur `.internal`), Firefox 160 mit Richtlinie aus `einrichtung.md` Teil 6 |

## 3. Ergebnisse je Kriterium

| AK | Kriterium (kurz) | Prüfung | Ergebnis |
|---|---|---|---|
| 1 | Kernkreislauf | Teil 2 | **bestanden** nach Fix (25.11.) |
| 2 | Workflow-PR wird nicht gemergt | Teil 2 | **bestanden** (25.11.) |
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
  die Kette läuft nach dem nächsten Tageswechsel der Kontingentwoche weiter.
  - Nach dem Tageswechsel startet der Lauf `r-d9db9f173d457102` (CTO). Um 1:17 öffnet die App
    `aio-supervisor` AI-Office-PR #49 vom Branch `agent/r-d9db9f173d457102`: nur `README.md`,
    7 Zeilen, CI grün. Der CEO approvt um 10:05 und erneut um 11:08.
  - Das Merge-Gate merged nicht, siehe Funde (fehlender Merge-Antrag). Fix E59 als
    Supervisor-PR #29.
  - Mit `spikes/vm/i01-ak1-merge.sh` wird um 11:28 das Release `207b3c0` aktiviert. Das Gate
    übernimmt PR #49 beim Start als Antrag, sieht das Approve des CEO auf dem Kopf und merged um
    11:28 als `aio-supervisor[bot]`. Merge-Commit `61d358c`, Baum gleich dem Kopf (E39).
  - Der Auslieferer liefert `61d358c` aus (Ergebnis `ausgeliefert`, ab 11:35 laut Journal „Release
    läuft“), keine Merge-Sperre, `aio-office` aktiv. Health-Check `gesund`, 97 Prüfungen,
    0 gescheitert.
  - 10 von 10 Prüfungen grün, Bericht in der VM: `/opt/aio-spikes/berichte/I01-ak1.md`.
- **AK 2:** Der CEO hat entschieden, beide Schutzschichten zu zeigen. Er bestellt im Chat beim
  CTO zwei Änderungen unter `.github/`, ausgewertet mit `spikes/vm/i01-ak2-pruefen.sh` (liest nur
  Audit-Log und Journal, Stelle im Audit-Log ab seq 7193).
  - **Test A, Workflow-Datei:** Kommentarzeile in `.github/workflows/ci.yml`. Lauf
    `r-0913c344b6f1266b` (17:15). Das Git-Gate lässt die Übergabe durch, GitHub lehnt den Push der
    App ab (Recht „Workflows“ fehlt, Spike S1c). Eintrag `git.rejected` mit `push-abgelehnt`,
    kein PR. Die ersten Versuche ab 12:10 scheiterten, weil der Werkbank-Lauf den Auftrag des CEO
    nicht sah, siehe Funde (E60, E61).
  - **Test B, CODEOWNERS:** Kommentarzeile in `.github/CODEOWNERS`. Der erste Versuch
    (`r-082c3736dcc411cd`, 17:41) endet schon im Ausgangsfilter des Git-Gates, siehe Funde. Im
    zweiten Versuch (`r-39e9c6af829f839e`, 20:29) formuliert der CTO selbst. Die App pusht und
    öffnet AI-Office-PR #50 (nur die eine Zeile). Das Merge-Gate übernimmt ihn als Antrag (E59)
    und sperrt ihn 2 s später: „Der PR ändert .github/ (Workflows, CODEOWNERS). Solche Änderungen
    macht nur der CEO über ceo/*“. Der CEO approvt um 20:35; bis zur Prüfung um 20:39 folgt kein
    Merge. PR #50 danach geschlossen.
  - 6 von 6 Prüfungen grün, kein `git.merged` seit Beginn, Bericht in der VM:
    `/opt/aio-spikes/berichte/I01-ak2.md`.
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
  Firefox zeigt keine Warnung (geprüft am 24.11., Kap. 3.2).
- **AK 1, Merge-Antrag fehlte (behoben):** Das Merge-Gate handelte nur auf `request_merge`. Der
  Agent kann es erst in einem späteren Lauf stellen, weil der PR erst nach seiner Übergabe
  entsteht. Keine Weckregel holte ihn dafür zurück; das Journal zeigt nach 1:17 keinen Lauf und
  keinen Antrag. Das Approve des CEO blieb deshalb ohne Wirkung. Entscheidung des CEO am 25.11.:
  Jeder PR aus einer Übergabe gilt als beantragt (E59). Fix: Supervisor-PR #29, das Gate übernimmt
  jeden Eintrag `git.pr_opened` (beim Start die der letzten 30 Tage). Geprüft mit
  `spikes/vm/i01-ak1-merge.sh` (Kap. 3.2), gemergt 25.11. (`cea2bcc`).
- **Änderung auf Wunsch des CEO, Tages-Zielkurve aussetzen (E58):** Der CEO kann die Kurve für
  1 bis 24 Stunden freigeben (`aioffice kontingent-freigabe` oder Konsole). Die Pause bei 55 % der
  Woche, der Zielwert 60 % und das 5-Stunden-Fenster bleiben. Supervisor-PR #28, VM-Test
  `spikes/vm/i01-kurve-vmtest.sh` am 24.11. 22:44 grün (16 von 16), gemergt 24.11. (`80389ab`).
  Für AK 1 wurde die Freigabe nicht genutzt (Entscheidung des CEO).

- **AK 2, CEO-Auftrag wartete 15 Minuten (behoben):** Der Planer bündelte auch eine neue
  Nachricht des CEO (Kap. 5.4, 15 min). Ein Dialog war so nicht möglich. Entscheidung des CEO am
  25.11.: Eine neue Nachricht des CEO weckt sofort (E60). Geprüft am 25.11.: Lauf 2 s nach der
  Nachricht (17:00:27 → 17:00:29).
- **AK 2, Werkbank-Lauf ohne den Auftrag des CEO (behoben):** Der Kontext zeigte nur ungelesene
  Nachrichten. Den Auftrag hatte der CTO im Büro-Lauf gelesen, im Werkbank-Lauf fehlte er; der CTO
  lehnte die Änderung an `ci.yml` deshalb zu Recht ab. Test A brauchte so vier Runden
  (12:10–13:40). Entscheidung des CEO am 25.11. (E61): Der Kontext zeigt die letzten 6 Nachrichten
  mit dem CEO (höchstens 800 Tokens), dazu das Werkzeug `read_messages`. Gemergt mit AI-Office-PR
  #47 (`ba9c805`). Geprüft am 25.11.: Die Übergabenotiz von Test A nennt den Auftrag des CEO.
- **AK 2, Grund der Push-Ablehnung unvollständig (umgesetzt):** Das Git-Gate übernimmt nur die letzte
  Zeile der Ausgabe von `git push`: „error: failed to push some refs …“. Die Erklärung von GitHub
  (fehlendes Recht „Workflows“) steht in Git üblicherweise in der Zeile `! [remote rejected] …`
  davor und geht verloren **[Annahme: im Journal nicht sichtbar, weil nur die letzte Zeile geloggt
  wird]** (`gate.ts`, `lastLine`). Entscheidung des CEO am 25.11. (E65): Das Gate speichert die
  Zeilen zu abgelehnten Refs und die Zeilen `remote:`. Umgesetzt am 25.11., VM-Test offen.
- **AK 2, Ausgangsfilter sperrt Vorgaben des CEO (umgesetzt):** Der erste Versuch von
  Test B scheiterte am Ausgangsfilter: „fingerabdruck (PR-Titel); fingerabdruck (Commit …:
  Nachricht)“. Der CEO hatte den PR-Titel wörtlich vorgegeben, der CTO hat ihn übernommen. Der
  Filter vergleicht jede Folge von 8 Wörtern mit CEO-Chat und Übergabenotizen (Kap. 5.9, E33) und
  arbeitet damit wie geplant. Folge für die Bedienung: Texte, die der CEO für das Repo wörtlich
  vorgibt, sperren die Übergabe. Entscheidung des CEO am 25.11. (E64): Der Filter bleibt; das Buch
  `git-workflow` verlangt eigene Worte und einen Hinweis an den CEO. Umgesetzt am 25.11., VM-Test offen.
- **AK 2, Rückmeldungen erreichen den CEO nicht (umgesetzt):** Der Chat zeigt nur Nachrichten, die ein
  Agent mit `send_message` schickt. Der Schlusstext eines Laufs steht nur als „denkt“ in der
  Zeitleiste. Nach beiden abgelehnten Übergaben kam deshalb keine Nachricht an den CEO. Zudem nennt
  die Übergabenotiz des CTO um 17:41 Test A noch offen, obwohl das Gate ihn um 17:15 abgelehnt
  hatte. Ursache: Das Ergebnis der Übergabe stand nur im nächsten Werkbank-Lauf zur selben
  Aufgabe, und kein Weckgrund holte den CTO dafür zurück. Entscheidungen des CEO am 25.11.: Der
  Schlusstext eines vom CEO geweckten Laufs geht als Antwort in den Chat (E62); eine Ablehnung
  weckt den Bearbeiter, und jeder Kontext zeigt die letzten Übergaben (E63). Umgesetzt am 25.11., VM-Test offen.
- **Chat ohne Bezug (bleibt so):** Der Web-Chat setzt weder `replyToId` noch `taskId`, obwohl die API
  beides annimmt. Eine Antwort des CEO auf eine Rückfrage weckt so einen Büro-Lauf ohne Aufgabe.
  Entscheidung des CEO am 25.11.: so lassen, der Verlauf aus E61 reicht.
- **Weisungen fehlen (umgesetzt):** Kap. 4.4 ist nicht umgesetzt; das Office gibt dem Kontext keine
  Weisungen mit (`directives: []`). Entscheidung des CEO am 25.11. (E68): Weisungen im
  Office-Webinterface, für alle oder ausgewählte Agenten, mit Rücknahme und Eintrag im Audit-Log des
  Supervisors. Umgesetzt am 25.11., VM-Test offen.
- **Alte Aufgaben bleiben offen (umgesetzt):** Für das Schließen einer Aufgabe hat der Agent kein
  Werkzeug. Ältere Aufgaben des CTO (`cfe6ecfd`, `8875fef5`) bleiben deshalb offen. Entscheidung
  des CEO am 25.11. (E66): Werkzeug `set_task_status`, und ein Merge schließt die Aufgabe. Umgesetzt am 25.11., VM-Test offen.
- **Anzeige des Kontingents irreführend (umgesetzt):** Ohne frische Messung, also ohne Nachfrage,
  meldet `aioffice status` den Modus `pause` und „Zähler nicht lesbar“, das Webinterface „noch
  keine Messung vom Supervisor“. Der Supervisor misst beim nächsten Antrag neu; eine Störung liegt
  nicht vor. Entscheidung des CEO am 25.11. (E67): letzte Messung mit Uhrzeit, „nicht lesbar“ nur bei
  einer gescheiterten Messung. Umgesetzt am 25.11., VM-Test offen.
