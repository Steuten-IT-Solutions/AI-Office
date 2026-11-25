#!/usr/bin/env bash
# Abnahme I01, AK 10: Läuft das System nach einem Neustart ohne Eingriff wieder an?
#
# Zweck: Zustand von aio-dev vor und nach einem Neustart (VM oder Windows) ohne sudo erfassen,
# damit der Vergleich zeigt, dass alle Dienste von selbst wieder laufen (plan.md Kap. 7.4 Nr. 10,
# etappe-0.md Kap. 1.1). Ändert nichts, kein LLM-Aufruf.
#
# Aufruf: bash i01-ak10-pruefen.sh [vorher|nachher]   (schreibt ~/i01/ak10-<name>.txt)
set -uo pipefail

NAME=${1:-stand}
AUS="$HOME/i01/ak10-$NAME.txt"
mkdir -p "$HOME/i01"
{
  echo "# AK 10 $NAME, $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "boot: $(uptime -s) (uptime $(uptime -p))"
  echo "kernel: $(uname -r)"
  echo
  echo "## Dienste"
  for u in docker aio-nftables nftables aio-supervisor aio-office aio-sicherung.timer; do
    printf '%-22s %-10s %s\n' "$u" "$(systemctl is-active "$u" 2> /dev/null)" \
      "$(systemctl show "$u" -p NRestarts -p ActiveEnterTimestamp --value 2> /dev/null | tr '\n' ' ')"
  done
  echo
  echo "## Fehlgeschlagene Units"
  systemctl --failed --no-legend --plain 2> /dev/null || true
  echo
  echo "## Ports"
  ss -ltnH 2> /dev/null | awk '{print $4}' | sort -u | grep -E ':(22|3000|3128|8080|8443|8444)$' || true
  echo
  echo "## Webinterface und Konsole (Statuscode, aus der VM)"
  for h in office.aio.internal:8444 konsole.aio-sup.internal:8443; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      --cacert /usr/local/share/aio/aio-ca.crt \
      --resolve "${h%%:*}:${h##*:}:192.168.207.10" "https://$h/" 2> /dev/null)
    echo "$h $code"
  done
  echo
  echo "## Supervisor seit dem Boot (Auszug)"
  journalctl -u aio-supervisor -b --no-pager -o cat 2> /dev/null |
    sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g' |
    grep -E -i 'Admission geladen|Office gestartet|nicht gestartet|Merge-Gate|Gesundheit|health|Fehler|error|timed out' |
    tail -15 || true
  echo
  echo "## Office seit dem Boot (Auszug)"
  journalctl -u aio-office -b --no-pager -o cat 2> /dev/null |
    sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g' | tail -8 || true
} > "$AUS" 2>&1
cat "$AUS"
