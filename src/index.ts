import { spawn, execSync } from "child_process";
import fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import { transcribeAudio, mergeAudioFiles, mergeTranscripts, generateTitle, TranscriptSegment } from "./transcribe.js";

// Config
const STREAM_URL = "https://stream.rcs.revma.com/3zudpqfxh0cwv";
const METADATA_URL = "https://www.revma.com/api/stations/3zudpqfxh0cwv/now_playing/";
const POLL_INTERVAL_MS = 1000;
const CHUNK_DURATION_SECS = 120;
const DATA_DIR = process.env.DATA_DIR || "./data";

export interface LiveBroadcast {
    id: string;
    title: string;
    timestamp: string;
    duration: number;  // ms
    audioFile: string; // relative path from data dir
    transcript: TranscriptSegment[];
}

interface MetadataSample {
    timestamp: number;
    wallClock: string;
    artist: string | null;
    title: string | null;
}

interface ChunkInfo {
    file: string;
    startTime: Date;
    duration: number;
    hasSpeech: boolean;
}

// Shared state
const metadataBuffer: MetadataSample[] = [];
let lastMetaStatus: "music" | "speech" = "music";

async function fetchMetadata(): Promise<{ artist: string | null; title: string | null }> {
    try {
        const res = await fetch(METADATA_URL);
        const data = await res.json();
        return { artist: data.artist || null, title: data.title || null };
    } catch {
        return { artist: null, title: null };
    }
}

function startMetadataPoller() {
    setInterval(async () => {
        const meta = await fetchMetadata();
        const now = Date.now();

        metadataBuffer.push({
            timestamp: now,
            wallClock: new Date(now).toISOString(),
            ...meta,
        });

        lastMetaStatus = meta.artist ? "music" : "speech";
        const status = meta.artist ? `🎵 ${meta.artist} - ${meta.title}` : "🎤 Speech";
        process.stdout.write(`\r  ${new Date().toLocaleTimeString("de-AT")} ${status.padEnd(50)}`);

        // Keep only last 15 minutes
        const cutoff = now - 15 * 60 * 1000;
        while (metadataBuffer.length > 0 && metadataBuffer[0].timestamp < cutoff) {
            metadataBuffer.shift();
        }
    }, POLL_INTERVAL_MS);
}

function chunkHasSpeech(startTime: Date, endTime: Date): boolean {
    const startMs = startTime.getTime();
    const endMs = endTime.getTime();
    
    const samples = metadataBuffer.filter(s => s.timestamp >= startMs && s.timestamp <= endMs);
    
    // Has speech if any sample has no artist
    return samples.some(s => !s.artist);
}

function getChunkSpeechRatio(startTime: Date, endTime: Date): number {
    const startMs = startTime.getTime();
    const endMs = endTime.getTime();
    
    const samples = metadataBuffer.filter(s => s.timestamp >= startMs && s.timestamp <= endMs);
    if (samples.length === 0) return 0;
    
    const speechSamples = samples.filter(s => !s.artist);
    return speechSamples.length / samples.length;
}

async function mergeBroadcast(chunks: ChunkInfo[], liveDir: string): Promise<LiveBroadcast | null> {
    if (chunks.length === 0) return null;

    const firstChunk = chunks[0];
    const id = firstChunk.startTime.toISOString().replace(/[:.]/g, "-");
    const broadcastDir = path.join(liveDir, id);
    
    await fs.mkdir(broadcastDir, { recursive: true });

    const audioFile = path.join(broadcastDir, "audio.mp3");
    const jsonFile = path.join(broadcastDir, "broadcast.json");

    console.log(`\n📼 Merging ${chunks.length} chunks into broadcast ${id}`);

    // Merge audio files
    const chunkPaths = chunks.map(c => c.file);
    await mergeAudioFiles(chunkPaths, audioFile);

    const totalDuration = chunks.reduce((sum, c) => sum + c.duration, 0);
    console.log(`   Merged audio: ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);

    // Transcribe merged file
    const transcript = await transcribeAudio(audioFile);

    // Generate title from first words
    const title = generateTitle(transcript, 10);

    const broadcast: LiveBroadcast = {
        id,
        title,
        timestamp: firstChunk.startTime.toISOString(),
        duration: totalDuration,
        audioFile: `live/${id}/audio.mp3`,
        transcript,
    };

    await fs.writeFile(jsonFile, JSON.stringify(broadcast, null, 2));

    // Clean up chunk files
    for (const chunk of chunks) {
        await fs.unlink(chunk.file).catch(() => {});
    }

    console.log(`   ✅ "${title}"`);

    return broadcast;
}

async function updateLiveIndex(liveDir: string): Promise<void> {
    const entries = await fs.readdir(liveDir, { withFileTypes: true });
    const broadcasts: LiveBroadcast[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const jsonFile = path.join(liveDir, entry.name, "broadcast.json");
        if (fsSync.existsSync(jsonFile)) {
            try {
                const broadcast = JSON.parse(await fs.readFile(jsonFile, "utf-8"));
                broadcasts.push(broadcast);
            } catch {}
        }
    }

    // Sort by timestamp descending
    broadcasts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const indexPath = path.join(liveDir, "index.json");
    await fs.writeFile(indexPath, JSON.stringify(broadcasts, null, 2));
    console.log(`📋 Updated live index: ${broadcasts.length} broadcasts`);
}

async function runService() {
    console.log("🔴 Austria First Radio Monitor");
    console.log(`   Stream: ${STREAM_URL}`);
    console.log(`   Data dir: ${DATA_DIR}`);
    console.log(`   Chunk duration: ${CHUNK_DURATION_SECS}s`);
    console.log();

    if (!process.env.GROQ_API_KEY) {
        console.error("❌ GROQ_API_KEY environment variable required");
        process.exit(1);
    }

    const chunksDir = path.join(DATA_DIR, "chunks");
    const liveDir = path.join(DATA_DIR, "live");
    await fs.mkdir(chunksDir, { recursive: true });
    await fs.mkdir(liveDir, { recursive: true });

    // Start metadata polling
    startMetadataPoller();

    // Accumulated speech chunks waiting to be merged
    let pendingChunks: ChunkInfo[] = [];
    const completedSegments = new Set<string>();
    let currentSegmentStart: Date | null = null;
    let isProcessing = false;

    async function processCompletedChunk(chunkFile: string, startTime: Date) {
        const endTime = new Date(startTime.getTime() + CHUNK_DURATION_SECS * 1000);
        const hasSpeech = chunkHasSpeech(startTime, endTime);
        const speechRatio = getChunkSpeechRatio(startTime, endTime);

        console.log(`\n✅ Chunk complete: ${path.basename(chunkFile)}`);
        console.log(`   Time: ${startTime.toLocaleTimeString("de-AT")} - ${endTime.toLocaleTimeString("de-AT")}`);
        console.log(`   Speech: ${hasSpeech ? "Yes" : "No"} (${(speechRatio * 100).toFixed(0)}%)`);

        if (hasSpeech) {
            pendingChunks.push({
                file: chunkFile,
                startTime,
                duration: CHUNK_DURATION_SECS * 1000,
                hasSpeech: true,
            });
            console.log(`   📦 Buffered (${pendingChunks.length} chunks pending)`);
        } else {
            // Music detected - if we have pending speech chunks, merge them
            if (pendingChunks.length > 0 && !isProcessing) {
                isProcessing = true;
                const chunksToMerge = [...pendingChunks];
                pendingChunks = [];

                try {
                    await mergeBroadcast(chunksToMerge, liveDir);
                    await updateLiveIndex(liveDir);
                } catch (err) {
                    console.error("❌ Merge failed:", err);
                }
                isProcessing = false;
            }

            // Delete the music-only chunk
            await fs.unlink(chunkFile).catch(() => {});
            console.log(`   🗑️  Deleted (music only)`);
        }
    }

    // Start ffmpeg recording with auto-restart
    const segmentPattern = path.join(chunksDir, "chunk-%Y%m%d-%H%M%S.mp3");

    function startRecording() {
        console.log("Starting ffmpeg recording...\n");

        const ffmpeg = spawn("ffmpeg", [
            "-y",
            "-reconnect", "1",
            "-reconnect_streamed", "1", 
            "-reconnect_delay_max", "5",
            "-i", STREAM_URL,
            "-c", "copy",
            "-f", "segment",
            "-segment_time", CHUNK_DURATION_SECS.toString(),
            "-strftime", "1",
            "-reset_timestamps", "1",
            segmentPattern,
        ], { stdio: ["ignore", "ignore", "pipe"] });

        ffmpeg.stderr.on("data", (data) => {
            const line = data.toString();
            const match = line.match(/Opening '([^']+)' for writing/);
            
            if (match) {
                const newFile = match[1];
                const segmentName = path.basename(newFile);

                if (currentSegmentStart && !completedSegments.has(segmentName)) {
                    const prevFiles = fsSync.readdirSync(chunksDir)
                        .filter(f => f.startsWith("chunk-") && f.endsWith(".mp3") && f !== segmentName)
                        .sort();

                    for (const prevFile of prevFiles) {
                        if (completedSegments.has(prevFile)) continue;
                        completedSegments.add(prevFile);

                        const audioFile = path.join(chunksDir, prevFile);

                        // Parse timestamp from filename (local time)
                        const tsMatch = prevFile.match(/chunk-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
                        if (tsMatch) {
                            const segmentStartTime = new Date(
                                parseInt(tsMatch[1]),
                                parseInt(tsMatch[2]) - 1,
                                parseInt(tsMatch[3]),
                                parseInt(tsMatch[4]),
                                parseInt(tsMatch[5]),
                                parseInt(tsMatch[6])
                            );

                            processCompletedChunk(audioFile, segmentStartTime);
                        }
                    }
                }

                currentSegmentStart = new Date();
            }
        });

        ffmpeg.on("exit", (code) => {
            console.error(`\nffmpeg exited with code ${code}, restarting in 5s...`);
            setTimeout(startRecording, 5000);
        });

        ffmpeg.on("error", (err) => {
            console.error("\nffmpeg error:", err, "restarting in 5s...");
            setTimeout(startRecording, 5000);
        });
    }

    startRecording();

    // Periodic flush: merge pending chunks if idle for too long
    setInterval(async () => {
        if (pendingChunks.length > 0 && !isProcessing) {
            const lastChunkTime = pendingChunks[pendingChunks.length - 1].startTime.getTime();
            const idleTime = Date.now() - lastChunkTime - CHUNK_DURATION_SECS * 1000;
            
            // If last chunk is > 5 minutes old, force merge
            if (idleTime > 5 * 60 * 1000) {
                console.log("\n⏰ Force merging due to idle timeout");
                isProcessing = true;
                const chunksToMerge = [...pendingChunks];
                pendingChunks = [];

                try {
                    await mergeBroadcast(chunksToMerge, liveDir);
                    await updateLiveIndex(liveDir);
                } catch (err) {
                    console.error("❌ Merge failed:", err);
                }
                isProcessing = false;
            }
        }
    }, 60 * 1000);

    // Keep process alive
    await new Promise(() => {});
}

// Run
runService();
