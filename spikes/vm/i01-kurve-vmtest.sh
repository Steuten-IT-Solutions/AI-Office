#!/usr/bin/env bash
# VM-Test zum Supervisor-PR #28 „Tages-Zielkurve per Freigabe des CEO befristet aussetzen“ (E58),
# Wunsch des CEO aus der Abnahme I01.
#
# Zweck: Den Supervisor mit der Änderung in aio-dev aktivieren und zeigen, dass die Freigabe wirkt
# und alles andere bleibt: Mit Freigabe steht die Pausenschwelle der Woche auf 55 %, ein Eintrag
# `cost.curve_released` steht im Audit-Log und die E-Mail geht hinaus. Nach `ende` gilt die Kurve
# wieder. Ungültige Stunden lehnt die CLI ab.
#
# Damit der Test keinen Lauf auslöst (AK 1 wartet auf das Kontingent), setzt das Skript vorher den
# Notaus auf Pause und stellt danach die alte Stufe wieder her, auch bei einem Fehler. Kein
# LLM-Aufruf. Scheitert der Start des neuen Release, schaltet das Skript auf das alte zurück.
#
# Aufruf: sudo bash i01-kurve-vmtest.sh /home/christian/i01/supervisor-e58.bundle
set -euo pipefail

BUNDLE=${1:?Pfad zum Bundle fehlt}
SHA=bafb27f3dd0220770ad0552a27db77c01e00c941
NEU=/opt/aio-supervisor/releases/${SHA:0:7}
ALT=$(readlink -f /opt/aio-supervisor/current)
KONFIG=/etc/aio/supervisor.json
BERICHT=/opt/aio-spikes/berichte/I01-kurve-vmtest.md
GRUND="VM-Test E58 (Supervisor-PR #28)"

[ "$(id -u)" = 0 ] || {
  echo "Bitte mit sudo starten"
  exit 1
}
umask 022
ergebnisse=()
gruen=ja
pruefe() { # Name, erwartet, ist
  local ok=FEHLER
  [ "$2" = "$3" ] && ok=ok
  [ "$ok" = ok ] || gruen=nein
  ergebnisse+=("| $1 | $2 | $3 | $ok |")
  echo "$ok: $1 (erwartet: $2, ist: $3)"
}
aio() { (cd / && sudo -u aio-sup /usr/bin/node /opt/aio-supervisor/current/packages/supervisor/src/cli.ts "$@"); }
# Feld aus `aioffice status --json`, z. B. quota.curveReleasedUntil oder die Schwelle von seven_day.
feld() {
  aio status --json | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const d = JSON.parse(s);
      const q = d.quota ?? null;
      const w = q?.windows?.find((x) => x.name === "seven_day") ?? null;
      const werte = {
        notaus: d.emergency,
        modus: q?.mode ?? "kein-kontingent",
        freigabe: q?.curveReleasedUntil ?? "keine",
        stand: w === null ? "keine-messung" : String(w.pct),
        schwelle: w === null ? "keine-messung" : String(Math.round(w.pausePct * 10) / 10),
      };
      console.log(werte[process.argv[1]]);
    });' "$1"
}
# Einträge im Audit-Log seit seq $1 mit kind $2 (nur lesen).
audit_seit() {
  sudo -u aio-sup /usr/bin/node -e '
    const { DatabaseSync } = require("node:sqlite");
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const db = new DatabaseSync(c.auditDbPath, { readOnly: true });
    const rows = db.prepare("SELECT seq, kind, actor, subject, data FROM audit_entries WHERE seq > ? AND kind LIKE ? ORDER BY seq").all(Number(process.argv[2]), process.argv[3]);
    for (const r of rows) console.log(JSON.stringify(r));
  ' "$KONFIG" "$1" "$2"
}
letzte_seq() {
  sudo -u aio-sup /usr/bin/node -e '
    const { DatabaseSync } = require("node:sqlite");
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const db = new DatabaseSync(c.auditDbPath, { readOnly: true });
    console.log(db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM audit_entries").get().m);
  ' "$KONFIG"
}
zurueck() {
  echo "Zurück auf $ALT"
  journalctl -u aio-supervisor -n 30 --no-pager | sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g'
  ln -sfn "$ALT" /opt/aio-supervisor/current
  systemctl restart aio-supervisor || true
}

echo "== Release $NEU anlegen (altes: $ALT)"
if [ ! -e "$NEU" ]; then
  ARBEIT=$(mktemp -d)
  trap 'rm -rf "$ARBEIT"' EXIT
  git clone -q --no-checkout "$BUNDLE" "$ARBEIT/repo"
  git -C "$ARBEIT/repo" checkout -q "$SHA"
  [ "$(git -C "$ARBEIT/repo" rev-parse HEAD)" = "$SHA" ]
  cmp "$ALT/pnpm-lock.yaml" "$ARBEIT/repo/pnpm-lock.yaml"
  mkdir "$NEU"
  git -C "$ARBEIT/repo" archive "$SHA" | tar -x -C "$NEU"
  cp -a "$ALT/node_modules" "$NEU/"
  if [ -d "$ALT/packages/supervisor/node_modules" ]; then
    cp -a "$ALT/packages/supervisor/node_modules" "$NEU/packages/supervisor/"
  fi
  chown -R --reference="$ALT" "$NEU"
  chmod --reference="$ALT" "$NEU"
fi
pruefe "Änderung im Release" ja "$(grep -q 'releaseCurve' "$NEU/packages/supervisor/src/quota/quota.ts" && echo ja || echo nein)"

echo "== Aktivieren und neu starten"
ln -sfn "$NEU" /opt/aio-supervisor/current
if ! systemctl restart aio-supervisor; then
  zurueck
  pruefe "Neustart" ok fehler
  exit 1
fi
ende=$((SECONDS + 90))
until aio status --json > /dev/null 2>&1 || [ $SECONDS -ge $ende ]; do sleep 2; done
pruefe "aio-supervisor aktiv" active "$(systemctl is-active aio-supervisor || true)"
if ! aio status --json > /dev/null 2>&1; then
  zurueck
  pruefe "aioffice status" ok fehler
  exit 1
fi

# Notaus-Stufe merken und auf Pause setzen, damit kein Lauf startet. Danach wiederherstellen.
STUFE=$(feld notaus)
declare -A CLI_STUFE=([none]=aus [pause]=pause [stop]=stopp [hard]=hart)
wiederherstellen() {
  aio kontingent-freigabe ende --grund "$GRUND: Aufräumen" > /dev/null 2>&1 || true
  if [ "$STUFE" != pause ]; then
    aio notaus "${CLI_STUFE[$STUFE]}" --grund "$GRUND: Stufe wie vorher" > /dev/null || true
  fi
}
trap 'wiederherstellen; rm -rf "${ARBEIT:-/nonexistent}"' EXIT
if [ "$STUFE" != pause ]; then
  aio notaus pause --grund "$GRUND: keine Läufe während des Tests" > /dev/null
fi
pruefe "Notaus während des Tests" pause "$(feld notaus)"

echo "== Vorher"
STAND=$(feld stand)
VORHER=$(feld schwelle)
echo "seven_day: Stand $STAND %, Pause ab $VORHER %, Modus $(feld modus)"
pruefe "vorher: keine Freigabe" keine "$(feld freigabe)"
pruefe "vorher: Schwelle unter 55 % (Tages-Zielkurve)" ja "$(/usr/bin/node -e 'console.log(Number(process.argv[1]) < 55 ? "ja" : "nein")' "$VORHER")"

echo "== Ungültige Eingaben"
rc=0
aio kontingent-freigabe 25 --grund x > /dev/null 2>&1 || rc=$?
pruefe "25 Stunden abgelehnt (Exit 2)" 2 "$rc"
rc=0
aio kontingent-freigabe ende --grund x > /dev/null 2>&1 || rc=$?
pruefe "ende ohne Freigabe abgelehnt (Exit 1)" 1 "$rc"

echo "== Freigabe für 1 Stunde"
SEQ=$(letzte_seq)
aio kontingent-freigabe 1 --grund "$GRUND" | grep -E "Freigabe|seven_day" || true
FREIGABE=$(feld freigabe)
echo "Freigabe bis $FREIGABE"
pruefe "mit Freigabe: Ende gesetzt" ja "$([ "$FREIGABE" != keine ] && echo ja || echo nein)"
pruefe "mit Freigabe: Schwelle 55 %" 55 "$(feld schwelle)"
pruefe "Audit: cost.curve_released von ceo:cli" ja "$(audit_seit "$SEQ" cost.curve_released | grep '"actor":"ceo:cli"' > /dev/null && echo ja || echo nein)"
ende=$((SECONDS + 90))
until audit_seit "$SEQ" 'notification.%' | grep 'kontingent:kurve:' > /dev/null || [ $SECONDS -ge $ende ]; do sleep 3; done
MAIL=$(audit_seit "$SEQ" 'notification.%' | grep 'kontingent:kurve:' | sed -E 's/.*"kind":"(notification\.[a-z_]+)".*/\1/' | sort -u | tr '\n' ' ' || true)
echo "Mail-Einträge: $MAIL"
pruefe "E-Mail verschickt (notification.sent)" ja "$(audit_seit "$SEQ" notification.sent | grep 'kontingent:kurve:' > /dev/null && echo ja || echo nein)"

echo "== Freigabe beenden"
aio kontingent-freigabe ende --grund "$GRUND: fertig" > /dev/null
pruefe "nach ende: keine Freigabe" keine "$(feld freigabe)"
pruefe "nach ende: Schwelle wie vorher" "$VORHER" "$(feld schwelle)"

echo "== Zustand nach Neustart (aus dem Audit-Log)"
systemctl restart aio-supervisor
ende=$((SECONDS + 90))
until aio status --json > /dev/null 2>&1 || [ $SECONDS -ge $ende ]; do sleep 2; done
pruefe "nach Neustart: aktiv" active "$(systemctl is-active aio-supervisor || true)"
pruefe "nach Neustart: keine Freigabe" keine "$(feld freigabe)"

wiederherstellen
trap 'rm -rf "${ARBEIT:-/nonexistent}"' EXIT
pruefe "Notaus wie vorher" "$STUFE" "$(feld notaus)"

{
  echo "# VM-Test Supervisor-PR #28 (Tages-Zielkurve aussetzen, E58)"
  echo
  echo "$(date '+%Y-%m-%d %H:%M %Z'), Release $NEU (vorher $ALT). seven_day bei $STAND %, Kurve $VORHER %."
  echo
  echo "| Prüfung | erwartet | ist | Ergebnis |"
  echo "|---|---|---|---|"
  printf '%s\n' "${ergebnisse[@]}"
  echo
  echo "Gesamt: **$([ $gruen = ja ] && echo grün || echo rot)**. Das neue Release bleibt aktiv; Rückweg: \`ln -sfn $ALT /opt/aio-supervisor/current && systemctl restart aio-supervisor\`."
} > "$BERICHT"
chmod 0644 "$BERICHT"
echo
cat "$BERICHT"
[ $gruen = ja ]
