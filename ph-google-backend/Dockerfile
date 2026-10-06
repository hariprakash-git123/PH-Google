# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# PH Google — backend API
#
# Two stages so the runtime image carries production dependencies only: jest,
# eslint, prettier and mongodb-memory-server add well over a hundred megabytes
# and a much larger attack surface for code that never runs in production.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps

WORKDIR /app

# Copied on their own so this layer is rebuilt only when the dependency set
# changes, not on every source edit.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile pins — a build is reproducible
# and cannot silently pick up a new minor version.
RUN npm ci --omit=dev && npm cache clean --force


FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=5000

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# The `node` user ships with the official image. Running as root would mean a
# container escape starts with root on the host namespace.
USER node

EXPOSE 5000

# "Is the process serving HTTP?" — deliberately not "is everything healthy?".
# /health answers 200 with status "degraded" when MongoDB or OpenSearch is
# unreachable, and that is correct here: a backend that can still report the
# outage is more useful than one Docker keeps restarting.
#
# node:22-alpine has no curl, but Node 22 has a global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Signals reach this directly (compose sets init: true for reaping), so
# server.js's SIGTERM handler runs and crawls stop before the socket closes.
CMD ["node", "server.js"]
