# Gemeinsame Teile der VM-Spikes (S1a, S1b, S1f, S1g, S2). Wird von den Skripten eingebunden.
#
# Die Skripte laufen in der VM aio-dev als root (sudo), weil der Benutzer christian bewusst nicht
# in der Gruppe docker ist (E25, einrichtung.md 4.7). Sie geben nie ein Token aus.
# shellcheck shell=bash

set -euo pipefail
umask 077

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SPIKE_DIR/../.." && pwd)"

# Ablage in der VM (docs/etappe-0.md Kap. 3: /opt/aio-spikes). geheim/ nur root, daten/ und
# berichte/ ohne Geheimnisse.
AIO_SPIKES="${AIO_SPIKES:-/opt/aio-spikes}"
GEHEIM="$AIO_SPIKES/geheim"
DATEN="$AIO_SPIKES/daten"
BERICHTE="$AIO_SPIKES/berichte"
TOKEN_DATEI="$GEHEIM/setup-token"
TOKEN_HASH_DATEI="$DATEN/token.sha256"
VOLL_DIR="$GEHEIM/claude-voll"

IMAGE="aio-spike-lauf"
# mitmproxy 12.3.1 (Docker Hub, 25.10.2026), Digest der Multi-Arch-Liste
PROXY_IMAGE="mitmproxy/mitmproxy:12.3.1@sha256:2711066c855659b5af8b1dbb84494ed3eff69b42ece439c60b4fe09a2db829d4"
AGENT_UID=10001

# Härtung wie plan.md Kap. 4.7 und 5.7: nicht privilegiert, keine Capabilities,
# no-new-privileges, schreibgeschütztes Root-Dateisystem, tmpfs mit Grenze, Limits, Log-Grenze.
LAUF_HAERTUNG=(
  --user "$AGENT_UID:$AGENT_UID"
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp:rw,nosuid,nodev,size=512m
  --tmpfs "/home/agent:rw,nosuid,nodev,size=512m,uid=$AGENT_UID,gid=$AGENT_UID,mode=0700"
  --memory 2g
  --memory-swap 2g
  --cpus 2
  --pids-limit 512
  --log-opt max-size=10m
  --log-opt max-file=3
)

info() { printf '\n== %s\n' "$*"; }
fehler() {
  printf 'FEHLER: %s\n' "$*" >&2
  exit 1
}

# Ersetzt alles, was wie ein Anthropic-Schlüssel aussieht (für Ausgaben von stderr).
maske() { sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-***/g'; }

pruefe_root() {
  [ "$(id -u)" -eq 0 ] || fehler "Bitte mit sudo ausführen: sudo bash $0 $*"
  command -v docker > /dev/null || fehler "docker fehlt (einrichtung.md 4.7)"
}

vorbereiten() {
  install -d -m 0700 "$AIO_SPIKES" "$GEHEIM"
  install -d -m 0755 "$DATEN" "$BERICHTE"
  chmod 0755 "$AIO_SPIKES"
}

pruefe_image() {
  local variante="$1"
  docker image inspect "$IMAGE:$variante" > /dev/null 2>&1 \
    || fehler "Image $IMAGE:$variante fehlt. Erst: sudo bash $SPIKE_DIR/bauen.sh"
}

pruefe_token() {
  [ -s "$TOKEN_DATEI" ] || fehler "setup-token fehlt. Erst: sudo bash $SPIKE_DIR/zugang.sh token"
  [ -s "$TOKEN_HASH_DATEI" ] || fehler "$TOKEN_HASH_DATEI fehlt. Bitte zugang.sh token wiederholen"
}

pruefe_voll() {
  [ -s "$VOLL_DIR/.credentials.json" ] \
    || fehler "Voller Login fehlt. Erst: sudo bash $SPIKE_DIR/zugang.sh voll"
}

# Frisches Arbeitsverzeichnis für den Container (Besitzer: Container-Nutzer).
arbeitsverzeichnis() {
  local dir="$1"
  rm -rf "$dir"
  install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_UID" "$dir"
}

# Führt einen Befehl aus, in dessen Umgebung (und nur dort) CLAUDE_CODE_OAUTH_TOKEN steht.
# docker run/exec übernimmt den Wert mit `-e CLAUDE_CODE_OAUTH_TOKEN` ohne ihn auf der
# Kommandozeile zu zeigen.
mit_token() {
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_DATEI")" "$@"
}

# Kontext für die Auswertung im Image: Version des CLI und des Images.
image_kontext() {
  local variante="$1"
  printf 'Image: %s:%s (%s)\n' "$IMAGE" "$variante" \
    "$(docker image inspect --format '{{.Id}}' "$IMAGE:$variante" | cut -c1-19)"
  printf 'CLI: %s\n' "$(docker run --rm --network none "$IMAGE:$variante" claude --version)"
  printf 'Docker: %s, Kernel: %s\n' "$(docker version --format '{{.Server.Version}}')" "$(uname -r)"
}

# Führt ein TypeScript-Skript aus spikes/vm/src im Image aus, ohne Netz.
auswerten() {
  local variante="$1" daten="$2"
  shift 2
  docker run --rm --network none "${LAUF_HAERTUNG[@]}" \
    -v "$daten:/daten" \
    "$IMAGE:$variante" node "/opt/spike/spikes/vm/src/$1" "${@:2}"
}

# Kopiert einen Bericht nach berichte/ und zeigt den Weg.
bericht_ablegen() {
  local quelle="$1" name="$2"
  install -m 0644 "$quelle" "$BERICHTE/$name"
  printf '\nBericht: %s\nBitte an Claude schicken (enthält keine Geheimnisse) oder per PR nach spikes/ergebnisse/.\n' \
    "$BERICHTE/$name"
}

# --- Netz und Proxy (S1b, S1g) -------------------------------------------------------------
# Lauf-Netz ohne Weg nach außen (--internal); nur der Proxy hängt zusätzlich am Netz aussen.
NETZ_AUSSEN="aio-spike-aussen"
PROXY="aio-spike-proxy"
MITM_DIR="$GEHEIM/mitmproxy"

netz_anlegen() {
  local name="$1" art="${2:-intern}"
  docker network rm "$name" > /dev/null 2>&1 || true
  if [ "$art" = "intern" ]; then
    docker network create --internal "$name" > /dev/null
  else
    docker network create "$name" > /dev/null
  fi
}

# proxy_starten <modus> <verzeichnis> <lauf-netz>
# Verzeichnis enthält proxy/ (Addon, ggf. allowlist.json, token.sha256). Das CA-Zertifikat des
# Proxys landet in <verzeichnis>/ca.pem. Der Schlüssel der CA bleibt in geheim/mitmproxy.
proxy_starten() {
  local modus="$1" dir="$2" netz="$3"
  local optionen=(--set "aio_modus=$modus" --set "aio_protokoll=/tmp/anfragen.jsonl")
  [ -f "$dir/proxy/allowlist.json" ] && optionen+=(--set aio_allowlist=/aio/allowlist.json)
  [ -f "$dir/proxy/token.sha256" ] && optionen+=(--set aio_token_sha256=/aio/token.sha256)
  # Der Entrypoint des Images setzt UID und GID des Users mitmproxy per `usermod -o -u -g` auf
  # den Besitzer von mitmproxy-ca.pem bzw. des Ordners (release/docker/docker-entrypoint.sh in
  # mitmproxy v12.3.1). Die Gruppe muss im Image existieren: 65534 (nogroup) gibt es in Debian.
  install -d -m 0700 "$MITM_DIR"
  chown -R 10002:65534 "$MITM_DIR"
  docker rm -f "$PROXY" > /dev/null 2>&1 || true
  docker run -d --name "$PROXY" --network "$NETZ_AUSSEN" \
    --log-opt max-size=10m --log-opt max-file=3 \
    -v "$dir/proxy:/aio:ro" -v "$MITM_DIR:/home/mitmproxy/.mitmproxy" \
    "$PROXY_IMAGE" mitmdump --listen-port 8080 -s /aio/aio_proxy.py "${optionen[@]}" > /dev/null
  docker network connect "$netz" "$PROXY"
  local i
  for i in $(seq 1 30); do
    if [ -s "$MITM_DIR/mitmproxy-ca-cert.pem" ] \
      && [ "$(docker inspect -f '{{.State.Running}}' "$PROXY")" = true ]; then
      sleep 2
      install -m 0644 "$MITM_DIR/mitmproxy-ca-cert.pem" "$dir/ca.pem"
      return 0
    fi
    sleep 1
  done
  docker logs "$PROXY" 2>&1 | tail -20 | maske
  fehler "Proxy startet nicht"
}

# Protokoll des Proxys sichern (vor dem Stoppen).
proxy_protokoll() {
  local ziel="$1"
  docker cp "$PROXY:/tmp/anfragen.jsonl" "$ziel" 2> /dev/null || : > "$ziel"
  chmod 0644 "$ziel"
}

proxy_addon() {
  local dir="$1"
  install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_UID" "$dir/proxy"
  install -m 0644 "$SPIKE_DIR/proxy/aio_proxy.py" "$dir/proxy/aio_proxy.py"
}

# Umgebung für Läufe hinter dem Proxy (https://code.claude.com/docs/en/network-config:
# HTTPS_PROXY und NODE_EXTRA_CA_CERTS).
PROXY_UMGEBUNG=(
  -e "HTTPS_PROXY=http://$PROXY:8080"
  -e "HTTP_PROXY=http://$PROXY:8080"
  -e "NO_PROXY=localhost,127.0.0.1"
  -e NODE_EXTRA_CA_CERTS=/aio-ca/ca.pem
)
