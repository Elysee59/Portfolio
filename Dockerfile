# ══════════════════════════════════════════
#   ATELIER PORTFOLIO — Dockerfile (Cloudinary)
#   Plus léger : pas de libvips/sharp
# ══════════════════════════════════════════

FROM node:18-alpine

WORKDIR /app

# Dépendances système minimales
RUN apk add --no-cache dumb-init

# Installer les dépendances Node
COPY package*.json ./
RUN npm ci --only=production

# Code source
COPY server/  ./server/
COPY public/  ./public/

# Dossier pour la DB locale (cache)
RUN mkdir -p /data/uploads && chown -R node:node /data

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOADS_DIR=/data/uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
