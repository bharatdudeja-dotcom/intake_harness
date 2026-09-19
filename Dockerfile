# Multi-stage build: full node_modules only exist in the deps/builder
# stages, which are discarded — the runtime image gets just what
# `output: "standalone"` (next.config.ts) traced in as actually used.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The stat tiles and every /api/* route read the database at request time,
# not at build time (see src/app/page.tsx's `dynamic = "force-dynamic"`
# comment), so DATABASE_URL/MCP_ENDPOINT_URL don't need to exist here.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Next's own convention for the standalone output: run as a dedicated
# non-root user rather than root.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# docs/ is read from disk at runtime (src/lib/agents/review/pql-context.ts -
# the local PQL reference both Agent 2 and Agent 3 ground against). Next's
# own file-tracer happens to pick this up into .next/standalone/docs/
# automatically today (confirmed by inspecting a real build), because the
# path is a static string literal it can resolve - but that's the tracer's
# static analysis working out in this one case, not a guarantee for every
# future change to how that path gets built. Copied explicitly here too so
# this doesn't silently start failing closed in a deployed container the
# day that path stops being literal (e.g. built from an env var) - belt and
# suspenders, and the second COPY of an already-present directory is a
# no-op either way.
COPY --from=builder --chown=nextjs:nodejs /app/docs ./docs

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Required at runtime (not baked into the image — pass with `docker run -e`
# or a compose/orchestrator env file): DATABASE_URL, MCP_ENDPOINT_URL,
# ADMIN_NAMES, and whichever MCP_GATEWAY_*/WORKFRONT_*/MCP_API_KEY variables
# this deployment needs — see .env.local.example.
CMD ["node", "server.js"]
