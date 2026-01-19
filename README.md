# Austria First Radio Monitor

Monitors the FPÖ radio station "Austria First", transcribes speech segments, and archives episodes.

## Features

- **Live Monitor**: Records live stream, detects speech vs music via metadata, merges consecutive speech segments, transcribes with Groq Whisper
- **Archive Scraper**: Fetches archived episodes from the website API, downloads and transcribes
- **Web Frontend**: Displays transcripts with audio player and clickable timestamps

## Setup

```bash
# Install dependencies
npm install

# Required environment variable
export GROQ_API_KEY=your_key_here
```

## Local Development

```bash
# Start all services (with auto-reload on code changes)
docker-compose -f docker-compose.local.yml up

# Web UI at http://localhost:8080
```

## Production Deployment

```bash
# Deploy to slayer.marioslab.io
GROQ_API_KEY=$GROQ_API_KEY ./publish.sh
```

## Architecture

```
Services:
- web:          Caddy serving frontend + data at af.mariozechner.at
- monitor:      Live stream recording + transcription
- scraper:      Archive scraper (hourly)
- flaresolverr: Cloudflare bypass for scraper

Data:
- data/live/    Live broadcasts (merged speech segments)
- data/archive/ Archived episodes from website
- data/chunks/  Temporary recording chunks
```

## API Endpoints

- `/data/live/index.json` - List of live broadcasts
- `/data/archive/index.json` - List of archived episodes
- `/data/live/{id}/audio.mp3` - Audio file
- `/data/live/{id}/broadcast.json` - Transcript with timestamps
