# Lauf-Image für die Agenten-Läufe (P12, plan.md Kap. 4.7 und 5.7, E27, E28, E42).
#
# Kritischer Pfad (plan.md Kap. 4.5 Nr. 3): Wer dieses Image ändert, ändert, womit jeder Lauf
# arbeitet. Gebaut wird aus packages/lauf als Kontext (siehe README.md):
#   docker build -f packages/lauf/image/Dockerfile -t aio-lauf packages/lauf
#
# Basis mit Digest gepinnt (Docker Hub, Tag 24.22.1-trixie-slim, Stand 28.10.2026; dieselbe Basis
# wie in den Spikes S1a–S1g, spikes/vm/image/Dockerfile).
ARG BASE=node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a

FROM ${BASE} AS cli
# Claude Code als natives Binary aus dem npm-Paket für linux-x64, ohne Install-Skript (wie in den
# Spikes). Version fest gepinnt (R9, plan.md Kap. 5.10), Prüfsumme des Tarballs fest eingetragen
# (SHA-512 stimmt mit dist.integrity der Registry überein, geprüft 05.11.2026). Mit dieser
# Version liefen S1a–S1g.
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
# Keine Bash-Sandbox: Sie startet im gehärteten Container nicht (Spike S1a), der CEO hat R5 am
# 19.11.2026 akzeptiert. Deshalb fehlen bubblewrap und socat bewusst.
# git für Arbeitskopie und Bundle (E28), ripgrep für die Suchwerkzeuge des CLI [Annahme: das
# Binary bringt es nicht sicher mit], tini als PID 1, damit verwaiste Prozesse abgeholt werden
# und SIGTERM aus `docker stop` beim Startprozess ankommt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/claude /usr/local/bin/claude

# pnpm für Werkbank-Läufe, fest auf die Version aus package.json (packageManager) und im Image
# abgelegt: Im Lauf gibt es nur den lesenden Registry-Cache (E29), Corepack soll dort nichts laden.
ARG PNPM_VERSION=10.34.8
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0
RUN corepack enable pnpm \
 && corepack install --global "pnpm@${PNPM_VERSION}" \
 && chmod -R a+rX /opt/corepack \
 && pnpm --version

RUN useradd --uid 10001 --user-group --create-home --shell /bin/bash agent

# Managed Settings liegen nicht im Image (E50, plan.md Kap. 5.7): Der Supervisor bindet das ganze
# Verzeichnis /etc/claude-code schreibgeschützt aus seinem Repo ein. Das leere Verzeichnis ist nur
# der Einhängepunkt; ohne Einbindung startet der Startprozess nichts (src/richtlinie.ts).
RUN install -d -m 0755 /etc/claude-code
COPY --chown=root:root src/ /opt/aio-lauf/
RUN chmod 0755 /opt/aio-lauf && chmod 0644 /opt/aio-lauf/*

# Nicht nötiger Verkehr aus: Auto-Updates, Telemetrie, Fehlerberichte, Feature-Flags; keine
# Hintergrundaufgaben (https://code.claude.com/docs/en/env-vars, plan.md Kap. 5.7). Das
# Konfigurationsverzeichnis liegt außerhalb des Arbeitsbereichs und ist im Lauf ein tmpfs.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    AIO_AUSGABE=/aio/ausgabe

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/aio-lauf/start.ts"]
