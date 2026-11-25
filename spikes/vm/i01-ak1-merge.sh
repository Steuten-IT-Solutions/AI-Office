#!/usr/bin/env bash
# Abnahme I01, AK 1 (Kernkreislauf), Schluss: Supervisor-PR #29 einspielen und Merge, Auslieferung
# und Health-Check von AI-Office-PR #49 beobachten.
#
# Zweck: Bisher merged das Merge-Gate nur nach `request_merge` aus einem späteren Lauf, und kein
# Weckgrund holte den Agenten dafür zurück (Fund aus AK 1). Mit PR #29 gilt jeder PR aus einer
# Übergabe als beantragt (E59). Nach dem Einspielen übernimmt das Gate PR #49 beim Start, sieht
# das Approve des CEO auf dem Kopf und merged. Danach liefert der Auslieferer den Merge-Commit aus
# und prüft ihn mit dem Health-Check. Das Skript beobachtet das nur und schreibt einen Bericht.
# Kein LLM-Aufruf durch das Skript. Scheitert der Start, schaltet es auf das alte Release zurück.
#
# Aufruf: sudo bash i01-ak1-merge.sh /home/christian/i01/supervisor-e59.bundle
set -euo pipefail

BUNDLE=${1:?Pfad zum Bundle fehlt}
SHA=207b3c082d0510be1aad82f9268d9af493de25b3
PR=49
NEU=/opt/aio-supervisor/releases/${SHA:0:7}
ALT=$(readlink -f /opt/aio-supervisor/current)
KONFIG=/etc/aio/supervisor.json
BERICHT=/opt/aio-spikes/berichte/I01-ak1.md

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
# Feld aus `aioffice status --json`.
feld() {
  aio status --json | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const d = JSON.parse(s);
      const werte = {
        current: d.deploy?.current?.sha ?? "keins",
        last_sha: d.deploy?.last?.sha ?? "keins",
        last_result: d.deploy?.last?.result ?? "keins",
        last_reason: d.deploy?.last?.reason ?? "",
        active: d.deploy?.active === null || d.deploy?.active === undefined ? "nein" : `${d.deploy.active.sha} ${d.deploy.active.phase}`,
        lock: d.deploy?.mergeLock === null || d.deploy?.mergeLock === undefined ? "keine" : d.deploy.mergeLock.reason,
        health: d.health?.last === null || d.health?.last === undefined ? "keiner" : `${d.health.last.verdict} (${d.health.last.at}, ${d.health.last.failed.length} gescheitert)`,
        notaus: d.emergency,
      };
      console.log(werte[process.argv[1]]);
    });' "$1"
}
# Letzter `git.merged` zu PR $2 seit seq $1: „mergeSha verified“, sonst leer.
gemergt() {
  sudo -u aio-sup /usr/bin/node -e '
    const { DatabaseSync } = require("node:sqlite");
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const db = new DatabaseSync(c.auditDbPath, { readOnly: true });
    const rows = db.prepare("SELECT data FROM audit_entries WHERE seq > ? AND kind = ? ORDER BY seq").all(Number(process.argv[2]), "git.merged");
    for (const r of rows) {
      const d = JSON.parse(r.data);
      if (d.pr === Number(process.argv[3])) console.log(`${d.mergeSha} ${d.verified === true ? "ja" : "nein"}`);
    }
  ' "$KONFIG" "$1" "$2" | tail -1
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
pruefe "Änderung im Release" ja "$(grep 'PR als Antrag übernommen' "$NEU/packages/supervisor/src/merge-gate/gate.ts" > /dev/null && echo ja || echo nein)"
pruefe "Notaus vorher aus" none "$(feld notaus)"
CURRENT_VORHER=$(feld current)
echo "Ausgeliefert vorher: $CURRENT_VORHER"

echo "== Aktivieren und neu starten"
SEQ=$(letzte_seq)
START=$(date '+%Y-%m-%d %H:%M:%S')
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

echo "== PR #$PR als Antrag übernommen?"
ende=$((SECONDS + 60))
until journalctl -u aio-supervisor --since "$START" --no-pager -o cat | grep 'PR als Antrag übernommen' | grep "\"pr\":$PR" > /dev/null || [ $SECONDS -ge $ende ]; do sleep 3; done
pruefe "PR #$PR übernommen (Journal)" ja "$(journalctl -u aio-supervisor --since "$START" --no-pager -o cat | grep 'PR als Antrag übernommen' | grep "\"pr\":$PR" > /dev/null && echo ja || echo nein)"

echo "== Merge (bis 5 Minuten, Takt 60 s)"
ende=$((SECONDS + 300))
until [ -n "$(gemergt "$SEQ" "$PR")" ] || [ $SECONDS -ge $ende ]; do sleep 10; done
MERGE=$(gemergt "$SEQ" "$PR")
echo "git.merged: ${MERGE:-keiner}"
MSHA=${MERGE%% *}
pruefe "PR #$PR gemergt (git.merged)" ja "$([ -n "$MSHA" ] && echo ja || echo nein)"
pruefe "Baum geprüft (verified)" ja "${MERGE##* }"
if [ -z "$MSHA" ]; then
  echo "Wartegrund laut Journal:"
  journalctl -u aio-supervisor --since "$START" --no-pager -o cat | grep -i 'merge-gate' | tail -10 || true
else
  echo "== Auslieferung von $MSHA (bis 20 Minuten)"
  ende=$((SECONDS + 1200))
  while [ $SECONDS -lt $ende ]; do
    if [ "$(feld last_sha)" = "$MSHA" ] && [ "$(feld active)" = nein ]; then
      break
    fi
    sleep 15
  done
  echo "Auslieferer: zuletzt $(feld last_sha) $(feld last_result) $(feld last_reason); aktiv: $(feld active)"
  pruefe "Auslieferung Ergebnis" ausgeliefert "$(feld last_result)"
  pruefe "Ausgeliefert ist der Merge-Commit" "$MSHA" "$(feld current)"
  pruefe "keine Merge-Sperre" keine "$(feld lock)"
  pruefe "aio-office aktiv" active "$(systemctl is-active aio-office || true)"
  echo "Health-Check: $(feld health)"
  journalctl -u aio-supervisor --since "$START" --no-pager -o cat | grep -E 'Auslieferer|Health|Prüflauf|Release' | sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g' | tail -15 || true
fi

{
  echo "# Abnahme I01, AK 1: Merge, Auslieferung und Health-Check von PR #$PR"
  echo
  echo "$(date '+%Y-%m-%d %H:%M %Z'), Supervisor-Release $NEU (vorher $ALT). Ausgeliefert vorher: $CURRENT_VORHER."
  echo
  echo "| Prüfung | erwartet | ist | Ergebnis |"
  echo "|---|---|---|---|"
  printf '%s\n' "${ergebnisse[@]}"
  echo
  echo "Merge-Commit: ${MSHA:-keiner}. Health-Check: $(feld health)."
  echo
  echo "Gesamt: **$([ $gruen = ja ] && echo grün || echo rot)**. Das neue Supervisor-Release bleibt aktiv; Rückweg: \`ln -sfn $ALT /opt/aio-supervisor/current && systemctl restart aio-supervisor\`."
} > "$BERICHT"
chmod 0644 "$BERICHT"
echo
cat "$BERICHT"
[ $gruen = ja ]
