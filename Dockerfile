# ─── Olimpistas — plataforma de socios de Olimpia ────────────────────────────
# Proyecto standalone. Imagen autocontenida.
#
# Build (Cloud Build, sin Docker local):
#   gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/olimpistas/app .
#
# Variables de entorno relevantes:
#   PORT                     (Cloud Run lo inyecta; default 3002 en local)
#   OLIMPISTAS_DATABASE_URL  Postgres propio. Sin ella → store en memoria (demo).
#   PAGOPAR_PUBLIC_TOKEN     Token público del comercio PAGOPAR.
#   PAGOPAR_PRIVATE_TOKEN    Token privado. Con ambos, se activa el cobro real.
#   PAGOPAR_ENV              'prod' para producción; cualquier otro = sandbox.
# ─────────────────────────────────────────────────────────────────────────────

# Debian slim: binarios precompilados de bcrypt sin necesidad de toolchain.
FROM node:20-slim

WORKDIR /app

# Deps — capa cacheable.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Código de la app.
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
