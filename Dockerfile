# Playwright's image ships Chromium and its system libraries for the LinkedIn browser driver.
FROM mcr.microsoft.com/playwright:v1.55.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
# mkdir: npm may keep some packages (e.g. the pinned playwright) under server/node_modules; make sure the folder exists either way.
RUN npm run build && npm prune --omit=dev && mkdir -p server/node_modules

FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
