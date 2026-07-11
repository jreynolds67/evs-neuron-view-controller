# Pinned to 20.19-alpine (>= 20.15) because server/zip.js imports { crc32 } from node:zlib,
# which was added in Node 20.15. ESM validates named core imports at load, so a floating
# node:20-alpine tag resolving to an older 20.x would crash the WHOLE app on startup, not
# just backups. Bump deliberately.
FROM node:20.19-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source
COPY server ./server
COPY public ./public
COPY private ./private

# Config lives on a mounted volume so it survives redeploys
ENV CONFIG_PATH=/data/config.json
ENV PORT=8080
VOLUME ["/data"]

EXPOSE 8080

CMD ["node", "server/index.js"]
