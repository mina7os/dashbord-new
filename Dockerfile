# syntax=docker/dockerfile:1

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
ARG APP_REVISION=40ec1ae
RUN echo "$APP_REVISION" > /tmp/app_revision

# Install deps first for Docker layer caching
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install Chromium and required system packages for Puppeteer/whatsapp-web.js
RUN apt-get update && apt-get install -y \
    chromium \
    curl \
    procps \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    fonts-noto-color-emoji \
    fonts-liberation \
    --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use installed Chromium instead of downloading its own
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy only production node_modules and built assets
COPY package*.json ./
RUN npm ci --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/public ./public

# Create persistent directory for WhatsApp sessions
RUN mkdir -p /app/.wwebjs_auth && chmod 755 /app/.wwebjs_auth

# Expose app port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

ENV NODE_ENV=production

CMD ["npx", "tsx", "server.ts"]
