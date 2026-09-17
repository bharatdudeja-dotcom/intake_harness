# The agentic harness as a container.
#
# There was no Dockerfile here: the harness has only ever run as `next dev` on a
# developer's laptop, against a Postgres container on the same laptop. That is
# why "everything just runs on my system" - not a configuration gap, a missing
# artifact.
#
# Two things this image deliberately does NOT contain:
#
#   1. A database. The harness owns `runs`, `task_runs` and `run_gates`, and
#      those belong in RDS. DATABASE_URL is supplied at run time.
#   2. Any credential. The Adobe MCP tokens live in Agent Manager, which the
#      harness reaches through MCP_GATEWAY_URL. The harness holds a service key
#      for that gateway and nothing else, so a compromised harness cannot
#      replay anyone's Workfront or AEP session.

# ---------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when there is a lockfile, `npm install` when there is not. The
# lockfile is the correct path and its absence should not fail the build.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build does not talk to Postgres or to any MCP server. If it ever starts
# to, it will fail here rather than at deploy time, which is the right place.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ----------------------------------------------------------------- run time
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# A non-root user. The app writes nothing to disk - every durable thing it owns
# is in Postgres - so it has no business owning its own files either.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# `standalone` emits the server plus only the modules the app actually imports.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# The schema travels with the image so the deployed version can always apply
# its own migrations - db/schema.sql is idempotent and safe to re-run, which is
# what makes that true rather than aspirational.
COPY --from=build --chown=nextjs:nodejs /app/db ./db

USER nextjs

# 3100 because that is what Agent Manager's registry expects for this system.
# Overridable: the port is configuration, and PORT is what every host sets.
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
EXPOSE 3100

# A health check that proves the app is SERVING, not merely that the process is
# alive. /api/tasks reads the task catalog from Postgres, so a green check means
# the app answered AND its database is reachable - which is the pair that
# actually matters. A check on a static route would stay green through a total
# loss of the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/tasks').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
