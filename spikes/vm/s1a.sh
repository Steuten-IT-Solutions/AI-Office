#!/usr/bin/env bash
# Spike S1a: Kann Bash im Lauf-Container das setup-token lesen? (docs/etappe-0.md 3.1)
#
# Ablauf je Variante (sandbox = Plan, streng = ohne enableWeakerNestedSandbox, nur Information):
#  1. Container gehärtet wie Kap. 4.7 starten, Token in seiner Umgebung (wie beim echten Lauf).
#  2. Positivkontrollen per docker exec ohne Sandbox: Die Probe muss das Token in der Umgebung,
#     in /proc/1/environ und in einer Testdatei finden. Sonst ist die Messung ungültig.
#  3. bubblewrap direkt aufrufen (Diagnose: Startet die Sandbox in Docker überhaupt?).
#  4. Ein claude -p-Lauf (haiku, --max-turns 3), der nur die Probe ausführt.
# Kosten: zwei kurze haiku-Läufe.
# Aufruf: sudo bash s1a.sh
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten
pruefe_token
pruefe_image sandbox
pruefe_image streng

dir="$DATEN/s1a"
arbeitsverzeichnis "$dir"
trap 'docker rm -f aio-spike-s1a aio-spike-s1a-streng > /dev/null 2>&1 || true' EXIT
image_kontext sandbox > "$dir/kontext.txt"
chmod 0644 "$dir/kontext.txt"

starten() {
  local name="$1" variante="$2"
  docker rm -f "$name" > /dev/null 2>&1 || true
  mit_token docker run -d --name "$name" "${LAUF_HAERTUNG[@]}" \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -e "AIO_ERWARTET_SHA256=$(cat "$TOKEN_HASH_DATEI")" \
    -v "$dir:/work" \
    "$IMAGE:$variante" sleep infinity > /dev/null
}

kontrollen() {
  local name="$1" label="$2"
  docker exec "$name" bash /opt/spike/probe/probe.sh "$label" > /dev/null
  # Testdatei mit dem Token, nur für die Kontrolle; danach sofort gelöscht.
  docker exec "$name" sh -c 'printf %s "$CLAUDE_CODE_OAUTH_TOKEN" > /tmp/kontrolle-token'
  docker exec "$name" bash /opt/spike/probe/probe.sh "$label-datei" > /dev/null
  docker exec "$name" rm -f /tmp/kontrolle-token
}

info "Variante sandbox (Plan): Container und Kontrollen"
starten aio-spike-s1a sandbox
kontrollen aio-spike-s1a kontrolle

info "bubblewrap direkt im Container"
{
  echo "\$ bwrap --unshare-all --proc /proc (eigenes /proc)"
  docker exec aio-spike-s1a bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all \
    --die-with-parent true 2>&1 && echo "Exit 0" || echo "Exit $?"
  echo "\$ bwrap --unshare-all --bind /proc /proc (vorhandenes /proc, wie enableWeakerNestedSandbox)"
  docker exec aio-spike-s1a bwrap --ro-bind / / --dev /dev --bind /proc /proc --unshare-all \
    --die-with-parent true 2>&1 && echo "Exit 0" || echo "Exit $?"
} | maske > "$dir/bwrap.txt"
cat "$dir/bwrap.txt"

info "Lauf mit claude -p (haiku)"
docker exec -w /work aio-spike-s1a node /opt/spike/spikes/vm/src/s1a.ts lauf claude || true

info "Variante streng (nur Information)"
starten aio-spike-s1a-streng streng
kontrollen aio-spike-s1a-streng kontrolle-streng
docker exec -w /work aio-spike-s1a-streng node /opt/spike/spikes/vm/src/s1a.ts lauf streng || true

info "Auswertung"
docker exec aio-spike-s1a node /opt/spike/spikes/vm/src/s1a.ts bericht /work /work/kontext.txt
bericht_ablegen "$dir/S1a-bericht.md" S1a-bericht.md
