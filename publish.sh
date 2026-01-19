#!/bin/bash
set -e

HOST="slayer.marioslab.io"
DIR="af.mariozechner.at"

printHelp() {
    echo "Usage: publish.sh <command>"
    echo ""
    echo "Commands:"
    echo "  deploy       Sync files and restart services"
    echo "  logs         Tail all service logs"
    echo "  logs:mon     Tail monitor logs"
    echo "  logs:scraper Tail scraper logs"
    echo "  logs:web     Tail web logs"
    echo "  logs:flare   Tail flaresolverr logs"
    echo "  ps           Show running containers"
    echo "  restart      Restart all services"
    echo "  restart:mon  Restart monitor"
    echo "  restart:scraper Restart scraper"
    echo "  stop         Stop all services"
    echo "  shell:mon    Shell into monitor container"
    echo "  shell:scraper Shell into scraper container"
    echo ""
}

remoteCmd() {
    ssh $HOST "cd ~/$DIR && $1"
}

case "${1:-deploy}" in
deploy)
    GROQ_API_KEY="${GROQ_API_KEY:?GROQ_API_KEY environment variable required}"
    
    echo "📦 Deploying to $HOST:~/$DIR"
    
    # Create directories
    ssh $HOST "mkdir -p ~/$DIR/data/live ~/$DIR/data/archive ~/$DIR/data/chunks"
    
    # Sync files
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
    ;;
logs)
    remoteCmd "docker compose logs -f"
    ;;
logs:mon|logs:monitor)
    remoteCmd "docker compose logs -f monitor"
    ;;
logs:scraper)
    remoteCmd "docker compose logs -f scraper"
    ;;
logs:web)
    remoteCmd "docker compose logs -f web"
    ;;
logs:flare|logs:flaresolverr)
    remoteCmd "docker compose logs -f flaresolverr"
    ;;
ps|status)
    remoteCmd "docker compose ps"
    ;;
restart)
    remoteCmd "docker compose restart"
    ;;
restart:mon|restart:monitor)
    remoteCmd "docker compose restart monitor"
    ;;
restart:scraper)
    remoteCmd "docker compose restart scraper"
    ;;
stop)
    remoteCmd "docker compose stop"
    ;;
shell:mon|shell:monitor)
    ssh -t $HOST "cd ~/$DIR && docker compose exec monitor sh"
    ;;
shell:scraper)
    ssh -t $HOST "cd ~/$DIR && docker compose exec scraper sh"
    ;;
help|--help|-h)
    printHelp
    ;;
*)
    echo "Unknown command: $1"
    printHelp
    exit 1
    ;;
esac
