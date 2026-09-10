# One image, no runtime dependencies: the build stage compiles TypeScript and
# the final stage carries only Node, dist/, and whatever web build was placed
# in web/ (README「Web build」). The SQLite file and the generated secret live
# on the volume mounted at /data.
#
# There is deliberately no `VOLUME ["/data"]`: Railway rejects the instruction
# outright ("docker VOLUME is not supported, use Railway Volumes", measured
# 2026-09-10) because it attaches volumes itself. Declaring it would only have
# bought an anonymous volume for a `docker run` that forgot `-v` — a volume
# nobody names is one nobody restores from, so the mount stays the operator's
# explicit decision on every platform (README「Deploy」).
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    CLUB_DATA_DIR=/data \
    CLUB_WEB_DIR=/app/web
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
