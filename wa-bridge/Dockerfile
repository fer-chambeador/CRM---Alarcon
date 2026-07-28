# WA Bridge (Baileys) — SIN navegador. Node 20 + toolchain por si alguna
# dependencia (libsignal) compila binarios nativos. No necesita Chromium.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./

EXPOSE 3009
CMD ["node", "server.js"]
