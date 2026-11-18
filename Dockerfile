# ========================================================
# Stage 1: Compile Java JDBC Bridge
# ========================================================
FROM openjdk:17-jdk-slim AS java-builder

WORKDIR /build
COPY ifxjdbc.jar UccxBridge.java ./
RUN javac --release 8 -encoding UTF-8 -cp ifxjdbc.jar UccxBridge.java

# ========================================================
# Stage 2: Production Node.js + JRE Runtime
# ========================================================
FROM node:20-bookworm-slim

# Install OpenJDK JRE (headless) for IBM Informix JDBC Driver
RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-17-jre-headless && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only required application runtime files
COPY config.js auth.js db.js server.js csqs.json ifxjdbc.jar ./
COPY --from=java-builder /build/UccxBridge.class ./UccxBridge.class
COPY public/ ./public/

RUN chown -R node:node /app
USER node

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
