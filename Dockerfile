# Lawla backend – en container för API och ingest. Samma image i molnet och hos kunden.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY eval ./eval
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# Migreringarna läses som SQL-filer vid start.
COPY src/db/migrations ./dist/src/db/migrations
EXPOSE 8080
USER node
CMD ["node", "dist/src/server.js"]
