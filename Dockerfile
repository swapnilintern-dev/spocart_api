# SPOCART API — production image
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --omit=dev && npx prisma generate

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p uploads/designs && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
