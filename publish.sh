#!/bin/bash
set -e

HOST="slayer.marioslab.io"
DIR="af.mariozechner.at"
GROQ_API_KEY="${GROQ_API_KEY:?GROQ_API_KEY environment variable required}"

echo "📦 Publishing to $HOST:~/$DIR"

# Create directory on server
ssh $HOST "mkdir -p ~/$DIR/data/live ~/$DIR/data/archive ~/$DIR/data/chunks"

# Sync only needed files (exclude data, node_modules, git)
rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude 'data' \
    --exclude '.git' \
    --exclude '*.log' \
    --exclude '.DS_Store' \
    --exclude 'docker-compose.local.yml' \
    ./ $HOST:~/$DIR/

# Deploy
ssh $HOST "cd ~/$DIR && \
    export GROQ_API_KEY='$GROQ_API_KEY' && \
    docker compose build && \
    docker compose up -d"

echo ""
echo "✅ Deployed to https://af.mariozechner.at"
