# Agenda Copilot P95 — imagen endurecida (t6)
# Node 24 LTS, usuario no-root, sin dependencias npm (solo built-ins).
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    APP_HOST=0.0.0.0 \
    HOST=0.0.0.0 \
    TIMEZONE=America/Bogota

WORKDIR /app

# Código de la app (sin tests, sin data/ real y sin .env: ver .dockerignore).
COPY package.json server.mjs start.mjs ./
COPY lib ./lib
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts

# Directorio de datos con permisos del usuario sin privilegios.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]

# Healthcheck sin curl: http nativo de Node (sale 0 solo con /api/health 200).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('node:http');const port=process.env.PORT||3000;const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:4000},(res)=>{res.resume();res.on('end',()=>process.exit(res.statusCode===200?0:1));});req.on('timeout',()=>{req.destroy();process.exit(1);});req.on('error',()=>process.exit(1));"

CMD ["node", "server.mjs"]
