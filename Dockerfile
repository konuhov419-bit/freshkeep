FROM node:25-alpine
ARG GIT_SHA=dev
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY migrations ./migrations
COPY web ./web
# данные и логи лежат в томах, приложение работает не от root
RUN mkdir -p data logs && chown -R node:node /app
USER node
ENV GIT_SHA=$GIT_SHA PORT=5173 DB_PATH=/app/data/freshkeep.db LOG_FILE=/app/logs/api.log
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:5173/api/ready || exit 1
CMD ["node", "server/index.js"]
