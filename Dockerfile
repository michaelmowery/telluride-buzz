# Telluride.Buzz: one small container (no npm dependencies, built-in SQLite).
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node config ./config

USER node
VOLUME ["/data"]
EXPOSE 3000

# Keep the V8 heap well under the container's memory limit.
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "--max-old-space-size=160", "src/server.js"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
