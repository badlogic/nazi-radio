import fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import { transcribeAudio, TranscriptSegment } from "./transcribe.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const API_ENDPOINTS = [
    "https://austriafirst.at/wp-json/af-posts/v1/listen-back",  // Shows/Interviews
    "https://austriafirst.at/wp-json/af-posts/v1/posts",        // News/Journal
];
const SCRAPE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface ArchiveEpisode {
    id: string;
    wpId: number;
    url: string;
    title: string;
    timestamp: string;
    audioFile: string;
    transcript: TranscriptSegment[];
}

interface APIEpisode {
    id: number;
    title: string;
    content: string;
    date: string;
    link: string;
    image_url: string;
    audio_url: string;
    has_audio: boolean;
}

interface FlareSolverrResponse {
    status: string;
    message: string;
    solution: {
        url: string;
        status: number;
        cookies: Array<{ name: string; value: string }>;
        userAgent: string;
        response: string;
    };
}

let cfCookie: string | null = null;
let cfUserAgent: string | null = null;

async function fetchViaFlareSolverr(url: string): Promise<string> {
    console.log(`   🔓 Fetching via FlareSolverr...`);
    
    const response = await fetch(FLARESOLVERR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            cmd: "request.get",
            url,
            maxTimeout: 60000,
        }),
    });

    const data: FlareSolverrResponse = await response.json();
    
    if (data.status !== "ok") {
        throw new Error(`FlareSolverr failed: ${data.message}`);
    }

    // Extract and cache cookies
    const cfClearance = data.solution.cookies.find(c => c.name === "cf_clearance");
    if (cfClearance) {
        cfCookie = `cf_clearance=${cfClearance.value}`;
        cfUserAgent = data.solution.userAgent;
    }

    // Strip HTML wrapper if present
    let content = data.solution.response;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
        content = jsonMatch[0];
    }

    return content;
}

async function downloadAudio(url: string, outputPath: string): Promise<void> {
    if (!cfCookie) {
        // Get cookie first
        await fetchViaFlareSolverr(API_ENDPOINTS[0]);
    }

    console.log(`   ⬇️  Downloading ${path.basename(url)}...`);

    const response = await fetch(url, {
        headers: {
            Cookie: cfCookie!,
            "User-Agent": cfUserAgent!,
        },
    });

    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    console.log(`      Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
}

async function fetchEpisodes(): Promise<APIEpisode[]> {
    const allEpisodes: APIEpisode[] = [];
    const seenIds = new Set<number>();
    
    for (const apiUrl of API_ENDPOINTS) {
        console.log(`   Fetching ${apiUrl.split('/').pop()}...`);
        try {
            const content = await fetchViaFlareSolverr(apiUrl);
            const episodes: APIEpisode[] = JSON.parse(content);
            
            for (const ep of episodes) {
                if (ep.has_audio && ep.audio_url && !seenIds.has(ep.id)) {
                    seenIds.add(ep.id);
                    allEpisodes.push(ep);
                }
            }
        } catch (err) {
            console.error(`   Failed to fetch ${apiUrl}:`, err);
        }
    }
    
    return allEpisodes;
}

async function processEpisode(episode: APIEpisode, archiveDir: string): Promise<ArchiveEpisode | null> {
    const date = episode.date.split(" ")[0]; // "2026-01-18"
    const slug = episode.link.split("/").filter(Boolean).pop() || `episode-${episode.id}`;
    const safeSlug = slug.slice(0, 60).replace(/[^a-zA-Z0-9-]/g, "-");
    const id = `${date}_${safeSlug}`;
    
    const episodeDir = path.join(archiveDir, id);
    const audioFile = path.join(episodeDir, "audio.mp3");
    const jsonFile = path.join(episodeDir, "episode.json");

    // Check if already processed
    if (fsSync.existsSync(jsonFile)) {
        console.log(`   ⏭️  Already processed`);
        try {
            return JSON.parse(await fs.readFile(jsonFile, "utf-8"));
        } catch {
            // Corrupted, reprocess
        }
    }

    await fs.mkdir(episodeDir, { recursive: true });

    // Download audio
    await downloadAudio(episode.audio_url, audioFile);

    // Transcribe
    const transcript = await transcribeAudio(audioFile);

    const result: ArchiveEpisode = {
        id,
        wpId: episode.id,
        url: episode.link,
        title: episode.title,
        timestamp: episode.date.replace(" ", "T") + "+01:00",
        audioFile: `archive/${id}/audio.mp3`,
        transcript,
    };

    await fs.writeFile(jsonFile, JSON.stringify(result, null, 2));

    console.log(`   ✅ "${transcript[0]?.text.slice(0, 50)}..."`);

    return result;
}

async function updateIndex(archiveDir: string): Promise<void> {
    const entries = await fs.readdir(archiveDir, { withFileTypes: true });
    const episodes: ArchiveEpisode[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const jsonFile = path.join(archiveDir, entry.name, "episode.json");
        if (fsSync.existsSync(jsonFile)) {
            try {
                const episode = JSON.parse(await fs.readFile(jsonFile, "utf-8"));
                episodes.push(episode);
            } catch {}
        }
    }

    episodes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const indexPath = path.join(archiveDir, "index.json");
    await fs.writeFile(indexPath, JSON.stringify(episodes, null, 2));
    console.log(`📋 Updated index: ${episodes.length} episodes`);
}

async function runScraperOnce(): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🔍 Archive Scraper - ${new Date().toISOString()}`);
    console.log(`${"=".repeat(60)}\n`);

    // Test FlareSolverr
    try {
        const test = await fetch(FLARESOLVERR_URL.replace("/v1", "/health"));
        if (!test.ok) throw new Error("Not healthy");
    } catch {
        console.error("❌ FlareSolverr not available at", FLARESOLVERR_URL);
        return;
    }

    const archiveDir = path.join(DATA_DIR, "archive");
    await fs.mkdir(archiveDir, { recursive: true });

    // Fetch episodes from API
    console.log("📡 Fetching episodes from API...");
    const episodes = await fetchEpisodes();
    console.log(`   Found ${episodes.length} episodes with audio\n`);

    for (const episode of episodes) {
        console.log(`\n📼 ${episode.date.split(" ")[0]}: ${episode.title.slice(0, 40)}`);
        try {
            await processEpisode(episode, archiveDir);
        } catch (err) {
            console.error(`   ❌ Failed:`, err);
        }
    }

    await updateIndex(archiveDir);
    
    // Reset cookies for next run
    cfCookie = null;
    cfUserAgent = null;
}

async function runScraperLoop(): Promise<void> {
    console.log("🔍 Austria First Archive Scraper");
    console.log(`   APIs: ${API_ENDPOINTS.length} endpoints`);
    console.log(`   FlareSolverr: ${FLARESOLVERR_URL}`);
    console.log(`   Data dir: ${DATA_DIR}`);
    console.log(`   Interval: ${SCRAPE_INTERVAL_MS / 1000 / 60} minutes\n`);

    if (!process.env.GROQ_API_KEY) {
        console.error("❌ GROQ_API_KEY environment variable required");
        process.exit(1);
    }

    while (true) {
        try {
            await runScraperOnce();
        } catch (err) {
            console.error("❌ Scraper error:", err);
        }

        console.log(`\n💤 Sleeping for ${SCRAPE_INTERVAL_MS / 1000 / 60} minutes...`);
        await new Promise(r => setTimeout(r, SCRAPE_INTERVAL_MS));
    }
}

runScraperLoop().catch(console.error);
