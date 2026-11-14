# Lauf-Image für die Spikes S1a, S1b, S1f, S1g und S2 (docs/etappe-0.md Kap. 3).
#
# Gebaut von bauen.sh aus einem zusammengestellten Kontext (nur spikes/vm und
# packages/office/src). Die Variante der Managed Settings kommt als Build-Argument, damit die
# Datei root gehört und im Container nicht beschreibbar ist (plan.md Kap. 5.7).
#
# Basis mit Digest gepinnt (Docker Hub, Tag 24.22.1-trixie-slim, Stand 28.10.2026).
ARG BASE=node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a

FROM ${BASE} AS cli
# Claude Code als natives Binary aus dem npm-Paket für linux-x64, ohne Install-Skript: Das
# Hauptpaket @anthropic-ai/claude-code kopiert das Binary per postinstall (install.cjs); hier wird
# es direkt aus dem Plattformpaket entpackt. Version fest gepinnt (R9), Prüfsumme des Tarballs
# fest eingetragen (SHA-512 stimmt mit dist.integrity der Registry überein, geprüft 05.11.2026).
ARG CLAUDE_VERSION=2.1.312
ARG CLAUDE_TGZ_SHA256=f1c3d923ff3ac7e7080b8b9c638833dde72feab15e46940a65a0122d728c6bfd
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/claude.tgz \
      "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_VERSION}.tgz" \
 && echo "${CLAUDE_TGZ_SHA256}  /tmp/claude.tgz" | sha256sum -c - \
 && mkdir /tmp/claude \
 && tar -xzf /tmp/claude.tgz -C /tmp/claude \
 && install -m 0755 /tmp/claude/package/claude /usr/local/bin/claude

FROM ${BASE}
# bubblewrap und socat braucht die Bash-Sandbox unter Linux, ripgrep nennt der Dialog /sandbox
# (https://code.claude.com/docs/en/sandboxing). git, curl und procps für die Läufe und Proben.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap socat ripgrep git ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/claude /usr/local/bin/claude
RUN useradd --uid 10001 --user-group --create-home --shell /bin/bash agent
COPY --chown=root:root kontext/ /opt/spike/
ARG SANDBOX=sandbox
RUN install -d -m 0755 /etc/claude-code \
 && install -m 0644 /opt/spike/spikes/vm/image/managed-settings.${SANDBOX}.json /etc/claude-code/managed-settings.json
# Nicht nötiger Verkehr aus (Auto-Updates, Telemetrie, Fehlerberichte, Feature-Flags) und keine
# Hintergrundaufgaben (https://code.claude.com/docs/en/env-vars, plan.md Kap. 5.7).
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
    CLAUDE_CONFIG_DIR=/home/agent/.claude
USER 10001:10001
WORKDIR /work
