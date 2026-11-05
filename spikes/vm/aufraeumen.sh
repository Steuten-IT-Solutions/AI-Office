#!/usr/bin/env bash
# Entfernt Container und Netze der Spikes. Mit --alles zusätzlich Images, Daten und Zugänge.
# Aufruf: sudo bash aufraeumen.sh [--alles]
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"

info "Container"
docker ps -a --filter "name=^aio-spike-" --format '{{.Names}}' | xargs -r docker rm -f
info "Netze"
docker network ls --filter "name=^aio-spike-" --format '{{.Name}}' | xargs -r docker network rm

if [ "${1:-}" = "--alles" ]; then
  info "Images"
  docker image rm -f "$IMAGE:sandbox" "$IMAGE:streng" "$IMAGE:ohne" "$PROXY_IMAGE" 2> /dev/null || true
  info "Daten, setup-token und voller Login unter $AIO_SPIKES"
  read -r -p "Alles unter $AIO_SPIKES löschen (auch berichte/)? [ja/nein] " antwort
  if [ "$antwort" = "ja" ]; then
    rm -rf "$AIO_SPIKES"
    echo "Gelöscht. Das setup-token selbst bleibt gültig, bis es nach einem Jahr abläuft."
    echo "Ob und wo es sich vorher widerrufen lässt, ist nicht geprüft [Annahme]."
  fi
fi
echo "Fertig."
