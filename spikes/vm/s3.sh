#!/usr/bin/env bash
# Spike S3 – Statik in der VM aio-dev (docs/etappe-0.md Kap. 3.3).
#
# Zweck: RAM, CPU und Platte je Lauf messen und daraus die Statik ableiten, also wie viele Läufe
# gleichzeitig laufen dürfen. Die Messung nutzt die Bausteine des installierten Supervisors, läuft
# aber neben ihm (eigene Netze, Arbeitsbereiche und Registry-Cache unter /opt/aio-spikes/s3) und
# ändert nichts am Betrieb. Kosten: drei kurze haiku-Läufe.
#
# Aufruf: sudo bash s3.sh
# Das Skript startet sich selbst als systemd-Unit aio-s3 im Hintergrund (Dauer etwa 30–60 min),
# damit die SSH-Sitzung offen oder geschlossen sein darf. Fortschritt:
#   tail -f /opt/aio-spikes/s3/s3.log
# Abbrechen (räumt auf): sudo systemctl stop aio-s3
# Ergebnis: /opt/aio-spikes/berichte/S3-bericht.md und S3-messwerte.json (ohne Geheimnisse).
#
# Teile einzeln (Standard alle): sudo env AIO_S3_TEILE=a,d bash s3.sh
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S3=/opt/aio-spikes/s3
LOG="$S3/s3.log"

[ "$(id -u)" -eq 0 ] || {
  echo "Bitte mit sudo starten: sudo bash $0"
  exit 1
}

if [ "${1:-}" != "--vordergrund" ]; then
  if systemctl is-active --quiet aio-s3; then
    echo "S3 läuft schon. Fortschritt: tail -f $LOG"
    exit 1
  fi
  systemctl reset-failed aio-s3 2> /dev/null || true
  install -d -m 0755 -o root -g root /opt/aio-spikes "$S3"
  : > "$LOG"
  chmod 0644 "$LOG"
  systemd-run --unit=aio-s3 --description="Spike S3 Statik" --collect --setenv=HOME=/root \
    --setenv=AIO_S3_TEILE="${AIO_S3_TEILE:-a,b,c,d}" \
    --setenv=AIO_S3_PARALLEL="${AIO_S3_PARALLEL:-2,4,6,8}" \
    /usr/bin/bash "$HIER/s3.sh" --vordergrund > /dev/null
  echo "S3 läuft jetzt im Hintergrund (etwa 30–60 min)."
  echo "Fortschritt: tail -f $LOG"
  exit 0
fi

exec >> "$LOG" 2>&1
echo "== $(date -u +%FT%TZ) Spike S3 beginnt"
/usr/bin/node --version | grep -q '^v24\.' || {
  echo "FEHLER: /usr/bin/node ist nicht Node 24"
  exit 1
}
command -v docker > /dev/null || {
  echo "FEHLER: docker fehlt"
  exit 1
}
systemctl is-active --quiet aio-supervisor || echo "Hinweis: aio-supervisor läuft nicht"
install -d -m 0755 -o root -g root /opt/aio-spikes/berichte
cd /
exec /usr/bin/node "$HIER/s3/messung.js"
