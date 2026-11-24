#!/usr/bin/env bash
# Abnahme I01, AK 6 und AK 7: E-Mail-Benachrichtigung des Supervisors einrichten (S14, E37).
#
# Zweck: Der Supervisor soll den CEO per E-Mail warnen (Weckbudget, Schutzschalter, Kontingent).
# Dafür braucht /etc/aio/supervisor.json den Abschnitt `notification` und
# /etc/aio/secrets/smtp-passwort das Passwort des Absenderpostfachs (E18: nur dort, Modus 0600,
# Besitzer aio-sup). Das Skript fragt das Passwort ohne Anzeige ab; es steht nie in Argumenten,
# Umgebung oder Ausgabe. Danach startet es den Supervisor neu und schickt eine Testmail.
# Scheitert der Neustart, stellt es die Konfiguration wieder her. Kein LLM-Aufruf.
#
# Server: IONOS (smtp.ionos.de, Port 465, SSL/TLS, Benutzername = volle Adresse), siehe
# https://www.ionos.de/hilfe/e-mail/allgemeine-themen/serverinformationen-fuer-imap-pop3-und-smtp/
#
# Aufruf:      sudo bash i01-mail-einrichten.sh ABSENDER EMPFAENGER
# Rückgängig:  sudo bash i01-mail-einrichten.sh zurueck
set -euo pipefail

KONFIG=/etc/aio/supervisor.json
SICHER=/etc/aio/supervisor.json.vor-i01-mail
PASSWORT=/etc/aio/secrets/smtp-passwort
HOST=smtp.ionos.de

[ "$(id -u)" = 0 ] || {
  echo "Bitte mit sudo starten"
  exit 1
}
aio() { (cd / && sudo -u aio-sup /usr/bin/node /opt/aio-supervisor/current/packages/supervisor/src/cli.ts "$@"); }
neu_starten() {
  systemctl restart aio-supervisor || return 1
  local ende=$((SECONDS + 90))
  while [ $SECONDS -lt $ende ]; do
    if systemctl is-active --quiet aio-supervisor && aio status --json > /dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [ "${1:-}" = zurueck ]; then
  [ -f "$SICHER" ] || {
    echo "Keine Sicherung $SICHER"
    exit 1
  }
  cp -a "$SICHER" "$KONFIG"
  shred -u "$PASSWORT" 2> /dev/null || rm -f "$PASSWORT"
  neu_starten
  echo "Konfiguration von vor der Mail-Einrichtung wiederhergestellt, Passwortdatei gelöscht"
  exit 0
fi

VON=${1:?Absenderadresse fehlt}
AN=${2:?Empfängeradresse fehlt}
for a in "$VON" "$AN"; do
  [[ $a =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || {
    echo "Keine E-Mail-Adresse: $a"
    exit 1
  }
done

[ -t 0 ] || {
  echo "Bitte in einem Terminal starten (Passwortabfrage)"
  exit 1
}
read -r -s -p "Passwort (oder App-Passwort) für $VON: " pw1
echo
read -r -s -p "Noch einmal: " pw2
echo
[ "$pw1" = "$pw2" ] && [ -n "$pw1" ] || {
  echo "Leer oder nicht gleich, nichts geändert"
  exit 1
}
umask 077
tmp=$(mktemp /etc/aio/secrets/.smtp-passwort.XXXXXX)
printf '%s\n' "$pw1" > "$tmp"
unset pw1 pw2
chown aio-sup:aio-sup "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$PASSWORT"
echo "== Passwort in $PASSWORT (aio-sup, 0600)"

[ -e "$SICHER" ] || cp -a "$KONFIG" "$SICHER"
echo "== Sicherung: $SICHER"
umask 022
/usr/bin/node -e '
  const fs = require("node:fs");
  const [path, from, to, host] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(path, "utf8"));
  const old = c.notification ?? {};
  c.notification = {
    ...old,
    to,
    from,
    smtp: { host, port: 465, security: "tls", username: from },
  };
  fs.writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
  console.log(JSON.stringify({ notification: { ...c.notification } }));
' "$KONFIG" "$VON" "$AN" "$HOST"

echo "== Supervisor neu starten"
if ! neu_starten; then
  echo "Neustart gescheitert, stelle die Konfiguration wieder her"
  journalctl -u aio-supervisor -n 20 --no-pager | sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g'
  cp -a "$SICHER" "$KONFIG"
  neu_starten || true
  exit 1
fi
journalctl -u aio-supervisor --since "-2 min" --no-pager -o cat | grep -i -E "benachrichtigung|notification|mail" | tail -3 || true

echo "== Testmail"
if aio testmail; then
  echo "Testmail verschickt, bitte im Postfach von $AN nachsehen (auch im Spam-Ordner)"
else
  echo "Testmail gescheitert; Konfiguration bleibt, Rückweg: sudo bash $0 zurueck"
  exit 1
fi
