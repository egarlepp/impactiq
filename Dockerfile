FROM node:26-alpine AS base
WORKDIR /app
COPY package*.json ./
COPY src/server/package*.json ./src/server/
COPY src/client/package*.json ./src/client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/drizzle ./drizzle
COPY --from=base /app/src/client/dist ./src/client/dist
# v1.107.0: static assets served at /public/*. Emails reference these
# via hosted URLs (impactiq-mark.png, tenant theme logos). Without
# this COPY the /public route returns 404 in production and Outlook
# shows a broken image where the mark should render.
COPY --from=base /app/public ./public
# v1.414.0: run as the image's unprivileged `node` user instead of root. The
# app files stay root-owned, so the process can read them but not change
# them; the only thing it writes to disk is restore uploads under /tmp.
USER node
EXPOSE 3000
# /health answers without touching the database (the app stays up and
# reports a DB problem on /api instead), so this checks the process is
# serving, not that Postgres is reachable. Keep it that way: restarting the
# app doesn't fix a database outage. Point a load balancer or uptime monitor
# at /ready instead, which also checks the database (503 until it answers).
# busybox wget ships in alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health" || exit 1
CMD ["node", "dist/server/src/server/index.js"]
