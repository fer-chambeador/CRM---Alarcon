# WA Bridge — usa el Chromium que trae Puppeteer (versión FIJA emparejada con
# whatsapp-web.js). Antes usábamos google-chrome-stable (última), pero se
# auto-actualizó a una versión que rompía el Store de WhatsApp (error "r").
FROM node:18-slim

# Dependencias de sistema que necesita el Chromium de Puppeteer (Debian bookworm)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-color-emoji \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 \
    libxshmfence1 libxss1 libxtst6 wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Que Puppeteer SÍ descargue su Chromium (a una ruta con permisos)
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app
COPY package.json ./
# npm install dispara la descarga del Chromium emparejado con la librería
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js stress-test.js ./

EXPOSE 3009
CMD ["node", "server.js"]
