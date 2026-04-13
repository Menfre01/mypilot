# Stage 1: Build Node.js backend
FROM node:20-alpine AS node-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/backend/ src/backend/
COPY src/shared/ src/shared/
RUN npm run build:backend

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=node-builder /app/dist/ dist/
USER node
EXPOSE 16321
CMD ["sh", "-c", "rm -f /home/node/.mypilot/gateway.pid && node dist/backend/cli.js gateway"]
