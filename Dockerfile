FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    LEAVE_SYSTEM_ROOT=/app \
    PORT=8123 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai

# This project has no npm dependencies. Copy only the files needed at runtime.
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/serve-live-copy.mjs ./scripts/serve-live-copy.mjs
COPY --chown=node:node scripts/backend-records.mjs ./scripts/backend-records.mjs
COPY --chown=node:node scripts/project-root.mjs ./scripts/project-root.mjs
COPY --chown=node:node leave-system-live-copy ./leave-system-live-copy

USER node

EXPOSE 8123

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8123/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/serve-live-copy.mjs"]
