import Groq from "groq-sdk";
import { spawn } from "child_process";
import fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";

// Groq Whisper limit is ~25MB, we use 20MB to be safe
const MAX_FILE_SIZE = 20 * 1024 * 1024;
// At 320kbps, 20MB ≈ 8.3 minutes. Use 8 min segments to be safe.
const SEGMENT_DURATION_SECS = 480;

export interface TranscriptSegment {
    start: number;  // milliseconds
    end: number;    // milliseconds
    text: string;
}

interface GroqSegment {
    id: number;
    seek: number;
    start: number;  // seconds
    end: number;    // seconds
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
}

interface GroqTranscriptionResult {
    task: string;
    language: string;
    duration: number;
    text: string;
    segments: GroqSegment[];
}

async function getFileSize(filePath: string): Promise<number> {
    const stats = await fs.stat(filePath);
    return stats.size;
}

async function splitAudioFile(inputPath: string, outputDir: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const outputPattern = path.join(outputDir, "segment_%03d.mp3");

        const ffmpeg = spawn("ffmpeg", [
            "-y",
            "-i", inputPath,
            "-f", "segment",
            "-segment_time", SEGMENT_DURATION_SECS.toString(),
            "-c", "copy",  // Don't re-encode, just copy
            outputPattern,
        ]);

        let errorOutput = "";
        ffmpeg.stderr.on("data", (data) => {
            errorOutput += data.toString();
        });

        ffmpeg.on("error", (error) => {
            reject(new Error(`Failed to start FFmpeg: ${error.message}`));
        });

        ffmpeg.on("exit", async (code) => {
            if (code === 0) {
                const files = await fs.readdir(outputDir);
                const segmentFiles = files
                    .filter(f => f.startsWith("segment_") && f.endsWith(".mp3"))
                    .sort()
                    .map(f => path.join(outputDir, f));
                resolve(segmentFiles);
            } else {
                reject(new Error(`FFmpeg failed with code ${code}: ${errorOutput}`));
            }
        });
    });
}

async function transcribeChunk(audioPath: string): Promise<GroqTranscriptionResult> {
    const groq = new Groq();

    const result = await groq.audio.transcriptions.create({
        file: fsSync.createReadStream(audioPath),
        model: "whisper-large-v3-turbo",
        response_format: "verbose_json",
        language: "de",  // German
    });

    return result as GroqTranscriptionResult;
}

/**
 * Transcribe an audio file, automatically splitting if > 20MB
 * Returns transcript segments with timestamps in milliseconds
 */
export async function transcribeAudio(inputPath: string): Promise<TranscriptSegment[]> {
    const fileSize = await getFileSize(inputPath);
    const fileName = path.basename(inputPath);

    if (fileSize <= MAX_FILE_SIZE) {
        // Small file, transcribe directly
        console.log(`  🎤 Transcribing ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)...`);
        const result = await transcribeChunk(inputPath);
        return result.segments.map(seg => ({
            start: Math.round(seg.start * 1000),
            end: Math.round(seg.end * 1000),
            text: seg.text.trim(),
        }));
    }

    // Large file, need to split
    console.log(`  🎤 Transcribing ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB) - splitting...`);
    
    const tempDir = await fs.mkdtemp(path.join(path.dirname(inputPath), "split_"));
    
    try {
        const chunkFiles = await splitAudioFile(inputPath, tempDir);
        console.log(`     Split into ${chunkFiles.length} chunks`);

        const allSegments: TranscriptSegment[] = [];
        let timeOffsetMs = 0;

        for (let i = 0; i < chunkFiles.length; i++) {
            const chunkFile = chunkFiles[i];
            const chunkSize = await getFileSize(chunkFile);
            console.log(`     Chunk ${i + 1}/${chunkFiles.length} (${(chunkSize / 1024 / 1024).toFixed(1)}MB)...`);

            const result = await transcribeChunk(chunkFile);

            // Add segments with time offset
            for (const seg of result.segments) {
                allSegments.push({
                    start: Math.round(seg.start * 1000) + timeOffsetMs,
                    end: Math.round(seg.end * 1000) + timeOffsetMs,
                    text: seg.text.trim(),
                });
            }

            // Update offset for next chunk (use actual duration from result)
            timeOffsetMs += Math.round(result.duration * 1000);
        }

        return allSegments;
    } finally {
        // Clean up temp files
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Merge multiple MP3 files into one
 */
export async function mergeAudioFiles(inputPaths: string[], outputPath: string): Promise<void> {
    if (inputPaths.length === 0) {
        throw new Error("No input files to merge");
    }

    if (inputPaths.length === 1) {
        // Just copy the single file
        await fs.copyFile(inputPaths[0], outputPath);
        return;
    }

    // Create concat list file
    const listFile = outputPath + ".txt";
    const listContent = inputPaths.map(p => `file '${p}'`).join("\n");
    await fs.writeFile(listFile, listContent);

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", listFile,
            "-c", "copy",
            outputPath,
        ]);

        let errorOutput = "";
        ffmpeg.stderr.on("data", (data) => {
            errorOutput += data.toString();
        });

        ffmpeg.on("error", (error) => {
            fs.unlink(listFile).catch(() => {});
            reject(new Error(`Failed to start FFmpeg: ${error.message}`));
        });

        ffmpeg.on("exit", async (code) => {
            await fs.unlink(listFile).catch(() => {});
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg merge failed with code ${code}: ${errorOutput}`));
            }
        });
    });
}

/**
 * Merge transcripts from multiple consecutive recordings
 * Adjusts timestamps based on audio durations
 */
export function mergeTranscripts(
    transcripts: TranscriptSegment[][],
    durationsMs: number[]
): TranscriptSegment[] {
    const merged: TranscriptSegment[] = [];
    let timeOffsetMs = 0;

    for (let i = 0; i < transcripts.length; i++) {
        for (const seg of transcripts[i]) {
            merged.push({
                start: seg.start + timeOffsetMs,
                end: seg.end + timeOffsetMs,
                text: seg.text,
            });
        }
        timeOffsetMs += durationsMs[i];
    }

    return merged;
}

/**
 * Generate a title from the first N words of transcript
 */
export function generateTitle(segments: TranscriptSegment[], maxWords: number = 10): string {
    const fullText = segments.map(s => s.text).join(" ");
    const words = fullText.split(/\s+/).filter(w => w.length > 0);
    const title = words.slice(0, maxWords).join(" ");
    return title + (words.length > maxWords ? "..." : "");
}
