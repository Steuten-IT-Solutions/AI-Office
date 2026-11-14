#!/usr/bin/env bash
# Spike S1f: Lädt claude -p Einstellungen oder MCP-Server aus dem Arbeitsbereich?
# (docs/etappe-0.md 3.1). Vier haiku-Läufe in einem präparierten Arbeitsbereich: Kontrolle ohne
# Flags, Flags aus plan.md 5.7, dazu zwei Varianten zur Information. Details: src/s1f.ts.
# Aufruf: sudo bash s1f.sh   (AIO_SANDBOX=ohne, falls S1a zeigt, dass die Sandbox nicht startet)
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten
pruefe_token
variante="${AIO_SANDBOX:-sandbox}"
pruefe_image "$variante"

dir="$DATEN/s1f"
arbeitsverzeichnis "$dir"
image_kontext "$variante" > "$dir/kontext.txt"
chmod 0644 "$dir/kontext.txt"

info "Vier Läufe (haiku)"
mit_token docker run --rm --name aio-spike-s1f "${LAUF_HAERTUNG[@]}" \
  -e CLAUDE_CODE_OAUTH_TOKEN -v "$dir:/work" \
  "$IMAGE:$variante" node /opt/spike/spikes/vm/src/s1f.ts laeufe || true

info "Auswertung"
auswerten "$variante" "$dir" s1f.ts bericht /daten /daten/kontext.txt
bericht_ablegen "$dir/S1f-bericht.md" S1f-bericht.md
