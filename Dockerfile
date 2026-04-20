# syntax=docker/dockerfile:1.7

# ─── Stage 1: build client + server + Claude CLI ──────────────────────────
# All apt / npm install is done here where the full bookworm base already
# has working deb repos and build tooling. The runtime stage only copies
# finished artefacts, avoiding any apt-get calls on first boot.
FROM mirror.gcr.io/library/node:22-bookworm AS builder

WORKDIR /app

# Native deps (node-pty, better-sqlite3) need a toolchain during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# scripts/fix-node-pty.js runs as a postinstall hook during `npm ci`,
# so it has to exist before the install runs.
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

# Install the official Claude Code CLI globally. This lands in
# /usr/local/lib/node_modules/@anthropic-ai/claude-code and a bin symlink
# at /usr/local/bin/claude, both copied to the runtime image below.
RUN npm install -g @anthropic-ai/claude-code

COPY . .
RUN npm run build

# Drop devDeps so the runtime image ships minimal node_modules.
RUN npm prune --omit=dev


# ─── Stage 2: runtime ─────────────────────────────────────────────────────
# node:22-bookworm (non-slim) already has ca-certificates, curl and git
# baked in, so we don't run apt-get here. Avoids flaky deb.debian.org
# fetches from server3 that were killing earlier builds.
FROM mirror.gcr.io/library/node:22-bookworm AS runtime

ARG UID=1000
ARG GID=1000
# node:22-bookworm ships a `node` user at 1000:1000 by default. Remove it
# so we can own that uid/gid with our `claude` user (matches the k8s
# deployment's runAsUser/runAsGroup).
RUN userdel -rf node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd --gid $GID claude && \
    useradd --uid $UID --gid $GID --create-home --shell /bin/bash claude

# Sandbox root — must match WORKSPACES_ROOT env. PVC will mount here in k8s.
RUN mkdir -p /workspace/nastya /home/claude/.claude && \
    chown -R claude:claude /workspace /home/claude

WORKDIR /app

# Bring over the global Claude CLI and its node_modules directory from
# the builder. Keeps the runtime stage apt-free.
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai  /usr/local/lib/node_modules/@anthropic-ai
COPY --from=builder /usr/local/bin/claude                      /usr/local/bin/claude

COPY --from=builder --chown=claude:claude /app/dist /app/dist
COPY --from=builder --chown=claude:claude /app/dist-server /app/dist-server
COPY --from=builder --chown=claude:claude /app/node_modules /app/node_modules
COPY --from=builder --chown=claude:claude /app/package.json /app/package.json
COPY --from=builder --chown=claude:claude /app/shared /app/shared
COPY --from=builder --chown=claude:claude /app/public /app/public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVER_PORT=3001 \
    WORKSPACES_ROOT=/workspace/nastya \
    DATABASE_PATH=/home/claude/.claude/claudecodeui.db \
    CONTEXT_WINDOW=160000

USER claude

EXPOSE 3001

# Using node for the healthcheck so we don't need curl in the runtime
# image. k8s's httpGet liveness/readiness probes are still the authority.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
