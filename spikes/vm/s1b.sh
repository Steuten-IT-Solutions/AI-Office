#!/usr/bin/env bash
# Spike S1b: Endpunkte des CLI und TLS-terminierender Proxy mit Allowlist (docs/etappe-0.md 3.1)
#
#  1. Lauf-Netz ohne Weg nach außen, mitmproxy als einziger Ausgang, Modus „protokoll“.
#  2. Durchgang 1: drei typische Läufe (nur Text, mit Werkzeugen, mit lokalem MCP-Server).
#     Protokolliert werden nur Host, Methode und Pfad (ohne Query, Header und Inhalte).
#  3. Allowlist aus Durchgang 1 erzeugen.
#  4. Durchgang 2 mit Allowlist und Prüfung der Anmeldung (nur unser Token), danach Anfragen mit
#     fremdem Schlüssel, auf die Files-API und an einen fremden Host. Alle müssen scheitern.
# Kosten: sechs kurze haiku-Läufe.
# Aufruf: sudo bash s1b.sh   (AIO_SANDBOX=ohne, falls S1a zeigt, dass die Sandbox nicht startet)
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten
pruefe_token
variante="${AIO_SANDBOX:-sandbox}"
pruefe_image "$variante"

dir="$DATEN/s1b"
netz="aio-spike-s1b"
arbeitsverzeichnis "$dir"
install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_UID" "$dir/work"
aufraeumen() {
  docker rm -f "$PROXY" > /dev/null 2>&1 || true
  docker network rm "$netz" "$NETZ_AUSSEN" > /dev/null 2>&1 || true
}
trap aufraeumen EXIT
image_kontext "$variante" > "$dir/kontext.txt"

netz_anlegen "$NETZ_AUSSEN" aussen
netz_anlegen "$netz" intern
proxy_addon "$dir"

lauf() {
  mit_token docker run --rm "${LAUF_HAERTUNG[@]}" --network "$netz" \
    -e CLAUDE_CODE_OAUTH_TOKEN "${PROXY_UMGEBUNG[@]}" \
    -v "$dir/ca.pem:/aio-ca/ca.pem:ro" -v "$dir/work:/work" \
    "$IMAGE:$variante" node /opt/spike/spikes/vm/src/s1b.ts "$@"
}

info "Durchgang 1: nur Protokoll"
proxy_starten protokoll "$dir" "$netz"
lauf durchgang 1 || true
proxy_protokoll "$dir/work/protokoll-1.jsonl"

info "Allowlist erzeugen"
auswerten "$variante" "$dir" s1b.ts allowlist /daten/work/protokoll-1.jsonl /daten/proxy/allowlist.json
install -m 0644 "$TOKEN_HASH_DATEI" "$dir/proxy/token.sha256"
cat "$dir/proxy/allowlist.json"

info "Durchgang 2: mit Allowlist und Prüfung der Anmeldung"
proxy_starten allowlist "$dir" "$netz"
lauf durchgang 2 || true
lauf negativ || true
proxy_protokoll "$dir/work/protokoll-2.jsonl"

info "Auswertung"
install -m 0644 "$dir/kontext.txt" "$dir/work/kontext.txt"
install -m 0644 "$dir/proxy/allowlist.json" "$dir/work/allowlist.json"
auswerten "$variante" "$dir/work" s1b.ts bericht /daten /daten/kontext.txt
bericht_ablegen "$dir/work/S1b-bericht.md" S1b-bericht.md
