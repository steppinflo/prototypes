# RKB Obsidian portal - zero npm dependencies (Node's built-in HTTP server and SQLite).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4300 \
    RKB_DB_PATH=/app/data/rkb-obsidian.db

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docs/synthetic_supply_chain_dataset.csv ./docs/synthetic_supply_chain_dataset.csv

EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4300/api/meta > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
