# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Non-root user
RUN addgroup -S app && adduser -S app -G app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
USER app
EXPOSE 8080
# Health check hits the HTTP server the app starts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
# Run migrations, then start the bot. (Worker service overrides this command.)
CMD ["sh", "-c", "node dist/scripts/migrate.js && node --enable-source-maps dist/index.js"]
