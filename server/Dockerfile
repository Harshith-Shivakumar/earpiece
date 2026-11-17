# Earpiece bridge for a Linux server. Build from the repo root:
#   docker build -f server/Dockerfile -t earpiece-bridge .
# Normally you don't run this by hand: server/install-docker.sh builds and starts it.
#
# The bridge has no npm dependencies. Claude Code itself is NOT baked in by default: the
# container uses your server's own Claude Code install and login, through your mounted home
# folder. Pass --build-arg INSTALL_CLAUDE=1 if Claude Code on the server lives outside your home.
FROM node:22-bookworm-slim

ARG INSTALL_CLAUDE=0

# Tools Claude Code commonly runs while it works (it runs them inside this container).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep jq curl ca-certificates openssh-client less procps tini tzdata \
      python3 python3-pip python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_CLAUDE" = "1" ]; then \
      curl -fsSL https://claude.ai/install.sh | bash \
      && cp -L /root/.local/bin/claude /usr/local/bin/claude \
      && chmod 755 /usr/local/bin/claude \
      && rm -rf /root/.local/share/claude /root/.local/bin/claude; \
    fi

WORKDIR /app/bridge
COPY bridge/ /app/bridge/

# Relay only by default on a server: nothing listens for the phone directly.
ENV EARPIECE_DIRECT=false \
    DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/bridge/src/server.js"]
