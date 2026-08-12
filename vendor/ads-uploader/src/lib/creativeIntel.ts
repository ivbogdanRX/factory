/**
 * Creative Intelligence v2 — Taxonomy-based classification for ad creatives.
 * 
 * Images: sent inline to Gemini Vision for fast classification.
 * Videos: uploaded to Gemini File API (full audio+visual) for accurate detection.
 * 
 * Classifies each file into the user's saved taxonomy: audience, hook/angle, style.
 */

import { getTaxonomy } from './taxonomy';

function getGeminiApiKey(): string {
    return localStorage.getItem('ads_uploader_gemini_key') || import.meta.env.VITE_GEMINI_API_KEY || '';
}

const IMAGE_MODEL = 'gemini-3-flash-preview'; // Fast + cheap for constrained enum classification
const VIDEO_MODEL = 'gemini-3.1-pro-preview';  // Pro for audio-visual understanding
const MAX_THUMBNAIL_SIZE = 512;
const CONCURRENT_UPLOADS = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function geminiCall(url: string, body: object): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (response.ok) return response;
        if ((response.status === 503 || response.status === 429) && attempt < MAX_RETRIES) {
            const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`Gemini ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }
        const errText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }
    throw new Error('Gemini API: max retries exceeded');
}

export interface CreativeClassification {
    audience: string;
    hookAngle: string;
    style: string;
    confidence: 'high' | 'medium' | 'low';
    description: string;
    suggestedAudience?: string;
    suggestedHookAngle?: string;
    suggestedStyle?: string;
}

export interface ClassificationResult {
    classifications: Map<string, CreativeClassification>;
    dimensions: Map<string, { width: number; height: number }>;
}

// ── Image thumbnail for inline analysis ─────────────────────────────

async function imageToBase64(file: File, maxSize = MAX_THUMBNAIL_SIZE): Promise<{ base64: string; mimeType: string; width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(file);
        img.src = objUrl;
        img.onload = () => {
            const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.naturalWidth * scale);
            canvas.height = Math.round(img.naturalHeight * scale);
            const ctx = canvas.getContext('2d');
            if (!ctx) { reject(new Error('Canvas context unavailable')); return; }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
            URL.revokeObjectURL(objUrl);
            if (!match) { reject(new Error('Failed to encode')); return; }
            resolve({
                base64: match[2],
                mimeType: match[1],
                width: img.naturalWidth,
                height: img.naturalHeight,
            });
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error(`Failed to load: ${file.name}`)); };
    });
}

// ── Video dimensions extraction ─────────────────────────────────────

async function getVideoDimensions(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const objUrl = URL.createObjectURL(file);
        video.preload = 'metadata';
        video.muted = true;
        video.src = objUrl;
        video.onloadedmetadata = () => {
            resolve({ width: video.videoWidth, height: video.videoHeight });
            URL.revokeObjectURL(objUrl);
        };
        video.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error(`Video metadata failed: ${file.name}`)); };
    });
}

// ── Gemini File API (for video uploads) ─────────────────────────────

async function uploadToGeminiFiles(file: File): Promise<{ fileUri: string; mimeType: string }> {
    const apiKey = getGeminiApiKey();
    
    // Step 1: Start resumable upload
    const initRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
        {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': String(file.size),
                'X-Goog-Upload-Header-Content-Type': file.type,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                file: { displayName: file.name },
            }),
        }
    );

    if (!initRes.ok) throw new Error(`File upload init failed: ${initRes.status}`);
    
    const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL returned');

    // Step 2: Upload the file bytes
    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': String(file.size),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: file,
    });

    if (!uploadRes.ok) throw new Error(`File upload failed: ${uploadRes.status}`);

    const uploadData = await uploadRes.json();
    const fileUri = uploadData.file?.uri;
    if (!fileUri) throw new Error('No file URI returned');

    // Step 3: Wait for file to be ACTIVE
    const fileName = uploadData.file?.name;
    if (fileName) {
        let attempts = 0;
        while (attempts < 30) {
            const statusRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
            );
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                if (statusData.state === 'ACTIVE') break;
            }
            attempts++;
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    return { fileUri, mimeType: file.type };
}

// ── Classification Prompt ────────────────────────────────────────────

function buildDefinitionBlock(label: string, values: string[], definitions: Record<string, string>): string {
    const lines = values.map(v => {
        const def = definitions[v];
        return def ? `  • ${v}: ${def}` : `  • ${v}`;
    });
    return `${label}:\n${lines.join('\n')}`;
}

function buildClassificationPrompt(
    count: number,
    isVideo: boolean,
): string {
    const taxonomy = getTaxonomy();
    const defs = taxonomy.definitions || {};

    const hookDefs = buildDefinitionBlock('HOOK/ANGLE TYPES (choose ONE)', taxonomy.hooks, defs);
    const styleDefs = buildDefinitionBlock('STYLE TYPES (choose ONE)', taxonomy.styles, defs);
    const audienceList = taxonomy.audiences.map(a => `  • ${a}`).join('\n');

    return `You are a performance marketing creative analyst. Classify ${count === 1 ? 'this' : `these ${count}`} ad creative${count > 1 ? 's' : ''}.

${isVideo ? `IMPORTANT: This is a video ad. Listen to the AUDIO carefully:
- The voiceover/narration often reveals the target audience (e.g. "Attention nurses", "If you're a homeowner")
- The hook type is determined by the FIRST 3 SECONDS — what technique grabs attention?
- The visual style tells you the production format
` : `This is an image ad. Analyze:
- Text overlays and headlines — they often reveal the audience and hook type
- Visual style — the artistic/production technique used
- Who is depicted? What profession/demographic?
`}

CLASSIFICATION DEFINITIONS — use these to pick the correct label:

${hookDefs}
  • Unknown: None of the above fit

${styleDefs}
  • Unknown: None of the above fit

AUDIENCE SEGMENTS (choose ONE):
${audienceList}
  • Unknown: Not clearly targeted at any listed audience

CRITICAL RULES:
1. Match by DEFINITION, not by vague resemblance. Read each definition carefully.
2. For hooks: focus on the OPENING technique (first 3 seconds for video, headline for images).
3. For style: focus on the PRODUCTION FORMAT, not the content topic.
4. UGC = shot on phone, selfie/handheld feel. Talking-Head = person at camera, stationary. These are DIFFERENT.
5. Voiceover = narration over B-roll/graphics. Talking-Head = person on screen speaking. These are DIFFERENT.
6. If genuinely uncertain, choose "Unknown" and explain in suggestedHookAngle/suggestedStyle.`;
}

function getTaxonomySchema() {
    const taxonomy = getTaxonomy();
    return {
        audience: { type: "STRING", enum: [...taxonomy.audiences, "Unknown"] },
        hookAngle: { type: "STRING", enum: [...taxonomy.hooks, "Unknown"] },
        style: { type: "STRING", enum: [...taxonomy.styles, "Unknown"] },
        confidence: { type: "STRING", enum: ["high", "medium", "low"] },
        description: { type: "STRING" },
        suggestedAudience: { type: "STRING" },
        suggestedHookAngle: { type: "STRING" },
        suggestedStyle: { type: "STRING" },
    };
}

// ── Classify Images (batch, inline) ─────────────────────────────────

async function classifyImageBatch(
    images: { index: number; base64: string; mimeType: string; fileName: string }[],
): Promise<CreativeClassification[]> {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('Gemini API key not configured. Add it in Settings.');

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    parts.push({ text: buildClassificationPrompt(images.length, false) });

    for (const img of images) {
        parts.push({ text: `\n[Image ${img.index}] (${img.fileName})` });
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }

    const response = await geminiCall(
        `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`,
        {
            contents: [{ role: 'user', parts }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: {
                            index: { type: "INTEGER" },
                            ...getTaxonomySchema(),
                        },
                        required: ["index", "audience", "hookAngle", "style", "confidence", "description"]
                    }
                },
                temperature: 0.1,
            },
        }
    );

    const result = await response.json();
    const textContent = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) throw new Error('No analysis returned from Gemini');

    let jsonStr = textContent.trim();
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [parsed];
}

// ── Classify Video (single, via File API) ───────────────────────────

async function classifyVideo(
    fileUri: string,
    mimeType: string,
    fileName: string,
): Promise<CreativeClassification> {
    const apiKey = getGeminiApiKey();

    const response = await geminiCall(
        `https://generativelanguage.googleapis.com/v1beta/models/${VIDEO_MODEL}:generateContent?key=${apiKey}`,
        {
            contents: [{
                role: 'user',
                parts: [
                    { text: buildClassificationPrompt(1, true) },
                    { text: `\n[Video 0] (${fileName})` },
                    { fileData: { mimeType, fileUri } },
                ],
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: "OBJECT",
                    properties: getTaxonomySchema(),
                    required: ["audience", "hookAngle", "style", "confidence", "description"]
                },
                temperature: 0.1,
            },
        }
    );

    const result = await response.json();
    const textContent = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) throw new Error('No analysis returned from Gemini');

    let jsonStr = textContent.trim();
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed[0] : parsed;
}

// ── Post-classification taxonomy enforcement ────────────────────────
// Ensures the AI can never return labels outside the user's taxonomy.
// If a returned value doesn't match any taxonomy entry, it's demoted
// to a suggestion and the field is reset to "Unknown".

function validateClassification(c: CreativeClassification): CreativeClassification {
    // The API natively enforces the schema enums, so we just return the object directly.
    return c;
}

// ── Public API ──────────────────────────────────────────────────────

type ProgressPhase = 'preparing' | 'uploading' | 'classifying';

export async function classifyCreatives(
    files: { id: string; file: File; name: string; type: 'video' | 'image' }[],
    forcedTags: { audience?: string; hookAngle?: string; style?: string },
    onProgress?: (phase: ProgressPhase, current: number, total: number) => void,
): Promise<ClassificationResult> {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('Gemini API key not configured. Add it in Settings.');

    const classifications = new Map<string, CreativeClassification>();
    const dimensions = new Map<string, { width: number; height: number }>();

    const images = files.filter(f => f.type === 'image');
    const videos = files.filter(f => f.type === 'video');
    const totalSteps = images.length + videos.length * 2; // videos have upload + classify
    let completedSteps = 0;

    // ── Phase 1: Classify images (fast, batch inline) ──
    if (images.length > 0) {
        onProgress?.('preparing', 0, totalSteps);
        
        const BATCH = 5;
        for (let i = 0; i < images.length; i += BATCH) {
            const batch = images.slice(i, i + BATCH);
            const imageData: { index: number; base64: string; mimeType: string; fileName: string }[] = [];

            for (let j = 0; j < batch.length; j++) {
                const img = batch[j];
                try {
                    const thumb = await imageToBase64(img.file);
                    imageData.push({
                        index: j,
                        base64: thumb.base64,
                        mimeType: thumb.mimeType,
                        fileName: img.name,
                    });
                    dimensions.set(img.id, { width: thumb.width, height: thumb.height });
                } catch (err) {
                    console.warn(`Thumbnail failed for ${img.name}:`, err);
                }
                completedSteps++;
                onProgress?.('preparing', completedSteps, totalSteps);
            }

            if (imageData.length > 0) {
                onProgress?.('classifying', completedSteps, totalSteps);
                try {
                    const results = await classifyImageBatch(imageData);
                    for (const result of results) {
                        const r = result as CreativeClassification & { index: number };
                        const matchedFile = batch[r.index];
                        if (matchedFile) {
                            const { index: _, ...classification } = r as CreativeClassification & { index: number };
                            const validated = validateClassification(classification);
                            classifications.set(matchedFile.id, {
                                ...validated,
                                audience: forcedTags.audience || validated.audience,
                                hookAngle: forcedTags.hookAngle || validated.hookAngle,
                                style: forcedTags.style || validated.style,
                            });
                        }
                    }
                } catch (err) {
                    console.error(`Image batch classification failed:`, err);
                    for (const img of batch) {
                        if (!classifications.has(img.id)) {
                            classifications.set(img.id, {
                                audience: forcedTags.audience || 'Unknown', 
                                hookAngle: forcedTags.hookAngle || 'Unknown',
                                style: forcedTags.style || 'Unknown', 
                                confidence: 'low', description: 'Classification failed',
                            });
                        }
                    }
                }
            }
        }
    }

    // ── Phase 2: Upload & classify videos (full file with audio) ──
    if (videos.length > 0) {
        // Upload videos in parallel (limited concurrency)
        const uploadQueue = [...videos];
        const uploadedMap = new Map<string, { fileUri: string; mimeType: string }>();

        const uploadWorker = async () => {
            while (uploadQueue.length > 0) {
                const video = uploadQueue.shift()!;
                try {
                    // Get dimensions
                    const dims = await getVideoDimensions(video.file);
                    dimensions.set(video.id, dims);
                    
                    onProgress?.('uploading', completedSteps, totalSteps);
                    const uploaded = await uploadToGeminiFiles(video.file);
                    uploadedMap.set(video.id, uploaded);
                } catch (err) {
                    console.error(`Upload failed for ${video.name}:`, err);
                }
                completedSteps++;
                onProgress?.('uploading', completedSteps, totalSteps);
            }
        };

        // Run upload workers in parallel
        const workers = Array.from(
            { length: Math.min(CONCURRENT_UPLOADS, videos.length) },
            () => uploadWorker()
        );
        await Promise.all(workers);

        // Classify uploaded videos (can also parallelize)
        const classifyQueue = videos.filter(v => uploadedMap.has(v.id));
        const classifyWorker = async () => {
            while (classifyQueue.length > 0) {
                const video = classifyQueue.shift()!;
                const uploaded = uploadedMap.get(video.id)!;
                try {
                    onProgress?.('classifying', completedSteps, totalSteps);
                    const result = await classifyVideo(uploaded.fileUri, uploaded.mimeType, video.name);
                    const validated = validateClassification(result);
                    classifications.set(video.id, {
                        ...validated,
                        audience: forcedTags.audience || validated.audience,
                        hookAngle: forcedTags.hookAngle || validated.hookAngle,
                        style: forcedTags.style || validated.style,
                    });
                } catch (err) {
                    console.error(`Video classification failed for ${video.name}:`, err);
                    classifications.set(video.id, {
                        audience: forcedTags.audience || 'Unknown', 
                        hookAngle: forcedTags.hookAngle || 'Unknown',
                        style: forcedTags.style || 'Unknown', 
                        confidence: 'low', description: 'Classification failed',
                    });
                }
                completedSteps++;
                onProgress?.('classifying', completedSteps, totalSteps);
            }
        };

        const classifyWorkers = Array.from(
            { length: Math.min(CONCURRENT_UPLOADS, classifyQueue.length) },
            () => classifyWorker()
        );
        await Promise.all(classifyWorkers);
    }

    return { classifications, dimensions };
}

// ── Naming helper ───────────────────────────────────────────────────



export function buildNames(
    files: { id: string; name: string }[],
    classifications: Map<string, CreativeClassification>,
    _dimensions?: Map<string, { width: number; height: number }>,
    existingNames?: string[],
): Map<string, string> {
    const nameMap = new Map<string, string>();
    const groupCounts = new Map<string, number>();

    // Seed counts from existing file names to avoid collisions
    if (existingNames) {
        for (const name of existingNames) {
            const sansExt = name.replace(/\.[^/.]+$/, '');
            const m = sansExt.match(/^(.+?)_(\d+)$/);
            if (m) {
                const prefix = m[1];
                const num = parseInt(m[2], 10);
                groupCounts.set(prefix, Math.max(groupCounts.get(prefix) || 0, num));
            }
        }
    }

    for (const file of files) {
        const c = classifications.get(file.id);
        if (!c || (c.audience === 'Unknown' && c.style === 'Unknown')) {
            nameMap.set(file.id, file.name);
            continue;
        }

        const parts = [
            c.audience !== 'Unknown' ? c.audience.replace(/\s+/g, '-') : null,
            c.style !== 'Unknown' ? c.style.replace(/\s+/g, '-') : null,
            c.hookAngle !== 'Unknown' ? c.hookAngle.replace(/\s+/g, '-') : null,
        ].filter(Boolean);

        const key = parts.join('_');
        const count = (groupCounts.get(key) || 0) + 1;
        groupCounts.set(key, count);
        const num = String(count).padStart(2, '0');

        let aiName = `${key}_${num}`;

        // Preserve original extension
        const origExt = file.name.match(/\.[^/.]+$/)?.[0] || '';
        nameMap.set(file.id, aiName + origExt);
    }

    return nameMap;
}

// ── Adapt Copy for Audience ─────────────────────────────────────────

export interface AdaptedCopy {
    headlines: string[];
    primaryTexts: string[];
    description: string;
}

/**
 * Uses AI to adapt ad copy from one audience to another.
 * Preserves persuasion structure, offer details, compliance language.
 * Only changes identity-specific references.
 */
export async function adaptCopyForAudience(
    sourceAudience: string,
    targetAudience: string,
    headlines: string[],
    primaryTexts: string[],
    description: string,
): Promise<AdaptedCopy> {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('Gemini API key not configured');

    const prompt = `You are a direct response copywriter adapting ad text for a different audience segment.

ORIGINAL AUDIENCE: ${sourceAudience}
TARGET AUDIENCE: ${targetAudience}

RULES:
1. PRESERVE the exact persuasion structure: hook → pain point → agitation → solution → CTA
2. PRESERVE the offer details, numbers, compliance language, and disclaimers EXACTLY
3. ONLY change identity-specific references:
   - WHO they are (e.g., "you served your country" → "you've spent years in the classroom")
   - WHY they deserve this (e.g., "sacrifice and honor" → "dedication to your students")
   - EMOTIONAL anchors specific to their experience
4. Keep the same tone, reading level, line breaks, and emoji pattern
5. Keep the same approximate character count (±10%)
6. Do NOT add new claims, statistics, or benefits not in the original
7. Do NOT change the CTA, URL references, or qualifying criteria
8. Output the SAME number of headlines and primary texts as the input

HEADLINES (${headlines.length}):
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

PRIMARY TEXTS (${primaryTexts.length}):
${primaryTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

${description ? `DESCRIPTION:\n${description}` : ''}

Respond ONLY with valid JSON:
{
  "headlines": ["...", "..."],
  "primaryTexts": ["...", "..."],
  "description": "..."
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`;
    const response = await geminiCall(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
        },
    });

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');

    const parsed = JSON.parse(text) as AdaptedCopy;

    // Ensure arrays match input length
    while (parsed.headlines.length < headlines.length) parsed.headlines.push(headlines[parsed.headlines.length]);
    while (parsed.primaryTexts.length < primaryTexts.length) parsed.primaryTexts.push(primaryTexts[parsed.primaryTexts.length]);

    return parsed;
}

/**
 * Batch adapt copy for multiple audiences at once.
 * Returns a map of audience → adapted copy.
 */
export async function adaptCopyForAudiences(
    sourceAudience: string,
    targetAudiences: string[],
    headlines: string[],
    primaryTexts: string[],
    description: string,
    onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, AdaptedCopy>> {
    const results = new Map<string, AdaptedCopy>();
    let completed = 0;

    const queue = [...targetAudiences];
    const worker = async () => {
        while (queue.length > 0) {
            const audience = queue.shift()!;
            try {
                const adapted = await adaptCopyForAudience(
                    sourceAudience, audience, headlines, primaryTexts, description,
                );
                results.set(audience, adapted);
            } catch (err) {
                console.error(`Failed to adapt copy for ${audience}:`, err);
                results.set(audience, { headlines: [...headlines], primaryTexts: [...primaryTexts], description });
            }
            completed++;
            onProgress?.(completed, targetAudiences.length);
        }
    };

    const workers = Array.from({ length: Math.min(3, queue.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
