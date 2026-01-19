FROM node:22-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies (baked in)
COPY package*.json ./
RUN npm ci

# Source files will be mounted, not copied
# Default command - override in docker-compose
CMD ["npx", "tsx", "watch", "src/index.ts"]
