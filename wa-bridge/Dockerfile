# WA Bridge — imagen con Chromium para whatsapp-web.js en Railway
FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdrm2 libgbm1 libnspr4 libnss3 libxcomposite1 libxdamage1 libxrandr2 \
    xdg-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js stress-test.js ./

EXPOSE 3009
CMD ["node", "server.js"]
