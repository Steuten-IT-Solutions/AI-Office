#!/usr/bin/env bash
# Spike S2: Kontingent (docs/etappe-0.md 3.2). Braucht den vollen Login (zugang.sh voll) und das
# setup-token (zugang.sh token), dazu ein ruhiges Zeitfenster: Während S2b und S2c bitte Claude
# nirgends nutzen. Budget: bis 5 Prozentpunkte des Wochenlimits (vom CEO am 25.10.2026
# freigegeben); S2c bricht ab, sobald der Wochenzähler um so viel gestiegen ist.
#
# Aufruf: sudo bash s2.sh [alles|a|b|c|d|bericht]   (Standard: alles, danach der Bericht)
# Teile lassen sich einzeln wiederholen; Ergebnisse sammeln sich in daten/s2/s2-ergebnis.json.
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten
pruefe_token
pruefe_voll
pruefe_image ohne

dir="$DATEN/s2"
if [ ! -d "$dir" ]; then
  install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_UID" "$dir"
fi
image_kontext ohne > "$dir/kontext.txt"
chmod 0644 "$dir/kontext.txt"
teil="${1:-alles}"

s2() {
  mit_token docker run -it --rm --name aio-spike-s2 "${LAUF_HAERTUNG[@]}" \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -e "AIO_S2_BUDGET_PP=${AIO_S2_BUDGET_PP:-5}" \
    -e "AIO_S2_BLOECKE=${AIO_S2_BLOECKE:-6}" \
    -e "AIO_S2_LAEUFE_JE_BLOCK=${AIO_S2_LAEUFE_JE_BLOCK:-5}" \
    -v "$VOLL_DIR:/claude-voll" -v "$dir:/work" \
    "$IMAGE:ohne" node /opt/spike/spikes/vm/src/s2.ts "$@"
}

case "$teil" in
  alles) s2 alles || true ;;
  a | b | c | d) s2 teil "$teil" || true ;;
  bericht) ;;
  *) fehler "Aufruf: sudo bash s2.sh [alles|a|b|c|d|bericht]" ;;
esac

info "Auswertung"
s2 bericht /work/kontext.txt
bericht_ablegen "$dir/S2-bericht.md" S2-bericht.md
echo "Hinweis: Der Bericht enthält Ihre Kontingentstände. Vor einem PR in das öffentliche Repo"
echo "bitte prüfen, ob Sie das veröffentlichen möchten."
