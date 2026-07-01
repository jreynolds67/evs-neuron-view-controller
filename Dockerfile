FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source
COPY server ./server
COPY public ./public

# Config lives on a mounted volume so it survives redeploys
ENV CONFIG_PATH=/data/config.json
ENV PORT=8080
VOLUME ["/data"]

EXPOSE 8080

CMD ["node", "server/index.js"]
