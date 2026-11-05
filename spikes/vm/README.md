# Spikes S1a, S1b, S1f, S1g und S2 in der VM `aio-dev`

Plan: [`docs/etappe-0.md`](../../docs/etappe-0.md) Kap. 3.1 und 3.2, Hintergrund in
[`docs/plan.md`](../../docs/plan.md) Kap. 4.7, 5.7 und 6. Die Skripte laufen nur in der VM
`aio-dev`, nicht in der Cloud. Sie geben nie ein Token aus, nur „gefunden / nicht gefunden“ und
Prüfsummen. Ergebnis ist je Spike ein Bericht unter `/opt/aio-spikes/berichte/`.

## Überblick

| Spike | Frage | Braucht | Kosten [Annahme] | Dauer [Annahme] |
|---|---|---|---|---|
| S1g | Erreicht der Lauf-Container nur Proxy, Office-API und Gateway? | nur das Image | keine | 2 min |
| S1a | Kann Bash im Container das `setup-token` lesen? | `setup-token` | 2 kurze `haiku`-Läufe | 3 min |
| S1f | Lädt `claude -p` Hooks oder MCP-Server aus dem Arbeitsbereich? | `setup-token` | 4 kurze `haiku`-Läufe | 3 min |
| S1b | Welche Endpunkte braucht das CLI, geht ein Proxy mit Allowlist? | `setup-token` | 6 kurze `haiku`-Läufe | 5 min |
| S2 | Ist `/usage` per Skript lesbar, wie stabil ist USD → Prozentpunkte? | voller Login, `setup-token`, ruhiges Zeitfenster | bis 5 Prozentpunkte Wochenlimit | 30–60 min |

Reihenfolge wie Kap. 3.4: S1g, S1a, S1f, S1b, dann S2.

## Einmalig: Repo holen und Images bauen

In einer Windows-PowerShell `ssh aio-dev` ([`einrichtung.md`](../../docs/einrichtung.md) 4.6),
dann in der VM:

```bash
sudo apt install -y git          # falls noch nicht vorhanden
sudo git clone --depth 1 https://github.com/Steuten-IT-Solutions/AI-Office.git /opt/aio-spikes/repo
sudo bash /opt/aio-spikes/repo/spikes/vm/bauen.sh
```

Solange dieser PR nicht gemergt ist, beim Klonen `-b s1-s2-spike-skripte` ergänzen. Später
aktualisieren: `sudo git -C /opt/aio-spikes/repo pull` und `bauen.sh` erneut.

`bauen.sh` baut das Lauf-Image in drei Varianten (`sandbox`, `streng`, `ohne`, siehe unten),
lädt mitmproxy und prüft, ob das CLI im Image alle verwendeten Flags kennt. Es lädt etwa 130 MB
für das CLI und die Basis-Images.

Alle Skripte brauchen `sudo`, weil Ihr Benutzer bewusst nicht in der Gruppe `docker` ist (E25).
Kurz: `cd /opt/aio-spikes/repo/spikes/vm` und dann `sudo bash <skript>`.

## Zugänge (etappe-0.md 1.5)

```bash
sudo bash zugang.sh token     # vor S1a, S1b, S1f
sudo bash zugang.sh voll      # vor S2
sudo bash zugang.sh status    # zeigt nur „vorhanden / fehlt“
```

- **`token`** startet `claude setup-token` im Image. Sie öffnen den Link im Browser unter
  Windows und bestätigen. Das Token erscheint einmal im Terminal ([Doku](https://code.claude.com/docs/en/authentication):
  „It does not save the token anywhere“). Sie kopieren es und fügen es auf die Frage des Skripts
  ein; die Eingabe bleibt unsichtbar. Abgelegt wird es in `/opt/aio-spikes/geheim/setup-token`
  (0600, root), daneben das Erstellungsdatum und unter `daten/token.sha256` nur der Hash für die
  Proben. Danach `clear` und das Fenster schließen.
- **`voll`** startet Claude Code mit `CLAUDE_CONFIG_DIR=/claude-voll`. Darin `/login`, Link unter
  Windows öffnen, Code einfügen, `/exit`. Die Anmeldung liegt dann in
  `/opt/aio-spikes/geheim/claude-voll/.credentials.json` (laut Doku Modus 0600).

Für den Betrieb wandern beide später nach `/etc/aio/` (S16, etappe-0.md 1.5). Für die Spikes
reicht laut 1.5 ein eigenes Verzeichnis.

## Spikes ausführen

```bash
sudo bash s1g.sh
sudo bash s1a.sh
sudo bash s1f.sh                 # mit AIO_SANDBOX=ohne, wenn S1a „Sandbox startet nicht“ meldet
sudo bash s1b.sh                 # ebenso
sudo bash s2.sh                  # ruhiges Zeitfenster, interaktiv
sudo bash aufraeumen.sh          # Container und Netze; --alles löscht auch Images und Zugänge
```

Mit `sudo env AIO_SANDBOX=ohne bash s1f.sh` (ebenso für `s1b.sh`) laufen S1b und S1f ohne
Bash-Sandbox. Das ändert ihre Aussage nicht, weil sie Netz und Konfiguration prüfen, nicht die
Sandbox.

Die Berichte (`S1a-bericht.md` usw.) liegen in `/opt/aio-spikes/berichte/` und enthalten keine
Geheimnisse. Unter Windows holen Sie sie mit `scp "aio-dev:/opt/aio-spikes/berichte/*" .` und
schicken sie mir. Ich lege sie dann als `spikes/ergebnisse/S<n>.md` per PR ab (Kap. 3). **Der
S2-Bericht enthält Ihre Kontingentstände**; ob die in das öffentliche Repo sollen, entscheiden Sie.

## Was die Skripte prüfen

| Spike | Go | Aufbau |
|---|---|---|
| S1a | Kein Fundort enthält das Token, Sandbox aktiv | Container gehärtet wie Kap. 4.7 (`--cap-drop ALL`, `no-new-privileges`, `--read-only`, tmpfs, Limits), Token in seiner Umgebung. Managed Settings im Image (root, nur lesbar): Sandbox an, `enableWeakerNestedSandbox`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, `credentials.envVars` mit `CLAUDE_CODE_OAUTH_TOKEN` auf `deny` ([Sandboxing](https://code.claude.com/docs/en/sandboxing)). Ein `claude -p`-Lauf führt nur `probe/probe.sh` aus. Die Probe durchsucht Umgebung, `/proc/*/environ`, `/proc/*/cmdline` und Dateien unter `$HOME`, `CLAUDE_CONFIG_DIR`, `/tmp`, `/work`. **Positivkontrollen** ohne Sandbox (Umgebung, `/proc/1/environ`, Testdatei) müssen das Token finden, sonst ist die Messung ungültig. Dazu `bwrap` direkt als Diagnose und die Variante `streng` (ohne `enableWeakerNestedSandbox`) zur Information. |
| S1f | Keine Markerdatei, kein fremder MCP-Server in `system/init` | Arbeitsbereich mit `.claude/settings.json` (Hooks für vier Ereignisse, Bash-Freigabe), `.mcp.json` (fremder Server legt beim Start eine Markerdatei an), `CLAUDE.md`. Vier Läufe: **Kontrolle** ohne die Flags (muss Hooks, Bash-Freigabe und MCP zeigen, sonst ungültig), **plan** mit den Flags aus Kap. 5.7 (ungültig, wenn der Lauf ohne `system/init` oder Ergebnis endet), dazu `--strict-mcp-config` und nur `--setting-sources user` zur Information. |
| S1b | Läufe gehen mit Allowlist, fremde Schlüssel werden blockiert | Lauf-Netz ohne Weg nach außen, mitmproxy als einziger Ausgang (`HTTPS_PROXY`, CA per `NODE_EXTRA_CA_CERTS`, [Netzwerk-Doku](https://code.claude.com/docs/en/network-config)). Durchgang 1 protokolliert drei Läufe (Text, Werkzeuge, MCP), nur Host, Methode, Pfad ohne Query und die Art der Anmeldung. Daraus die Allowlist. Jeder Lauf muss seine Werkzeugaufrufe wirklich machen (Read, Bash, `mcp__attrappe__ping` bei verbundenem Server), sonst ist Durchgang 1 ungültig. Durchgang 2 mit Allowlist (nur HTTPS auf Port 443): Die drei Läufe müssen gehen; fremder `x-api-key`, fremdes Bearer-Token, unser Token plus fremder Key, unser Token auf der Files-API, unser Token an einen fremden Host mit gefälschtem `Host: api.anthropic.com` (Ziel `*.invalid`, löst nie auf) und ein fremder Host müssen am Proxy scheitern. Der Proxy prüft das Ziel der Anfrage, nicht den Host-Header. |
| S1g | Host, andere Container, Internet und DNS direkt scheitern; Proxy, Office-API- und Gateway-Attrappe gehen | Netzprobe aus einem Lauf-Container: TCP zum Host (Gateway des Lauf-Netzes, `docker0`, Adresse im Default Switch, Port 22), zu Containern in einem zweiten Lauf-Netz und an der Standard-Bridge, Internet über IPv4 und IPv6, DNS über den Resolver des Containers und direkt (1.1.1.1, 8.8.8.8, Gateway). |
| S2a | `/usage` maschinenlesbar, Werte wie in claude.ai (± 1 Prozentpunkt) | `claude -p --output-format json -- /usage` und dasselbe über `--input-format stream-json` (siehe Abweichung 1), jeweils mit vollem Login; zur Information auch mit `setup-token`. Danach fragt das Skript die Werte aus claude.ai ab; fehlt ein Wert, ist S2a ungültig. `sudo bash s2.sh` (alles) beginnt mit leeren Ergebnissen; einzelne Teile (`sudo bash s2.sh b` usw.) ergänzen die vorhandenen. |
| S2b | 30 Abfragen ohne messbaren Anstieg, `total_cost_usd` ≈ 0 | 30 Abfragen in Folge, Werte vorher und nachher. Ungültig, wenn eine der beiden Messungen fehlt, die Fenster sich unterscheiden, ein Fenster zurückgesetzt wurde oder eine Abfrage keine Kosten meldet. Auch S2b stoppt bei erreichtem Budget oder unlesbarem Zähler; dann ist die Stichprobe ungültig. |
| S2c | 90-%-Quantil / Median des Faktors ≤ 1,5 | Standardlauf (drei Dateien lesen, Summe nennen) in 6 Blöcken zu 5 Läufen je Modell (`haiku`, `sonnet`), `/usage` zwischen den Blöcken. Faktor = Δ Prozentpunkte / Σ `total_cost_usd` je Fenster. **Abbruch**, sobald das Wochenfenster seit S2a um 5 Prozentpunkte gestiegen ist (`AIO_S2_BUDGET_PP`) oder ein `rate_limit_event` mit `rejected` kommt, sofort nach dem betroffenen Lauf. Das Budget prüft das Skript nach jedem Block; überschreiten kann es das Budget also höchstens um einen Block (5 Läufe). Ist das Wochenfenster vor dem ersten oder nach einem Block nicht lesbar, bricht S2c ebenfalls ab. Nach einem Abbruch startet `alles` S2d nicht mehr. Go nur bei vollständiger Stichprobe (alle Blöcke, alle Läufe `success`); sonst ist S2c ungültig. |
| S2d | Messwert | „Antworte mit OK“ mit Verfassung (plan.md 4.1) im System-Prompt und der MCP-Attrappe mit 8 Werkzeugen, je Modell 3 Läufe. Ein Lauf zählt nur mit `success`, verbundenem Server `office` und allen 8 Werkzeugen in `system/init`. Die 5 Prozentpunkte gelten für ganz S2, gezählt ab der ersten lesbaren Messung in S2a (so zählt auch, was S2a und S2b verbrauchen). S2d misst vor jedem Lauf neu, startet keinen weiteren Lauf bei erreichtem Budget oder unlesbarem Zähler und bricht bei `rejected` ab. |
| S2e | dokumentiert | Ereignistypen aller Läufe aus S2c und S2d, dazu jedes `rate_limit_event`. |

Alle Läufe nutzen den Parser des Office (`packages/office/src/llm/stream-json.ts`, P07). Die
Berichte zeigen deshalb auch, ob er mit der echten Ausgabe des gepinnten CLI zurechtkommt.

## Abweichungen und Ergänzungen (Vorschläge, bitte bestätigen)

1. **S2a ohne Agent-SDK-Paket.** Der Plan nennt als zweiten Weg das Agent SDK. Statt
   `@anthropic-ai/claude-agent-sdk` als neue Abhängigkeit (Peer-Abhängigkeiten zod,
   `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`) schickt das Skript `/usage` über
   `--input-format stream-json` und liest alle Nachrichten. **[Annahme]** Das SDK spricht mit dem
   CLI über genau dieses Protokoll; den `SDKUsageReport` aus Fakt 7 müsste man dort also auch
   sehen. Wenn Sie den Weg über das SDK selbst wollen, ergänze ich ihn.
2. **`failIfUnavailable: true`** in den Managed Settings. Ohne diese Einstellung führt das CLI
   Befehle ohne Sandbox aus, wenn die Sandbox nicht startet (Sandboxing-Doku: „By default, if the
   sandbox can't start …, Claude Code runs commands without sandboxing“). Vorschlag: so auch in
   Kap. 5.7 übernehmen.
3. **CLI 2.1.312** ist gepinnt: die neueste Version, die am 05.11.2026 mindestens 7 Tage alt war
   (wie `minimumReleaseAge`). Das CLI kommt als natives Binary aus dem npm-Paket für linux-x64,
   mit fester SHA-256 des Tarballs und ohne Install-Skript. Welche Version P12 pinnt, ist offen.
4. **Office-API und Gateway in S1g als Container im Lauf-Netz.** Wie S05 sie anbindet (Port am
   Host oder Relay im Lauf-Netz), ist nicht entschieden **[Annahme]**.
5. **Zugänge in `/opt/aio-spikes/geheim/`** statt `/etc/aio/secrets/` (etappe-0.md 1.5 erlaubt
   für die Spikes ein eigenes Verzeichnis).

## Annahmen

- Das `setup-token` beginnt mit `sk-ant-`. Davon hängen die Muster in Probe und Maskierung ab;
  die Positivkontrollen in S1a zeigen, ob es stimmt.
- Die Ausgabe von `/usage` im Print-Modus ist nicht dokumentiert. `src/usage.ts` sucht deshalb
  strukturierte Felder (`kind`, `percent`, `resets_at`, Fakt 7) und liest sonst Prozentzahlen
  aus dem Text. Der S2-Bericht enthält den Text, damit der Parser nachgebessert werden kann.
- Das offizielle mitmproxy-Image setzt UID und GID von `mitmproxy` auf den Besitzer des
  gemounteten Konfigurationsordners (Entrypoint in v12.3.1, belegt). Die Skripte nehmen
  10002:65534, weil `usermod -g` eine im Image vorhandene Gruppe braucht. Dass 65534 (`nogroup`)
  im Image existiert, ist **[Annahme]** (Standard in Debian); `bauen.sh` prüft es. Startet der Proxy nicht, brechen
  `s1b.sh` und `s1g.sh` mit dem Log ab.
- Die MCP-Attrappe beantwortet `initialize` und `server/discover`; welchen Weg das CLI über stdio
  nimmt, protokolliert sie auf stderr.
- Dauer und Kosten in der Tabelle oben sind Schätzungen.
