# Agent Manager — one image, any host.
#
# Runs on Cloud Run, ECS/Fargate, Lambda (container image), Kubernetes or a
# laptop. Nothing in here names a cloud; the backend is chosen at runtime by
# STORAGE_DRIVER (see lib/storage).

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Production deps only. The S3 and GCS SDKs are deliberately NOT installed:
# each is required lazily, so the image stays the same size on either cloud.
# Add one at build time when you know where you are going:
#   docker build --build-arg STORAGE_SDK=@google-cloud/storage .
ARG STORAGE_SDK=""
RUN npm ci --omit=dev --no-audit --no-fund \
 && if [ -n "$STORAGE_SDK" ]; then npm install --no-save --omit=dev "$STORAGE_SDK"; fi

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    STORAGE_DRIVER=fs \
    STORAGE_ROOT=/data

RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app server.js ./
COPY --chown=app:app actions ./actions
COPY --chown=app:app lib ./lib
COPY --chown=app:app config ./config
COPY --chown=app:app web-src ./web-src

USER app
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
