FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/app/data PORT=3080
VOLUME ["/app/data"]
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3080/healthz || exit 1
CMD ["node", "server.js"]
