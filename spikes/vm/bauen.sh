#!/usr/bin/env bash
# Baut das Lauf-Image in drei Varianten der Managed Settings und lädt das Proxy-Image.
#   sandbox  Bash-Sandbox an, enableWeakerNestedSandbox (Plan Kap. 5.7, S1a)
#   streng   Bash-Sandbox an, ohne enableWeakerNestedSandbox (S1a, nur zur Information)
#   ohne     Bash-Sandbox aus (S2; S1b und S1f, falls die Sandbox in Docker nicht startet)
# Aufruf: sudo bash bauen.sh
source "$(dirname "$0")/lib.sh"
pruefe_root "$@"
vorbereiten

kontext="$(mktemp -d)"
trap 'rm -rf "$kontext"' EXIT
install -d "$kontext/kontext/spikes/vm" "$kontext/kontext/packages/office" "$kontext/kontext/docs"
cp -r "$SPIKE_DIR/src" "$SPIKE_DIR/probe" "$SPIKE_DIR/image" "$SPIKE_DIR/proxy" \
  "$kontext/kontext/spikes/vm/"
cp -r "$REPO_ROOT/packages/office/src" "$kontext/kontext/packages/office/"
cp "$REPO_ROOT/docs/plan.md" "$kontext/kontext/docs/"
chmod -R a+rX "$kontext/kontext"

for variante in sandbox streng ohne; do
  info "Baue $IMAGE:$variante"
  docker build --pull --build-arg "SANDBOX=$variante" -t "$IMAGE:$variante" \
    -f "$SPIKE_DIR/image/Dockerfile" "$kontext"
done

info "Lade $PROXY_IMAGE"
docker pull "$PROXY_IMAGE"

info "Prüfe das CLI im Image"
docker run --rm --network none "$IMAGE:ohne" claude --version
hilfe="$(docker run --rm --network none "$IMAGE:ohne" claude --help)"
for flag in --permission-prompts --permission-mode --setting-sources --settings --max-budget-usd \
  --max-turns --allowedTools --strict-mcp-config --mcp-config --append-system-prompt \
  --input-format --output-format; do
  if grep -q -- "$flag" <<< "$hilfe"; then
    echo "  vorhanden: $flag"
  else
    echo "  FEHLT: $flag (Skripte passen nicht zur CLI-Version)"
  fi
done
docker run --rm --network none "$IMAGE:sandbox" cat /etc/claude-code/managed-settings.json
echo "Fertig."
