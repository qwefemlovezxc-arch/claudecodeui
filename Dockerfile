# syntax=docker/dockerfile:1.7

# ─── Stage 1: build client + server ─────────────────────────────────────
FROM node:22-bookworm AS builder

WORKDIR /app

# Native deps (node-pty, better-sqlite3) need a toolchain during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Drop devDeps so the runtime image ships minimal node_modules.
RUN npm prune --omit=dev


# ─── Stage 2: runtime ───────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Claude CLI provides the `claude` binary we spawn from claude-sdk.js.
# tini is PID 1 so SIGTERM / SIGKILL propagate into subprocess sessions
# properly when k8s rolls the pod.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git tini curl \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG UID=1000
ARG GID=1000
RUN groupadd --gid $GID claude && \
    useradd --uid $UID --gid $GID --create-home --shell /bin/bash claude

# Sandbox root — must match WORKSPACES_ROOT env. PVC will mount here in k8s.
RUN mkdir -p /workspace/nastya /home/claude/.claude && \
    chown -R claude:claude /workspace /home/claude

WORKDIR /app

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist-server/server/index.js"]
