# --- Node.js build ---
FROM node:22-slim AS node-builder

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# --- Go build ---
FROM golang:1.24-bookworm AS go-builder

WORKDIR /build

# CGO is needed for go-sqlite3
RUN apt-get update && apt-get install -y gcc libc6-dev && rm -rf /var/lib/apt/lists/*

COPY go/ ./
RUN CGO_ENABLED=1 go build -o codegate-proxy ./cmd/codegate-proxy

# --- Production ---
FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=node-builder /app/dist ./dist
COPY --from=go-builder /build/codegate-proxy /usr/local/bin/codegate-proxy

# Startup script (sed strips Windows CRLF line endings)
COPY start.sh /app/start.sh
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV UI_PORT=9211
ENV PROXY_PORT=9212

EXPOSE 9211 9212

CMD ["/app/start.sh"]
