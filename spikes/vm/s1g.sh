#!/usr/bin/env bash
# Spike S1g: Netz des Lauf-Containers (docs/etappe-0.md 3.1). Ohne Token und ohne LLM-Aufruf.
#
# Aufbau wie plan.md 4.6: eigenes Netz je Lauf (--internal, ohne Weg nach außen). Darin nur der
# Proxy (zusätzlich am Netz aussen) und Attrappen für Office-API und Supervisor-Gateway. Dazu ein
# Nachbar in einem zweiten Lauf-Netz und einer an der Standard-Bridge von Docker.
# [Annahme] Wie Office-API und Gateway später angebunden werden (Port am Host oder Relay im
# Lauf-Netz), legt S05 fest; hier stehen sie als Container im Lauf-Netz.
# Aufruf: sudo bash s1g.sh
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten
pruefe_image ohne

dir="$DATEN/s1g"
netz_a="aio-spike-s1g-a"
netz_b="aio-spike-s1g-b"
arbeitsverzeichnis "$dir"
aufraeumen() {
  docker rm -f "$PROXY" aio-spike-office aio-spike-gateway aio-spike-nachbar-b \
    aio-spike-nachbar-bridge > /dev/null 2>&1 || true
  docker network rm "$netz_a" "$netz_b" "$NETZ_AUSSEN" > /dev/null 2>&1 || true
}
trap aufraeumen EXIT
image_kontext ohne > "$dir/kontext.txt"
chmod 0644 "$dir/kontext.txt"

info "Netze, Proxy und Attrappen"
netz_anlegen "$NETZ_AUSSEN" aussen
netz_anlegen "$netz_a" intern
netz_anlegen "$netz_b" intern
proxy_addon "$dir"
proxy_starten protokoll "$dir" "$netz_a"

attrappe() {
  local name="$1" netz="$2" port="$3"
  docker rm -f "$name" > /dev/null 2>&1 || true
  docker run -d --name "$name" "${LAUF_HAERTUNG[@]}" --network "$netz" \
    "$IMAGE:ohne" node /opt/spike/spikes/vm/src/s1g.ts server "$port" > /dev/null
}
attrappe aio-spike-office "$netz_a" 3100
attrappe aio-spike-gateway "$netz_a" 3200
attrappe aio-spike-nachbar-b "$netz_b" 8080
attrappe aio-spike-nachbar-bridge bridge 8080
sleep 2

ip_von() { docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }
gw_a="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$netz_a")"
docker0="$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)"
host_ip="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
anthropic_ip="$(getent ahostsv4 api.anthropic.com | awk 'NR == 1 {print $1}')"
nachbar_b="$(ip_von aio-spike-nachbar-b "$netz_b")"
nachbar_bridge="$(ip_von aio-spike-nachbar-bridge bridge)"
echo "Gateway Lauf-Netz $gw_a, docker0 $docker0, Host $host_ip, api.anthropic.com $anthropic_ip"
echo "Nachbar im zweiten Lauf-Netz $nachbar_b, an der Standard-Bridge $nachbar_bridge"

cat > "$dir/spec.json" << EOF
[
  {"name": "Proxy erreichbar (TCP $PROXY:8080)", "kind": "tcp", "target": "$PROXY", "port": 8080, "expect": "geht"},
  {"name": "Über den Proxy zu api.anthropic.com:443 (CONNECT)", "kind": "proxy-connect", "target": "$PROXY", "port": 8080, "via": "api.anthropic.com:443", "expect": "geht"},
  {"name": "Office-API-Attrappe (HTTP aio-spike-office:3100)", "kind": "http", "target": "aio-spike-office", "port": 3100, "expect": "geht"},
  {"name": "Gateway-Attrappe (HTTP aio-spike-gateway:3200)", "kind": "http", "target": "aio-spike-gateway", "port": 3200, "expect": "geht"},
  {"name": "Host über das Gateway des Lauf-Netzes ($gw_a:22)", "kind": "tcp", "target": "$gw_a", "port": 22, "expect": "scheitert"},
  {"name": "Host über docker0 ($docker0:22)", "kind": "tcp", "target": "$docker0", "port": 22, "expect": "scheitert"},
  {"name": "Host über seine Adresse im Default Switch ($host_ip:22)", "kind": "tcp", "target": "$host_ip", "port": 22, "expect": "scheitert"},
  {"name": "Container im zweiten Lauf-Netz ($nachbar_b:8080)", "kind": "tcp", "target": "$nachbar_b", "port": 8080, "expect": "scheitert"},
  {"name": "Container an der Standard-Bridge ($nachbar_bridge:8080)", "kind": "tcp", "target": "$nachbar_bridge", "port": 8080, "expect": "scheitert"},
  {"name": "Internet direkt (TCP 1.1.1.1:443)", "kind": "tcp", "target": "1.1.1.1", "port": 443, "expect": "scheitert"},
  {"name": "Anthropic direkt (TCP $anthropic_ip:443)", "kind": "tcp", "target": "$anthropic_ip", "port": 443, "expect": "scheitert"},
  {"name": "Internet direkt über IPv6 (TCP [2606:4700:4700::1111]:443)", "kind": "tcp", "target": "2606:4700:4700::1111", "port": 443, "expect": "scheitert"},
  {"name": "DNS über den Resolver des Containers (example.com)", "kind": "dns-system", "target": "example.com", "expect": "scheitert"},
  {"name": "DNS direkt (UDP 1.1.1.1:53, example.com)", "kind": "dns-direkt", "target": "example.com", "via": "1.1.1.1", "expect": "scheitert"},
  {"name": "DNS direkt (UDP 8.8.8.8:53, example.com)", "kind": "dns-direkt", "target": "example.com", "via": "8.8.8.8", "expect": "scheitert"},
  {"name": "DNS direkt am Gateway des Lauf-Netzes ($gw_a:53)", "kind": "dns-direkt", "target": "example.com", "via": "$gw_a", "expect": "scheitert"},
  {"name": "Namen im Lauf-Netz auflösbar (aio-spike-office)", "kind": "dns-system", "target": "aio-spike-office", "expect": "geht", "infoOnly": true}
]
EOF
chmod 0644 "$dir/spec.json"

info "Netzprobe aus einem Lauf-Container im Lauf-Netz"
docker run --rm --name aio-spike-s1g "${LAUF_HAERTUNG[@]}" --network "$netz_a" \
  -v "$dir:/work" "$IMAGE:ohne" node /opt/spike/spikes/vm/src/s1g.ts probe /work/spec.json /work/ergebnis.json

info "Auswertung"
auswerten ohne "$dir" s1g.ts bericht /daten /daten/kontext.txt
bericht_ablegen "$dir/S1g-bericht.md" S1g-bericht.md
