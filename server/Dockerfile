FROM node:22-alpine

WORKDIR /app

# Copy backend dependency manifests
COPY server/package*.json ./server/

# Dependency Install
RUN npm ci --omit=dev --prefix ./server

# backend source code
COPY server ./server

# Copy frontend files
COPY public ./public

# Production environment
ENV NODE_ENV=production
ENV PORT=4000

# Run as a non-root user
USER node

EXPOSE 4000

# Container health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server

CMD ["npm", "start"]