#!/usr/bin/env bash
# VM-Test zum Supervisor-PR #30 „voller Push-Grund, ehrliche Kontingent-Anzeige, Weisungen im
# Audit-Log“ (E65, E67, E68), Funde aus der Abnahme I01, AK 2.
#
# Zweck: Den Supervisor mit den Änderungen in aio-dev aktivieren und zeigen, dass er startet und
# die neuen Teile im Release wirken:
# - E65: `pushReason` aus dem Release liefert für eine typische Ablehnung von GitHub die Zeile
#   `[remote rejected] …` und die Zeilen `remote:`, ohne Token.
# - E67: `aioffice status` sagt „nicht lesbar“ nur, wenn die letzte Messung ein Problem hatte.
# - E68: Der Socket kennt `directive.report`. Geprüft mit einer ungültigen Meldung als Nutzer
#   `aio-office`: Antwort `invalid_params`, nicht `unknown_method`. So entsteht keine erfundene
#   Weisung im Audit-Log, nur ein abgelehnter Eintrag `ipc.call`.
#
# Kein Lauf, kein LLM-Aufruf. Scheitert der Start des neuen Release, schaltet das Skript zurück.
#
# Aufruf: sudo bash i01-funde-sup-vmtest.sh /home/christian/i01/supervisor-funde.bundle <sha>
set -euo pipefail

BUNDLE=${1:?Pfad zum Bundle fehlt}
SHA=${2:?Commit fehlt}
NEU=/opt/aio-supervisor/releases/${SHA:0:7}
ALT=$(readlink -f /opt/aio-supervisor/current)
KONFIG=/etc/aio/supervisor.json
BERICHT=/opt/aio-spikes/berichte/I01-funde-sup-vmtest.md

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
SRC=$NEU/packages/supervisor/src
pruefe "Änderung im Release" ja "$(grep -q '"directive.report"' "$SRC/ipc/protocol.ts" && [ -f "$SRC/quota/mode-text.ts" ] && echo ja || echo nein)"

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

echo "== E65: Grund einer Push-Ablehnung"
GRUND=$(cd / && sudo -u aio-sup /usr/bin/node --input-type=module -e '
  const { pushReason } = await import(process.argv[1]);
  const out = "To https://github.com/o/r.git\n!\tabc:refs/heads/agent/r-1\t[remote rejected] (refusing to allow a GitHub App to create or update workflow without workflows permission)\nDone\n";
  const err = "remote: error: GH013: Repository rule violations found.\nerror: failed to push some refs to https://x-access-token:ghs_abcdefghijklmnopqrstuvwx@github.com/o/r.git\n";
  console.log(pushReason(out, err));
' "$SRC/git-gate/git.ts")
echo "Grund: $GRUND"
pruefe "nennt [remote rejected]" ja "$(grep -q 'remote rejected' <<< "$GRUND" && echo ja || echo nein)"
pruefe "nennt die Zeile remote:" ja "$(grep -q 'GH013' <<< "$GRUND" && echo ja || echo nein)"
pruefe "ohne Token" ja "$(grep -q 'ghs_' <<< "$GRUND" && echo nein || echo ja)"

echo "== E67: Anzeige des Kontingents"
STATUS=$(aio status)
ZEILE=$(grep '^Kontingent:' <<< "$STATUS" || echo "Kontingent: (keine Zeile)")
PROBLEM=$(aio status --json | /usr/bin/node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const q = JSON.parse(s).quota ?? null;
    console.log(q === null ? "kein-kontingent" : (q.problem ?? "keins"));
  });')
echo "$ZEILE"
echo "Problem der letzten Messung: $PROBLEM"
if [ "$PROBLEM" = keins ]; then
  pruefe "ohne Problem kein „nicht lesbar“" ja "$(grep -q 'nicht lesbar' <<< "$ZEILE" && echo nein || echo ja)"
else
  pruefe "mit Problem „nicht lesbar“ samt Grund" ja "$(grep -q 'nicht lesbar (' <<< "$ZEILE" && echo ja || echo nein)"
fi

echo "== E68: directive.report am Socket"
SOCKET=$(/usr/bin/node -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(c.ipc?.socketPath ?? "/run/aio/supervisor.sock")' "$KONFIG")
ANTWORT=$(cd / && sudo -u aio-office /usr/bin/node -e '
  const net = require("node:net");
  const s = net.createConnection(process.argv[1]);
  let buf = "";
  s.on("connect", () => s.write(JSON.stringify({ v: 1, id: "vmtest-e68", method: "directive.report", params: { action: "issued" } }) + "\n"));
  s.on("data", (d) => {
    buf += d;
    if (buf.includes("\n")) {
      const r = JSON.parse(buf.split("\n")[0]);
      console.log(r.ok ? "ok" : r.error.code);
      s.end();
    }
  });
  s.on("error", (e) => { console.log("fehler: " + e.message); });
  setTimeout(() => { console.log("zeitueberschreitung"); process.exit(0); }, 10000).unref();
' "$SOCKET")
pruefe "Socket kennt directive.report (ungültige Meldung abgelehnt)" invalid_params "$ANTWORT"

{
  echo "# VM-Test Supervisor-PR #30 (E65, E67, E68)"
  echo
  echo "$(date '+%Y-%m-%d %H:%M %Z'), Release $NEU (vorher $ALT)."
  echo
  echo "| Prüfung | erwartet | ist | Ergebnis |"
  echo "|---|---|---|---|"
  printf '%s\n' "${ergebnisse[@]}"
  echo
  echo "Anzeige: \`$ZEILE\`"
  echo
  echo "Gesamt: **$([ $gruen = ja ] && echo grün || echo rot)**. Das neue Release bleibt aktiv; Rückweg: \`ln -sfn $ALT /opt/aio-supervisor/current && systemctl restart aio-supervisor\`."
} > "$BERICHT"
chmod 0644 "$BERICHT"
echo
cat "$BERICHT"
[ $gruen = ja ]
