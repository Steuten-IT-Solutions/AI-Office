#!/usr/bin/env bash
# Abnahme I01, AK 1 (Kernkreislauf): Merge-Gate für das Repo des Office einschalten.
#
# Zweck: Für AK 1 soll der Supervisor einen PR des Office nach dem Approve des CEO selbst mergen
# und danach ausliefern (plan.md Kap. 7.4 Nr. 1). Dafür braucht /etc/aio/supervisor.json den
# Abschnitt `mergeGate` für das Repo aus `deploy.repo` (S09). Der Branch-Schutz bleibt auf Stufe
# 5.2, die App `aio-supervisor` steht zusätzlich in der Push-Liste (Entscheidung des CEO vom
# 24.11.2026). Kein LLM-Aufruf. Scheitert der Neustart, stellt das Skript die Konfiguration wieder
# her.
#
# Aufruf: sudo bash i01-ak1-vorbereiten.sh
# Rückgängig: sudo bash i01-ak1-vorbereiten.sh zurueck
set -euo pipefail

KONFIG=/etc/aio/supervisor.json
SICHER=/etc/aio/supervisor.json.vor-i01-ak1
CEO_ID=41518029

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
  neu_starten
  echo "Konfiguration von vor AK 1 wiederhergestellt, Supervisor läuft"
  exit 0
fi

[ -e "$SICHER" ] || cp -a "$KONFIG" "$SICHER"
echo "== Sicherung: $SICHER"

# Repo aus deploy.repo, Schreibweise wie in runs.repos (die Prüfung in config.ts verlangt den
# Eintrag dort). Bestehende mergeGate-Werte bleiben, nur repos und ceoUserId werden gesetzt.
/usr/bin/node -e '
  const fs = require("node:fs");
  const [path, ceo] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(path, "utf8"));
  const repo = c.deploy?.repo;
  if (typeof repo !== "string") throw new Error("deploy.repo fehlt");
  const key = Object.keys(c.runs?.repos ?? {}).find((r) => r.toLowerCase() === repo.toLowerCase());
  if (key === undefined) throw new Error(`${repo} fehlt in runs.repos`);
  if (c.gitGate === undefined) throw new Error("gitGate fehlt");
  c.mergeGate = { ...(c.mergeGate ?? {}), repos: [key], ceoUserId: Number(ceo) };
  fs.writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
  console.log(JSON.stringify({ mergeGate: c.mergeGate, identities: c.gitGate.identities ?? {} }));
' "$KONFIG" "$CEO_ID"

echo "== Supervisor neu starten"
if ! neu_starten; then
  echo "Neustart gescheitert, stelle die Konfiguration wieder her"
  journalctl -u aio-supervisor -n 20 --no-pager | sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g'
  cp -a "$SICHER" "$KONFIG"
  neu_starten || true
  exit 1
fi
journalctl -u aio-supervisor --since "-2 min" --no-pager | grep -i -E "merge|gate" | tail -5 || true
aio status --json | /usr/bin/node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const d = JSON.parse(s);
    console.log(JSON.stringify({ notaus: d.emergency ?? d.notaus, deploy: d.deploy?.last ?? null }));
  });' || true
echo "Merge-Gate für AK 1 eingeschaltet"
