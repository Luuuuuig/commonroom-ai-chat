FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    APP_MODE=mock

WORKDIR /app

# Explicit copies exclude local accounts, databases, credentials, and backups.
# The application has no npm dependencies and needs no install step.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

# A new named volume inherits this directory's ownership on first use.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
