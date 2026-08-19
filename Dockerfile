FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json biome.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm ci --ignore-scripts
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:22.19.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker/uma.config.json ./uma.config.json
RUN mkdir -p /data/state /data/workspace
VOLUME ["/data/state", "/data/workspace"]
EXPOSE 3210
CMD ["node", "apps/server/dist/main.js", "--config=uma.config.json"]
