#!/usr/bin/env bash
# VM-Test zum Supervisor-PR #27 „Office beim Start des Supervisors ohne Warten starten“, Fund aus
# der Abnahme I01 (AK 12, betrifft auch AK 10).
#
# Zweck: Den Supervisor mit der Änderung in aio-dev aktivieren und zeigen, dass er bei gestopptem
# Office ohne Timeout startet und das Office danach selbst startet. Vorher blockierten sich beide
# 60 s (TimeoutStartSec), dann startete systemd den Supervisor neu.
# Kein LLM-Aufruf. Scheitert der Start, schaltet das Skript auf das alte Release zurück.
# Ist alles grün, startet es danach Teil AK 12 der Abnahme neu (i01.sh im selben Ordner).
#
# Aufruf: sudo bash i01-start-vmtest.sh /home/christian/i01/supervisor-i01.bundle
set -euo pipefail

BUNDLE=${1:?Pfad zum Bundle fehlt}
SHA=a8595d71487f0116bc9e2d0b07be768e273fdbda
NEU=/opt/aio-supervisor/releases/${SHA:0:7}
ALT=$(readlink -f /opt/aio-supervisor/current)
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BERICHT=/opt/aio-spikes/berichte/I01-start-vmtest.md

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
sup() { systemctl show aio-supervisor --property="$1" --value; }
office() { systemctl show aio-office --property="$1" --value; }
zurueck() {
  echo "Zurück auf $ALT"
  journalctl -u aio-supervisor -n 30 --no-pager | sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g'
  ln -sfn "$ALT" /opt/aio-supervisor/current
  systemctl restart aio-supervisor || true
  systemctl start --no-block aio-office || true
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
pruefe "Änderung im Release" ja "$(grep -q '"--no-block"' "$NEU/packages/supervisor/src/deploy/office-unit.ts" && echo ja || echo nein)"

echo "== Teil 1: aktivieren und neu starten, Office läuft"
ln -sfn "$NEU" /opt/aio-supervisor/current
if ! systemctl restart aio-supervisor; then
  zurueck
  pruefe "Teil 1: Neustart" ok fehler
  exit 1
fi
pruefe "Teil 1: aio-supervisor aktiv" active "$(systemctl is-active aio-supervisor || true)"
pruefe "Teil 1: aioffice status" ok "$(aio status --json > /dev/null 2>&1 && echo ok || echo fehler)"

echo "== Teil 2: Office stoppen, Supervisor neu starten (wie nach Rücksicherung und Boot)"
systemctl stop aio-office
pruefe "Teil 2: Office gestoppt" inactive "$(office ActiveState)"
neustarts=$(sup NRestarts)
t0=$(date +%s)
rc=0
systemctl restart aio-supervisor || rc=$?
t1=$(date +%s)
pruefe "Teil 2: systemctl restart aio-supervisor" 0 "$rc"
pruefe "Teil 2: Start ohne Timeout (< 30 s)" ja "$([ $((t1 - t0)) -lt 30 ] && echo ja || echo nein)"
echo "Dauer des Starts: $((t1 - t0)) s"
pruefe "Teil 2: kein Neustart durch systemd" "$neustarts" "$(sup NRestarts)"
ende=$((SECONDS + 60))
while [ $SECONDS -lt $ende ] && [ "$(office ActiveState)" != active ]; do sleep 1; done
pruefe "Teil 2: Office läuft wieder" active "$(office ActiveState)"
echo "Office aktiv nach etwa $((SECONDS - (ende - 60))) s"
sleep 10
pruefe "Teil 2: Office läuft stabil" active "$(office ActiveState)"
journalctl -u aio-supervisor --since "-3 min" --no-pager | grep -E "timed out|nicht gestartet|Office gestartet|gestartet" | tail -5 || true
if [ "$rc" != 0 ] || [ "$(systemctl is-active aio-supervisor || true)" != active ]; then
  zurueck
fi

{
  echo "# VM-Test Supervisor-PR #27 (Office beim Start ohne Warten, Fund aus I01)"
  echo
  echo "$(date '+%Y-%m-%d %H:%M %Z'), Release $NEU (vorher $ALT)."
  echo
  echo "| Prüfung | erwartet | ist | Ergebnis |"
  echo "|---|---|---|---|"
  printf '%s\n' "${ergebnisse[@]}"
  echo
  echo "Dauer des Starts bei gestopptem Office: $((t1 - t0)) s. Gesamt: **$([ $gruen = ja ] && echo grün || echo rot)**."
} > "$BERICHT"
chmod 0644 "$BERICHT"
echo
cat "$BERICHT"
if [ $gruen = ja ]; then
  echo
  echo "== Abnahme AK 12 neu starten"
  AIO_I01_TEILE=ak12 bash "$HIER/i01.sh"
fi
[ $gruen = ja ]
