FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --include=dev && npm run build \
    && mkdir -p /data/snapshots && chown -R node:node /data
ENV NODE_ENV=production PORT=4000 DATABASE_PATH=/data/proof.db SNAPSHOT_DIR=/data/snapshots
USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "server/index.ts"]
