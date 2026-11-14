#!/usr/bin/env bash
# Zugänge für die Spikes einrichten (docs/etappe-0.md 1.5). Nur Sie führen das aus.
#
#   sudo bash zugang.sh token   setup-token erzeugen und in geheim/setup-token ablegen
#   sudo bash zugang.sh voll    vollen Login für /usage in geheim/claude-voll anlegen (S2)
#   sudo bash zugang.sh status  zeigt nur, ob die Zugänge vorhanden sind
#
# Beide Befehle laufen im Lauf-Image (dort liegt das CLI), mit Netz über die Standard-Bridge.
# Quellen: https://code.claude.com/docs/en/authentication („Generate a long-lived token“, „Log in
# to Claude Code“). Das Token erscheint einmal im Terminal; die Doku sagt dazu: „It does not save
# the token anywhere.“ Deshalb fügen Sie es danach selbst ein, die Eingabe bleibt unsichtbar.
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten
pruefe_image ohne

interaktiv() {
  docker run -it --rm --name "aio-spike-zugang" "${LAUF_HAERTUNG[@]}" "$@"
}

case "${1:-}" in
  token)
    info "Schritt 1: claude setup-token"
    echo "Gleich erscheint ein Link. Öffnen Sie ihn im Browser unter Windows, melden Sie sich an"
    echo "und bestätigen Sie. Das Token erscheint danach hier im Terminal."
    interaktiv "$IMAGE:ohne" claude setup-token || true
    info "Schritt 2: Token ablegen"
    echo "Markieren und kopieren Sie das Token aus der Ausgabe oben und fügen Sie es hier ein."
    IFS= read -r -s -p "Token (Eingabe unsichtbar), dann Enter: " token
    echo
    token="${token//[[:space:]]/}"
    [ -n "$token" ] || fehler "Kein Token eingegeben"
    case "$token" in
      sk-ant-*) ;;
      *) echo "Hinweis: Das Token beginnt nicht mit sk-ant-. Die Proben in S1a suchen nach diesem Muster [Annahme]." ;;
    esac
    printf '%s' "$token" > "$TOKEN_DATEI"
    chmod 0600 "$TOKEN_DATEI"
    printf '%s' "$token" | sha256sum | cut -d' ' -f1 > "$TOKEN_HASH_DATEI"
    chmod 0644 "$TOKEN_HASH_DATEI"
    unset token
    date -u +%Y-%m-%d > "$GEHEIM/setup-token.erstellt"
    echo "Abgelegt in $TOKEN_DATEI (0600, root). Erstellt am $(cat "$GEHEIM/setup-token.erstellt"),"
    echo "gültig ein Jahr. Bitte jetzt 'clear' ausführen und das Fenster schließen, damit das Token"
    echo "nicht im Verlauf des Terminals bleibt."
    ;;
  voll)
    info "Voller Login für /usage (nur S2)"
    install -d -m 0700 -o "$AGENT_UID" -g "$AGENT_UID" "$VOLL_DIR"
    echo "Gleich startet Claude Code. Tippen Sie /login, wählen Sie die Anmeldung mit Ihrem"
    echo "Claude-Abo, öffnen Sie den Link unter Windows und fügen Sie den angezeigten Code hier ein."
    echo "Danach mit /exit beenden."
    interaktiv -v "$VOLL_DIR:/claude-voll" -e CLAUDE_CONFIG_DIR=/claude-voll "$IMAGE:ohne" claude
    if [ -s "$VOLL_DIR/.credentials.json" ]; then
      echo "Login gefunden: $VOLL_DIR/.credentials.json"
    else
      fehler "Keine .credentials.json in $VOLL_DIR. Bitte wiederholen."
    fi
    ;;
  status)
    if [ -s "$TOKEN_DATEI" ]; then
      echo "setup-token: vorhanden, erstellt $(cat "$GEHEIM/setup-token.erstellt" 2> /dev/null || echo '?')"
    else
      echo "setup-token: fehlt"
    fi
    if [ -s "$VOLL_DIR/.credentials.json" ]; then
      echo "voller Login: vorhanden"
    else
      echo "voller Login: fehlt"
    fi
    ;;
  *)
    fehler "Aufruf: sudo bash zugang.sh token|voll|status"
    ;;
esac
