#!/usr/bin/env bash
# Abnahme I01, Teil 1, in der VM aio-dev (docs/etappe-0.md Kap. 4.1, plan.md Kap. 7.4).
#
# Zweck: Die Abnahmekriterien, die ohne den CEO prüfbar sind, am laufenden System prüfen, mit
# Zeitmessung und Bericht. Teile (Reihenfolge wie hier):
#   konfig  Ausgangslage: Releases, Konfiguration (ohne Geheimnisse), Kontingent
#   ak8     Health-Check mit allen Negativ- und Sandbox-Tests (Kap. 5.13, R5-Ausnahme)
#   ak5     Notaus: Pause lehnt neue Läufe ab, Stopp und Hart beenden einen laufenden Lauf, Hart
#           stoppt auch das Office; Zielwert 10 s. Danach läuft das Office wieder an.
#   ak7     Weckbudget im Supervisor: kurz auf 1 gesenkt, der nächste Antrag wird abgelehnt
#   ak4     Speicher voll: Grenze der Admission kurz über den freien Speicher gesetzt. Antrag
#           abgelehnt, Health-Check meldet Umgebungsfehler, Auslieferung ohne Rollback abgelehnt
#   ak3     Rollback: main ausliefern, in der Beobachtung das Office mit SIGKILL beenden →
#           Rollback auf das laufende Release, Merge-Sperre, Revert-PR, Office-DB erhalten.
#           Danach Sperre aufheben und main erneut ausliefern.
#   ak11    Zeitleiste: jedes Ereignis mit Akteur, Zeitpunkt und Kosten des Laufs
#   ak12    Sicherung anlegen und sofort zurücksichern, Ketten prüfen, Health-Check danach
#
# LLM-Aufrufe: etwa 4 bis 6 kurze haiku-Läufe des Probe-Profils „coo“ (zusammen geschätzt unter
# 0,10 USD [Annahme]) und die Messläufe des Kontingents. Agenten des Office laufen nicht.
# Nach außen: AK 3 öffnet über die GitHub App einen Revert-PR in AI-Office; Claude schließt ihn.
# Was dauerhaft bleibt, wenn alles grün ist: Office läuft mit main (OFFICE_NEU), Konfiguration
# unverändert, eine Sicherung mehr unter /var/backups/aio, die beiseitegelegten DBs aus AK 12.
#
# Aufruf: sudo bash i01.sh
# Das Skript startet sich selbst als systemd-Unit aio-i01 im Hintergrund (etwa 30–45 min).
# Fortschritt: tail -f /opt/aio-spikes/i01/i01.log
# Abbrechen: sudo systemctl stop aio-i01 (die Konfiguration stellt das Skript dann wieder her)
# Nur einzelne Teile: sudo env AIO_I01_TEILE=konfig,ak8 bash i01.sh
# Bericht: /opt/aio-spikes/berichte/I01-teil1.md (ohne Geheimnisse)
set -euo pipefail

OFFICE_NEU=2d47bb7fddbc959f36a21a9bb2bb28dad0549fb3
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARBEIT=/opt/aio-spikes/i01
LOG=$ARBEIT/i01.log
BERICHT=/opt/aio-spikes/berichte/I01-teil1.md
KONFIG=/etc/aio/supervisor.json
OFFICE_DB=/var/lib/aio-office/office.db
AUDIT_DB=/var/lib/aio-sup/audit.db
TEILE="${AIO_I01_TEILE:-konfig,ak8,ak5,ak7,ak4,ak3,ak11,ak12}"
# Lang genug, dass der Lauf beim Notaus noch arbeitet (haiku schreibt etwa 15–30 s).
LANG_PROMPT="Schreibe die Zahlen von 1 bis 600, jede in einer eigenen Zeile, ohne weiteren Text."
KURZ_PROMPT="Antworte nur mit dem Wort OK."

[ "$(id -u)" = 0 ] || {
  echo "Bitte mit sudo starten: sudo bash $0"
  exit 1
}

if [ "${1:-}" != "--vordergrund" ]; then
  if systemctl is-active --quiet aio-i01; then
    echo "I01 läuft schon. Fortschritt: tail -f $LOG"
    exit 1
  fi
  systemctl reset-failed aio-i01 2> /dev/null || true
  install -d -m 0755 -o root -g root /opt/aio-spikes "$ARBEIT" /opt/aio-spikes/berichte
  install -m 0644 -o root -g root "$HIER/i01/probe.js" "$HIER/i01/zeitleiste.js" "$ARBEIT/"
  : > "$LOG"
  chmod 0644 "$LOG"
  systemd-run --unit=aio-i01 --description="Abnahme I01 Teil 1" --collect --setenv=HOME=/root \
    --setenv=AIO_I01_TEILE="$TEILE" /usr/bin/bash "$HIER/i01.sh" --vordergrund > /dev/null
  echo "I01 Teil 1 läuft jetzt im Hintergrund (etwa 30–45 min)."
  echo "Fortschritt: tail -f $LOG"
  exit 0
fi

exec >> "$LOG" 2>&1
umask 022
cd /

ergebnisse=()
gruen=ja
pruefe() { # AK, Name, erwartet, ist
  local ok=FEHLER
  [ "$3" = "$4" ] && ok=ok
  [ "$ok" = ok ] || gruen=nein
  ergebnisse+=("| $1 | $2 | $3 | $4 | $ok |")
  echo "$ok: AK $1 $2 (erwartet: $3, ist: $4)"
}
notiz() { # AK, Text
  ergebnisse+=("| $1 | $2 | – | – | Hinweis |")
  echo "Hinweis: AK $1 $2"
}
info() { echo; echo "== $(date +%H:%M:%S) $*"; }
fehler() {
  echo "FEHLER: $*"
  ergebnisse+=("| – | Abbruch: $* | – | – | FEHLER |")
  gruen=nein
  bericht
  exit 1
}
teil() { [[ ",$TEILE," == *",$1,"* ]]; }
jetzt() { date +%s.%N; }
dauer() { /usr/bin/node -e 'process.stdout.write((Number(process.argv[2]) - Number(process.argv[1])).toFixed(1))' "$1" "$2"; }
bis() { /usr/bin/node -e 'process.stdout.write(Number(process.argv[1]) <= Number(process.argv[2]) ? "ja" : "nein")' "$1" "$2"; }
aio() { (cd / && sudo -u aio-sup /usr/bin/node /opt/aio-supervisor/current/packages/supervisor/src/cli.ts "$@"); }
feld() {
  aio status --json | /usr/bin/node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1].split(".")) v = v == null ? null : v[k];
      process.stdout.write(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    });' "$1"
}
warte() { # Feld, Wert, Sekunden
  local ende=$((SECONDS + $3)) ist
  while [ $SECONDS -lt $ende ]; do
    ist="$(feld "$1" 2> /dev/null || true)"
    [ "$ist" = "$2" ] && return 0
    sleep 3
  done
  echo "Zeit um: $1 ist '$(feld "$1" 2> /dev/null || true)', erwartet '$2'"
  return 1
}
js() { # JSON, Ausdruck über d → Text
  # Leere oder kaputte Eingabe ergibt einen leeren Text, damit set -e nicht mitten im Teil abbricht.
  /usr/bin/node -e '
    let v;
    try {
      v = new Function("d", "return (" + process.argv[2] + ");")(JSON.parse(process.argv[1]));
    } catch { v = null; }
    process.stdout.write(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));' "$1" "$2"
}
sql() { # DB, SQL, Parameter … → JSON-Liste
  /usr/bin/node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all(...process.argv.slice(3))));' "$@"
}
audit_seq() { js "$(sql "$AUDIT_DB" "SELECT max(seq) AS m FROM audit_entries")" 'd[0].m ?? 0'; }
audit_json() { # seq, Muster für kind
  sql "$AUDIT_DB" "SELECT seq, kind, subject, data FROM audit_entries WHERE seq > ? AND kind LIKE ? ORDER BY seq" "$1" "$2" |
    /usr/bin/node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).map((r)=>({...r,data:JSON.parse(r.data)})))))'
}
arten() { js "$(audit_json "$1" "$2")" 'd.map((r) => r.kind.replace(/^[a-z]+\./, "")).join(" ")'; }
office_kopf() { js "$(sql "$OFFICE_DB" "SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")" 'd.length ? d[0].seq + " " + d[0].hash : "leer"'; }
office_hash_bei() { js "$(sql "$OFFICE_DB" "SELECT hash FROM events WHERE seq = ?" "$1")" 'd[0]?.hash ?? "fehlt"'; }
audit_hash_bei() { js "$(sql "$AUDIT_DB" "SELECT hash FROM audit_entries WHERE seq = ?" "$1")" 'd[0]?.hash ?? "fehlt"'; }
unit() { systemctl show aio-office.service --property="$1" --value; }
lauf_container() { docker ps -q --filter "label=aio.lauf=$1" | wc -l; }

# Antrag des Probe-Profils; Ausgabe in Datei. Im Hintergrund mit &.
probe() { # Datei, Prompt
  sudo -u aio-office /usr/bin/node "$ARBEIT/probe.js" "$2" > "$1" 2>&1
}
probe_feld() { # Datei, Zeilenart → Rest der Zeile ohne Zeitstempel
  grep -m1 "^$2 " "$1" | cut -d' ' -f3- || true
}
probe_zeit() { # Datei, Zeilenart → Zeitstempel in s
  awk -v a="$2" '$1 == a { printf "%.3f", $2 / 1000; exit }' "$1"
}
warte_datei() { # Datei, Zeilenart, Sekunden
  local ende=$((SECONDS + $3))
  while [ $SECONDS -lt $ende ]; do
    grep -q "^$2 " "$1" 2> /dev/null && return 0
    grep -q '"decision":"rejected"\|"decision":"fehler"' "$1" 2> /dev/null && return 1
    sleep 0.2
  done
  return 1
}

# Konfiguration ändern und Supervisor neu starten; Sicherung und Rückweg.
SICHER=""
konfig_aendern() { # JS-Anweisung über c
  SICHER="$ARBEIT/supervisor.json.vor-i01.$(date +%Y%m%dT%H%M%S)"
  cp -a "$KONFIG" "$SICHER"
  /usr/bin/node -e '
    const fs = require("node:fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    new Function("c", process.argv[2])(c);
    fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");' "$KONFIG" "$1"
  supervisor_neu
}
konfig_zurueck() {
  [ -n "$SICHER" ] || return 0
  cp -a "$SICHER" "$KONFIG"
  SICHER=""
  supervisor_neu
}
supervisor_neu() {
  systemctl restart aio-supervisor
  local ende=$((SECONDS + 90))
  while [ $SECONDS -lt $ende ]; do
    if systemctl is-active --quiet aio-supervisor && aio status --json > /dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Supervisor nach Neustart nicht bereit"
  return 1
}
aufraeumen() {
  if [ -n "$SICHER" ]; then
    echo "Stelle Konfiguration wieder her ($SICHER)"
    cp -a "$SICHER" "$KONFIG"
    systemctl restart aio-supervisor || true
  fi
  if [ "$(feld emergency 2> /dev/null || true)" != none ]; then
    aio notaus aus --grund "I01: Aufräumen" > /dev/null 2>&1 || true
  fi
}
trap aufraeumen EXIT

# Startet den vollen Health-Check von Hand und wartet; setzt HEALTH_JSON und HEALTH_KURZ.
health() {
  local s
  s=$(audit_seq)
  aio gesundheit > /dev/null
  sleep 3
  warte health.running false 900 || true
  HEALTH_JSON=$(audit_json "$s" "delivery.health_checked")
  HEALTH_KURZ=$(js "$HEALTH_JSON" 'd.length ? (({verdict, checks, passed, seconds}) => `${verdict}, ${passed}/${checks} bestanden, ${seconds} s`)(d.at(-1).data) : "kein Ergebnis"')
  echo "$HEALTH_KURZ"
}
health_details() {
  js "$HEALTH_JSON" 'd.length ? [...(d.at(-1).data.failed ?? []).map((f) => "  gescheitert: " + f.id + " → " + f.observed), ...(d.at(-1).data.info ?? []).map((f) => "  Hinweis: " + f.id + " → " + f.observed)].join("\n") : ""'
  echo
}

bericht() {
  {
    echo "# Abnahme I01, Teil 1 (automatisch)"
    echo
    echo "$(date '+%Y-%m-%d %H:%M %Z'), Teile: $TEILE"
    echo
    echo "Supervisor-Release: $(basename "$(readlink -f /opt/aio-supervisor/current)")"
    echo "Office vorher: ${OFFICE_ALT:-?}, nachher: $(feld deploy.current.sha 2> /dev/null || echo ?)"
    echo
    echo "Gesamtergebnis: $([ $gruen = ja ] && echo grün || echo 'NICHT grün')"
    echo
    echo "| AK | Prüfung | Erwartet | Beobachtet | Ergebnis |"
    echo "|---|---|---|---|---|"
    printf '%s\n' "${ergebnisse[@]}"
  } > "$BERICHT"
  chmod 0644 "$BERICHT"
  echo
  cat "$BERICHT"
}

info "Abnahme I01 Teil 1 beginnt, Teile $TEILE"
/usr/bin/node --version | grep -q '^v24\.' || fehler "/usr/bin/node ist nicht Node 24"
systemctl is-active --quiet aio-supervisor || fehler "aio-supervisor läuft nicht"
systemctl is-active --quiet aio-office || fehler "aio-office läuft nicht"
[ "$(feld emergency)" = none ] || fehler "Notaus ist aktiv: $(feld emergency)"
[ -z "$(feld deploy.active)" ] || fehler "Es läuft eine Auslieferung"
OFFICE_ALT=$(feld deploy.current.sha)
echo "Supervisor $(basename "$(readlink -f /opt/aio-supervisor/current)"), Office $OFFICE_ALT"

if teil konfig; then
  info "Ausgangslage"
  /usr/bin/node -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const out = {
      abschnitte: Object.keys(c),
      admission: c.admission ?? "Standardwerte",
      quota: c.quota ?? "Startwerte aus dem Plan",
      reposFuerLaeufe: Object.keys(c.runs?.repos ?? {}),
      deploy: c.deploy ? { repo: c.deploy.repo } : null,
      mergeGate: c.mergeGate ?? null,
      gitGate: c.gitGate ? Object.keys(c.gitGate) : null,
      notification: c.notification ? Object.keys(c.notification) : null,
    };
    console.log(JSON.stringify(out, null, 2));' "$KONFIG" || true
  aio status --json | /usr/bin/node -e '
    let s=""; process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{ const d=JSON.parse(s);
    console.log(JSON.stringify({emergency:d.emergency, breaker:d.breaker, delivery:d.delivery,
      deploy:{current:d.deploy?.current?.sha, previous:d.deploy?.previous?.sha, mergeLock:d.deploy?.mergeLock, waiting:d.deploy?.waiting},
      quota:d.quota, profiles:d.profiles, rooms:d.rooms, activeRuns:d.activeRuns}, null, 2)); });' || true
  df -h / | sed 1d
  if [ -z "$(/usr/bin/node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.notification?"ja":"")' "$KONFIG")" ]; then
    notiz "6, 7" "Keine Benachrichtigung konfiguriert: Meldungen gehen nur ins Audit-Log, keine E-Mail"
  fi
fi

if teil ak8; then
  info "AK 8: Health-Check mit Negativ- und Sandbox-Tests"
  health
  health_details
  pruefe 8 "Health-Check Urteil" gesund "$(js "$HEALTH_JSON" 'd.at(-1)?.data.verdict')"
  pruefe 8 "alle Prüfungen bestanden" ja "$(js "$HEALTH_JSON" 'd.at(-1) && d.at(-1).data.passed === d.at(-1).data.checks ? "ja" : "nein"')"
  notiz 8 "Umfang: $HEALTH_KURZ"
  r5=$(js "$HEALTH_JSON" '(d.at(-1)?.data.info ?? []).filter((i) => /token|r5/i.test(i.id + i.observed)).map((i) => i.id).join(", ")')
  [ -z "$r5" ] || notiz 8 "R5-Ausnahme als Hinweis: $r5"
fi

if teil ak5; then
  info "AK 5: Notaus Pause"
  t0=$(jetzt)
  aio notaus pause --grund "I01 AK 5 Pause" > /dev/null
  probe "$ARBEIT/p-pause.log" "$KURZ_PROMPT"
  t1=$(jetzt)
  cat "$ARBEIT/p-pause.log"
  pruefe 5 "Pause: neuer Antrag abgelehnt" rejected "$(js "$(probe_feld "$ARBEIT/p-pause.log" entscheidung)" 'd.decision')"
  pruefe 5 "Pause: Grund Notaus" ja "$(probe_feld "$ARBEIT/p-pause.log" entscheidung | grep -q 'Notaus' && echo ja || echo nein)"
  notiz 5 "Pause: Setzen bis Ablehnung $(dauer "$t0" "$t1") s"
  aio notaus aus --grund "I01 AK 5 Pause Ende" > /dev/null

  for stufe in stopp hart; do
    info "AK 5: Notaus $stufe mit laufendem Lauf"
    datei="$ARBEIT/p-$stufe.log"
    probe "$datei" "$LANG_PROMPT" &
    ppid_probe=$!
    if ! warte_datei "$datei" erste_ausgabe 120; then
      cat "$datei"
      pruefe 5 "$stufe: Lauf gestartet" ja nein
      wait "$ppid_probe" || true
      continue
    fi
    lauf=$(probe_feld "$datei" gestartet | awk '{print $1}')
    sleep 2
    pruefe 5 "$stufe: Lauf arbeitet beim Notaus" 1 "$(lauf_container "$lauf")"
    office_pid=$(unit MainPID)
    t0=$(jetzt)
    aio notaus "$stufe" --grund "I01 AK 5 $stufe" > /dev/null
    t_cont=""
    t_office=""
    ende=$((SECONDS + 120))
    while [ $SECONDS -lt $ende ]; do
      [ -n "$t_cont" ] || [ "$(lauf_container "$lauf")" != 0 ] || t_cont=$(jetzt)
      if [ $stufe = hart ] && [ -z "$t_office" ] && [ "$(unit ActiveState)" != active ]; then t_office=$(jetzt); fi
      [ -n "$t_cont" ] && { [ $stufe != hart ] || [ -n "$t_office" ]; } && break
      sleep 0.2
    done
    wait "$ppid_probe" || true
    cat "$datei"
    if [ -n "$t_cont" ]; then
      d=$(dauer "$t0" "$t_cont")
      pruefe 5 "$stufe: Lauf beendet in ≤ 10 s ($d s)" ja "$(bis "$d" 10)"
    else
      pruefe 5 "$stufe: Lauf beendet" ja nein
    fi
    notiz 5 "$stufe: Ende laut Supervisor $(probe_feld "$datei" ende), Ergebnis des CLI: $(probe_feld "$datei" ergebnis)"
    if [ $stufe = hart ]; then
      if [ -n "$t_office" ]; then
        d=$(dauer "$t0" "$t_office")
        pruefe 5 "hart: Office gestoppt in ≤ 10 s ($d s)" ja "$(bis "$d" 10)"
      else
        pruefe 5 "hart: Office gestoppt" ja nein
      fi
    fi
    aio notaus aus --grund "I01 AK 5 $stufe Ende" > /dev/null
    if [ $stufe = hart ]; then
      ende=$((SECONDS + 120))
      while [ $SECONDS -lt $ende ] && [ "$(unit ActiveState)" != active ]; do sleep 2; done
      pruefe 5 "hart: Office nach Aufheben wieder aktiv" active "$(unit ActiveState)"
      pruefe 5 "hart: Office neu gestartet" ja "$([ "$(unit MainPID)" != "$office_pid" ] && echo ja || echo nein)"
    fi
  done
  pruefe 5 "Notaus am Ende aus" none "$(feld emergency)"
fi

if teil ak7; then
  info "AK 7: Weckbudget im Supervisor"
  s=$(audit_seq)
  konfig_aendern 'c.admission = { ...(c.admission ?? {}), wakeBudgetPerDay: 1 };'
  probe "$ARBEIT/p-weck1.log" "$KURZ_PROMPT"
  cat "$ARBEIT/p-weck1.log"
  probe "$ARBEIT/p-weck2.log" "$KURZ_PROMPT"
  cat "$ARBEIT/p-weck2.log"
  abl=$(audit_json "$s" "run.rejected")
  pruefe 7 "Weckbudget: Antrag abgelehnt" rejected "$(js "$(probe_feld "$ARBEIT/p-weck2.log" entscheidung)" 'd.decision')"
  pruefe 7 "Weckbudget: Regel im Audit" wake_budget "$(js "$abl" 'd.at(-1)?.data.rule')"
  notiz 7 "Weckbudget: Grund „$(js "$abl" 'd.at(-1)?.data.reason')“"
  konfig_zurueck
fi

if teil ak4; then
  info "AK 4: Speicher voll (Grenze der Admission über dem freien Speicher)"
  pfad=$(/usr/bin/node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.admission?.diskPath ?? "/var/lib/aio-sup")' "$KONFIG")
  frei=$(df --output=avail -B1 "$pfad" | tail -1 | tr -d ' ')
  grenze=$((frei + 20 * 1024 * 1024 * 1024))
  echo "frei $frei Bytes, Grenze für den Test $grenze Bytes"
  s=$(audit_seq)
  pid_vorher=$(unit MainPID)
  konfig_aendern "c.admission = { ...(c.admission ?? {}), minFreeBytes: $grenze };"
  probe "$ARBEIT/p-speicher.log" "$KURZ_PROMPT"
  cat "$ARBEIT/p-speicher.log"
  pruefe 4 "Antrag abgelehnt" rejected "$(js "$(probe_feld "$ARBEIT/p-speicher.log" entscheidung)" 'd.decision')"
  pruefe 4 "Regel im Audit" disk "$(js "$(audit_json "$s" "run.rejected")" 'd.at(-1)?.data.rule')"
  health
  health_details
  pruefe 4 "Health-Check Urteil" umgebungsfehler "$(js "$HEALTH_JSON" 'd.at(-1)?.data.verdict')"
  pruefe 4 "Health-Check nennt den Speicher" ja "$(js "$HEALTH_JSON" '(d.at(-1)?.data.failed ?? []).some((f) => f.id === "umgebung.speicher") ? "ja" : "nein"')"
  s2=$(audit_seq)
  aio ausliefern "$OFFICE_NEU" --grund "I01 AK 4: Auslieferung bei vollem Speicher" > "$ARBEIT/ak4-ausliefern.txt" 2>&1 || true
  tail -3 "$ARBEIT/ak4-ausliefern.txt"
  warte deploy.last.result umgebungsfehler 300 || true
  pruefe 4 "Auslieferung: Ergebnis" umgebungsfehler "$(feld deploy.last.result)"
  notiz 4 "Auslieferung: Grund „$(feld deploy.last.reason)“"
  a=$(arten "$s2" "delivery.%")
  echo "Audit: $a"
  pruefe 4 "Auslieferung: kein Rollback" nein "$(grep -qw rolled_back <<< "$a" && echo ja || echo nein)"
  pruefe 4 "Auslieferung: kein Build" nein "$(grep -qw built <<< "$a" && echo ja || echo nein)"
  pruefe 4 "Office unverändert (Release)" "$OFFICE_ALT" "$(feld deploy.current.sha)"
  pruefe 4 "Office unverändert (Prozess)" "active $pid_vorher" "$(unit ActiveState) $(unit MainPID)"
  pruefe 4 "keine Merge-Sperre" "" "$(feld deploy.mergeLock)"
  konfig_zurueck
fi

if teil ak3; then
  info "AK 3: Rollback nach absichtlich fehlerhaftem Release"
  if [ "$(feld deploy.current.sha)" = "$OFFICE_NEU" ]; then
    notiz 3 "übersprungen: $OFFICE_NEU läuft schon"
  else
    read -r kopf_seq kopf_hash <<< "$(office_kopf)"
    echo "Office-DB vorher: seq $kopf_seq"
    s=$(audit_seq)
    zuletzt=$(feld deploy.last.at)
    aio ausliefern "$OFFICE_NEU" --grund "I01 AK 3 Teil 1 (Rollback-Test)" > /dev/null || fehler "aio ausliefern $OFFICE_NEU gescheitert"
    ende=$((SECONDS + 2400))
    while [ $SECONDS -lt $ende ]; do
      phase="$(feld deploy.active.phase 2> /dev/null || true)"
      [ "$phase" = beobachten ] && break
      # Vor der Beobachtung beendet: neues Ergebnis ohne laufende Auslieferung.
      if [ -z "$phase" ] && [ "$(feld deploy.last.at)" != "$zuletzt" ]; then break; fi
      sleep 3
    done
    if [ "$(feld deploy.active.phase)" != beobachten ]; then
      echo "Ergebnis: $(feld deploy.last.result), Grund: $(feld deploy.last.reason)"
      fehler "AK 3: Beobachtung nicht erreicht"
    fi
    hc=$(audit_json "$s" "delivery.health_checked")
    pruefe 3 "neues Release: Health-Check gesund" gesund "$(js "$hc" 'd.at(-1)?.data.verdict')"
    pid=$(unit MainPID)
    echo "Beobachtung läuft, Office-PID $pid; in 15 s SIGKILL (der absichtliche Fehler)"
    sleep 15
    kill -9 "$pid"
    t0=$(jetzt)
    warte deploy.last.result zurueckgerollt 900 || true
    t1=$(jetzt)
    pruefe 3 "Ergebnis" zurueckgerollt "$(feld deploy.last.result)"
    notiz 3 "Grund „$(feld deploy.last.reason)“, Rollback nach $(dauer "$t0" "$t1") s"
    pruefe 3 "Release nach Rollback" "$OFFICE_ALT" "$(feld deploy.current.sha)"
    pruefe 3 "Office läuft nach Rollback" active "$(unit ActiveState)"
    pruefe 3 "Merge-Sperre gesetzt" ja "$([ -n "$(feld deploy.mergeLock)" ] && echo ja || echo nein)"
    a=$(arten "$s" "delivery.%")
    echo "Audit: $a"
    for art in built backed_up health_checked failed merge_locked rolled_back; do
      pruefe 3 "Audit $art" ja "$(grep -qw "$art" <<< "$a" && echo ja || echo nein)"
    done
    pruefe 3 "Zustand erhalten (Office-DB seq $kopf_seq)" "$kopf_hash" "$(office_hash_bei "$kopf_seq")"
    pruefe 3 "Office prüft Kette beim Start" ja "$(journalctl -u aio-office --since "-20 min" --no-pager | grep -q 'Hash-Kette geprüft' && echo ja || echo nein)"
    rv=$(audit_json "$s" "delivery.revert_%")
    revert=$(js "$rv" 'd.length ? (d[0].kind === "delivery.revert_opened" ? "PR #" + d[0].data.pr + " (" + d[0].data.branch + ")" : "übersprungen: " + JSON.stringify(d[0].data)) : "kein Eintrag"')
    pruefe 3 "Revert-PR geöffnet" ja "$(js "$rv" 'd.length === 1 && d[0].kind === "delivery.revert_opened" ? "ja" : "nein"')"
    notiz 3 "Revert: $revert (Claude schließt ihn nach dem Test)"

    info "AK 3: Merge-Sperre aufheben und main erneut ausliefern"
    aio merge-sperre aufheben --grund "I01 AK 3: Absturz war gewollt" > /dev/null || fehler "aio merge-sperre aufheben gescheitert"
    pruefe 3 "Merge-Sperre aufgehoben" "" "$(feld deploy.mergeLock)"
    s=$(audit_seq)
    aio ausliefern "$OFFICE_NEU" --grund "I01 AK 3 Teil 2" > /dev/null || fehler "aio ausliefern $OFFICE_NEU gescheitert"
    warte deploy.last.result ausgeliefert 2400 || true
    pruefe 3 "erneute Auslieferung" ausgeliefert "$(feld deploy.last.result)"
    pruefe 3 "laufendes Release" "$OFFICE_NEU" "$(feld deploy.current.sha)"
    hc=$(audit_json "$s" "delivery.health_checked")
    pruefe 3 "Health-Check gesund" gesund "$(js "$hc" 'd.at(-1)?.data.verdict')"
    pruefe 3 "ohne neuen Build" nein "$(grep -qw build_started <<< "$(arten "$s" "delivery.%")" && echo ja || echo nein)"
  fi
fi

if teil ak11; then
  info "AK 11: Zeitleiste"
  z=$(/usr/bin/node "$ARBEIT/zeitleiste.js" "$OFFICE_DB")
  echo "$z"
  pruefe 11 "Ereignisse ohne Akteur" "[]" "$(js "$z" 'd.ohneAkteur')"
  pruefe 11 "Ereignisse ohne Zeitpunkt" "[]" "$(js "$z" 'd.ohneZeit')"
  pruefe 11 "Handlungen aus Läufen ohne Kosten" "[]" "$(js "$z" 'd.ohneKosten')"
  pruefe 11 "Handlungen ohne Agent" "[]" "$(js "$z" 'd.ohneAgent')"
  notiz 11 "$(js "$z" '`${d.ereignisse} Ereignisse, ${d.ausLaeufen} aus ${d.laeufe} Läufen, ${d.ohneLauf} ohne Lauf (CEO, System), ${d.pruefLaeufe} aus Prüfläufen`')"
fi

if teil ak12; then
  info "AK 12: Sicherung anlegen und zurücksichern"
  aio-sicherung sichern || fehler "aio-sicherung sichern gescheitert"
  liste=$(aio-sicherung liste --json)
  name=$(js "$liste" 'd.filter((e) => e.manifest).at(-1).name')
  m=$(js "$liste" 'd.filter((e) => e.manifest).at(-1).manifest')
  a_seq=$(js "$m" 'd.audit.head.seq')
  a_hash=$(js "$m" 'd.audit.head.hash')
  o_seq=$(js "$m" 'd.office?.head?.seq ?? ""')
  o_hash=$(js "$m" 'd.office?.head?.hash ?? ""')
  echo "Sicherung $name: Audit seq $a_seq, Office seq $o_seq"
  pruefe 12 "Sicherung enthält die Office-DB" ja "$([ -n "$o_seq" ] && echo ja || echo nein)"
  aio-sicherung pruefen "$name"
  t0=$(jetzt)
  aio-sicherung zuruecksichern "$name" --ja || fehler "aio-sicherung zuruecksichern $name gescheitert"
  ende=$((SECONDS + 180))
  while [ $SECONDS -lt $ende ]; do
    systemctl is-active --quiet aio-supervisor && [ "$(unit ActiveState)" = active ] && aio status --json > /dev/null 2>&1 && break
    sleep 2
  done
  t1=$(jetzt)
  pruefe 12 "Supervisor läuft danach" active "$(systemctl show aio-supervisor --property=ActiveState --value)"
  pruefe 12 "Office läuft danach" active "$(unit ActiveState)"
  notiz 12 "Rücksicherung $name bis beide Dienste laufen: $(dauer "$t0" "$t1") s"
  pruefe 12 "Audit-DB enthält den gesicherten Kopf" "$a_hash" "$(audit_hash_bei "$a_seq")"
  pruefe 12 "Office-DB enthält den gesicherten Kopf" "$o_hash" "$(office_hash_bei "$o_seq")"
  pruefe 12 "alter Stand beiseitegelegt" ja "$(ls /var/lib/aio-office/ | grep -q "vor-ruecksicherung-$name" && echo ja || echo nein)"
  health
  health_details
  pruefe 12 "Health-Check nach Rücksicherung" gesund "$(js "$HEALTH_JSON" 'd.at(-1)?.data.verdict')"
  notiz 12 "Rücksicherung aus der SQLite-Sicherung in /var/backups/aio (S15); der VM-Export auf F:/G: ist nicht Teil dieses Tests"
fi

info "Ende"
pruefe "–" "Notaus am Ende" none "$(feld emergency)"
pruefe "–" "Office läuft am Ende" active "$(unit ActiveState)"
bericht
[ $gruen = ja ]
