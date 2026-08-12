/**
 * Meta Ads API Integration
 * Handles auth (system-user token or personal OAuth), ad accounts, and uploads
 */

const META_APP_ID = import.meta.env.VITE_META_APP_ID || '';
/** Shared system-user token — available to every app profile. */
const ENV_SYSTEM_USER_TOKEN = (import.meta.env.VITE_META_SYSTEM_USER_TOKEN || '').trim();
const GRAPH_API_VERSION = 'v23.0';
/**
 * Same-origin Graph proxy (`/meta-graph/...` → graph.facebook.com).
 * Browser→Meta TLS often breaks under VPN on large uploads; proxying via
 * Vite (dev) / Vercel rewrite (prod) keeps the heavy hops server-side.
 */
const GRAPH_API_BASE = `/meta-graph/${GRAPH_API_VERSION}`;

/** Rewrite Meta absolute paging URLs onto the same-origin proxy. */
function toProxiedGraphUrl(url: string): string {
    if (!url || url.startsWith('/meta-graph/')) return url;
    try {
        const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://graph.facebook.com');
        if (
            parsed.hostname === 'graph.facebook.com'
            || parsed.hostname === 'graph-video.facebook.com'
            || parsed.hostname.endsWith('.facebook.com')
        ) {
            return `/meta-graph${parsed.pathname}${parsed.search}`;
        }
    } catch {
        /* keep as-is */
    }
    return url;
}

/** Global (not per-profile) — all local profiles share the same Meta connection. */
const TOKEN_STORAGE_KEY = 'ads-uploader-meta-token';

interface MetaUser {
    id: string;
    name: string;
    picture: string;
    accessToken: string;
    /** System-user token from Business Manager, vs personal FB login. */
    authType: 'system' | 'personal';
}

interface AdAccount {
    id: string;
    name: string;
    account_id: string;
    /** IANA timezone, e.g. America/Los_Angeles — used for ad-set start/end times. */
    timezone_name?: string;
}

interface VideoUploadResult {
    success: boolean;
    videoId?: string;
    error?: string;
}

// Store for current user session
let currentMetaUser: MetaUser | null = null;

/** Pull a readable message out of Meta's often-opaque Graph error payload. */
function formatMetaError(errData: unknown, fallback: string): string {
    const error = (errData as { error?: Record<string, unknown> } | null)?.error
        || (errData as Record<string, unknown> | null)
        || {};
    const userMsg = typeof error.error_user_msg === 'string' ? error.error_user_msg : '';
    const userTitle = typeof error.error_user_title === 'string' ? error.error_user_title : '';
    const message = typeof error.message === 'string' ? error.message : '';
    const errorData = error.error_data as { blame_field_specs?: unknown } | undefined;
    const blame = errorData?.blame_field_specs ?? error.blame_field_specs;
    let blameText = '';
    if (Array.isArray(blame) && blame.length > 0) {
        blameText = `Fields: ${blame.map(b => (Array.isArray(b) ? b.join('.') : String(b))).join(', ')}`;
    }
    const parts = [userTitle, userMsg, message === 'Invalid parameter' && (userMsg || blameText) ? '' : message, blameText]
        .map(p => p.trim())
        .filter(Boolean);
    // Dedupe while preserving order
    const unique = [...new Set(parts)];
    return unique.join(' — ') || fallback;
}

function persistSystemToken(token: string) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearPersistedSystemToken() {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Shared env token wins (so updating .env + restart always takes effect).
 * localStorage is only a manual paste override when no env token is set.
 */
function readSystemToken(): string | null {
    if (ENV_SYSTEM_USER_TOKEN) {
        // Drop stale pasted tokens so they can't shadow a fresh .env value
        try {
            const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
            if (stored && stored.trim() !== ENV_SYSTEM_USER_TOKEN) {
                localStorage.removeItem(TOKEN_STORAGE_KEY);
            }
        } catch { /* ignore */ }
        return ENV_SYSTEM_USER_TOKEN;
    }
    try {
        const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
        if (stored?.trim()) return stored.trim();
    } catch { /* ignore */ }
    return null;
}

export function hasEnvSystemUserToken(): boolean {
    return Boolean(ENV_SYSTEM_USER_TOKEN);
}

/**
 * Validate a Graph access token via /me and return a MetaUser.
 * Works for both system users and personal users.
 */
export async function connectWithAccessToken(
    rawToken: string,
    authType: 'system' | 'personal' = 'system',
    opts?: { persist?: boolean },
): Promise<MetaUser> {
    const accessToken = rawToken.trim();
    if (!accessToken) throw new Error('Access token is required');

    const res = await fetch(
        `${GRAPH_API_BASE}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
    );
    const data = await res.json();
    if (!res.ok || data.error) {
        const msg = data.error?.message || `Token validation failed (${res.status})`;
        const code = data.error?.code != null ? ` (#${data.error.code})` : '';
        throw new Error(`${msg}${code}`);
    }

    currentMetaUser = {
        id: data.id,
        name: data.name || (authType === 'system' ? 'System User' : 'Meta User'),
        picture: authType === 'personal'
            ? `https://graph.facebook.com/${data.id}/picture?type=square&access_token=${accessToken}`
            : '',
        accessToken,
        authType,
    };

    // Only persist pasted overrides — env token is already the shared default.
    if (authType === 'system' && opts?.persist !== false && accessToken !== ENV_SYSTEM_USER_TOKEN) {
        persistSystemToken(accessToken);
    }
    return currentMetaUser;
}

/**
 * Restore the shared system-user session (env token or saved override).
 * Same connection for every app profile.
 */
export async function restoreSystemUserSession(): Promise<MetaUser | null> {
    const token = readSystemToken();
    if (!token) return null;
    try {
        return await connectWithAccessToken(token, 'system', { persist: false });
    } catch (err) {
        console.warn('System-user token is invalid', err);
        // Clear a bad localStorage override so we can fall back to env next time
        if (token !== ENV_SYSTEM_USER_TOKEN) clearPersistedSystemToken();
        currentMetaUser = null;
        // Retry env if the override failed
        if (token !== ENV_SYSTEM_USER_TOKEN && ENV_SYSTEM_USER_TOKEN) {
            try {
                return await connectWithAccessToken(ENV_SYSTEM_USER_TOKEN, 'system', { persist: false });
            } catch (envErr) {
                console.warn('Env system-user token is also invalid', envErr);
            }
        }
        return null;
    }
}

/**
 * Initialize Facebook SDK (only needed for personal OAuth fallback)
 */
export function initFacebookSDK(): Promise<void> {
    return new Promise((resolve) => {
        if (window.FB) {
            resolve();
            return;
        }

        if (!META_APP_ID) {
            resolve();
            return;
        }

        window.fbAsyncInit = function () {
            window.FB.init({
                appId: META_APP_ID,
                cookie: true,
                xfbml: false,
                version: GRAPH_API_VERSION,
            });
            resolve();
        };

        const script = document.createElement('script');
        script.src = 'https://connect.facebook.net/en_US/sdk.js';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
    });
}

/**
 * Login with Facebook (personal account fallback)
 */
export function loginWithMeta(): Promise<MetaUser | null> {
    return new Promise((resolve) => {
        if (!window.FB) {
            console.error('Facebook SDK not initialized');
            resolve(null);
            return;
        }

        window.FB.login(
            (response: fb.StatusResponse) => {
                if (response.authResponse) {
                    const accessToken = response.authResponse.accessToken;

                    window.FB.api('/me', { fields: 'id,name' }, (userInfo: unknown) => {
                        const info = userInfo as { id: string; name: string };
                        clearPersistedSystemToken();
                        currentMetaUser = {
                            id: info.id,
                            name: info.name,
                            picture: `https://graph.facebook.com/${info.id}/picture?type=square&access_token=${accessToken}`,
                            accessToken,
                            authType: 'personal',
                        };
                        resolve(currentMetaUser);
                    });
                } else {
                    resolve(null);
                }
            },
            { scope: 'ads_management,ads_read,pages_show_list' }
        );
    });
}

/**
 * Check if user is logged in to Meta (personal FB session)
 */
export function checkMetaLoginStatus(): Promise<MetaUser | null> {
    return new Promise((resolve) => {
        if (!window.FB) {
            resolve(null);
            return;
        }

        window.FB.getLoginStatus((response: fb.StatusResponse) => {
            if (response.status === 'connected' && response.authResponse) {
                const accessToken = response.authResponse.accessToken;

                window.FB.api('/me', { fields: 'id,name' }, (userInfo: unknown) => {
                    const info = userInfo as { id: string; name: string };
                    currentMetaUser = {
                        id: info.id,
                        name: info.name,
                        picture: `https://graph.facebook.com/${info.id}/picture?type=square&access_token=${accessToken}`,
                        accessToken,
                        authType: 'personal',
                    };
                    resolve(currentMetaUser);
                });
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Disconnect Meta — clears a localStorage override. If an env system-user
 * token is configured, the next restore will reconnect with that shared token.
 */
export async function logoutFromMeta(): Promise<void> {
    clearPersistedSystemToken();
    currentMetaUser = null;

    if (!window.FB) return;
    await new Promise<void>((resolve) => {
        try {
            window.FB.getLoginStatus((response: fb.StatusResponse) => {
                if (response.status === 'connected') {
                    window.FB.logout(() => resolve());
                } else {
                    resolve();
                }
            });
        } catch {
            resolve();
        }
    });
}

/**
 * Get current Meta user
 */
export function getCurrentMetaUser(): MetaUser | null {
    return currentMetaUser;
}

/** Graph node id behind a token, keyed by token so repeated asset lookups cost one call. */
const actorIdCache = new Map<string, string>();

async function resolveActorId(accessToken: string): Promise<string | null> {
    if (currentMetaUser?.accessToken === accessToken) return currentMetaUser.id;
    const cached = actorIdCache.get(accessToken);
    if (cached) return cached;
    try {
        const res = await fetch(
            `${GRAPH_API_BASE}/me?fields=id&access_token=${encodeURIComponent(accessToken)}`,
        );
        const data = await res.json();
        if (!res.ok || data.error || !data.id) return null;
        actorIdCache.set(accessToken, data.id);
        return data.id;
    } catch (error) {
        console.error('Could not resolve the token owner id', error);
        return null;
    }
}

/**
 * Resolve assets that can reach a token either as a personal role or as a Business Manager
 * assignment.
 *
 * A system-user token returns nothing on `/me/adaccounts` and `/me/accounts` — Graph only
 * exposes its assets on the system user's own `assigned_*` edges. Personal tokens are the
 * reverse. Query whichever edge matches the token kind first and fall back to the other, so
 * both connection types end up with the same list.
 */
async function fetchAssignedOrOwnedAssets<T extends { id: string }>(
    accessToken: string,
    fields: string,
    assignedEdge: 'assigned_ad_accounts' | 'assigned_pages',
    userEdge: 'adaccounts' | 'accounts',
    label: string,
): Promise<T[]> {
    const url = (path: string) =>
        `${GRAPH_API_BASE}/${path}?fields=${fields}&limit=100&access_token=${accessToken}`;

    const attempts: Array<{ path: string; via: string }> = [{ path: `me/${userEdge}`, via: `me/${userEdge}` }];
    const actorId = await resolveActorId(accessToken);
    if (actorId) {
        const assigned = { path: `${actorId}/${assignedEdge}`, via: assignedEdge };
        const isPersonal = currentMetaUser?.accessToken === accessToken
            && currentMetaUser.authType === 'personal';
        // System users (and unidentified tokens) get the assigned edge first
        if (isPersonal) attempts.push(assigned);
        else attempts.unshift(assigned);
    }

    const byId = new Map<string, T>();
    const errors: string[] = [];
    for (const attempt of attempts) {
        const { items, error } = await fetchAllPagesDetailed<T>(url(attempt.path), `${label}:${attempt.via}`);
        for (const item of items) {
            if (!byId.has(item.id)) byId.set(item.id, item);
        }
        if (error) errors.push(error);
        if (byId.size > 0) break;
    }
    if (byId.size === 0 && errors.length > 0) {
        // Surface the first useful Graph error (rate limit, permissions, etc.)
        throw new Error(errors[0]);
    }
    return [...byId.values()];
}

/**
 * Follow Graph API cursor pagination until the edge is exhausted.
 *
 * `paging.next` comes back as a fully-formed URL (fields, limit and token already
 * embedded), so each page is fetched as-is. If a later page fails we keep and return
 * the pages already collected — a partial list beats discarding everything — and log
 * loudly so the truncation is never silent.
 */
async function fetchAllPagesDetailed<T>(
    url: string,
    label: string,
    maxPages = 25,
): Promise<{ items: T[]; error?: string }> {
    const results: T[] = [];
    let nextUrl: string | undefined = url;
    let pages = 0;

    while (nextUrl && pages < maxPages) {
        try {
            const response: Response = await fetch(nextUrl);
            const data: Record<string, unknown> = await response.json().catch(
                () => ({} as Record<string, unknown>),
            );
            if (!response.ok || data.error) {
                const msg = formatMetaError(data, `Graph API ${response.status}`);
                throw new Error(msg);
            }
            const pageItems = data.data;
            if (Array.isArray(pageItems)) {
                results.push(...(pageItems as T[]));
            }
            const paging = data.paging as { next?: string } | undefined;
            nextUrl = paging?.next ? toProxiedGraphUrl(paging.next) : undefined;
            pages++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`${label}: failed on page ${pages + 1}, returning ${results.length} result(s) collected so far`, error);
            return { items: results, error: message };
        }
    }

    if (nextUrl) {
        console.warn(`${label}: hit the ${maxPages}-page safety cap with more results remaining`);
    }

    return { items: results };
}

/**
 * Fetch the ad accounts the connected token can advertise on.
 *
 * Covers both token kinds: a system user's accounts come from its `assigned_ad_accounts`
 * edge, a personal login's from `/me/adaccounts`.
 */
export async function getAdAccounts(accessToken: string): Promise<AdAccount[]> {
    return fetchAssignedOrOwnedAssets<AdAccount>(
        accessToken,
        'id,name,account_id,timezone_name',
        'assigned_ad_accounts',
        'adaccounts',
        'getAdAccounts',
    );
}

function isAbortError(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof Error && error.name === 'AbortError')
    );
}

/** Browser "Failed to fetch" / TLS blips while talking to graph.facebook.com. */
function isTransientNetworkError(error: unknown): boolean {
    if (isAbortError(error)) return false;
    const msg = error instanceof Error ? error.message : String(error);
    return /failed to fetch|networkerror|load failed|ssl|err_ssl|econnreset|timed?\s*out/i.test(msg);
}

function networkErrorMessage(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|ssl|err_ssl|networkerror|load failed/i.test(msg)) {
        return 'Network dropped during Meta upload. Retrying usually works — try one video at a time if it keeps failing.';
    }
    return msg || 'Unknown network error';
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), ms);
        if (!signal) return;
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Cancelled', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function fetchWithNetworkRetry(
    input: string,
    init: RequestInit | undefined,
    label: string,
    retries = 3,
): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetch(input, init);
        } catch (error) {
            lastError = error;
            if (isAbortError(error) || init?.signal?.aborted) throw error;
            if (!isTransientNetworkError(error) || attempt === retries) throw error;
            const waitMs = 800 * (attempt + 1);
            console.warn(`${label}: transient network error, retry ${attempt + 1}/${retries} in ${waitMs}ms`, error);
            await sleep(waitMs, init?.signal ?? undefined);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForVideoReady(
    videoId: string,
    accessToken: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
): Promise<VideoUploadResult> {
    const maxAttempts = 120; // Up to five minutes of server-side processing.

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) return { success: false, error: 'Cancelled' };
        const response = await fetch(
            `${GRAPH_API_BASE}/${videoId}?fields=status&access_token=${encodeURIComponent(accessToken)}`,
            { signal },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
            return {
                success: false,
                error: data.error?.message || `Could not check video processing (${response.status})`,
            };
        }

        const status = data.status || {};
        const videoStatus = String(status.video_status || '').toLowerCase();
        const processingStatus = String(status.processing_phase?.status || '').toLowerCase();
        if (videoStatus === 'ready' || processingStatus === 'complete') {
            onProgress?.(100);
            return { success: true, videoId };
        }
        if (
            videoStatus === 'error'
            || processingStatus === 'error'
            || processingStatus === 'failed'
        ) {
            return {
                success: false,
                error: status.processing_phase?.errors?.[0]?.message || 'Meta could not process the video',
            };
        }

        onProgress?.(90 + Math.min(9, Math.floor(attempt / 12)));
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 2500);
            if (!signal) return;
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('Cancelled', 'AbortError'));
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    return {
        success: false,
        error: 'Video uploaded, but Meta did not finish processing it within five minutes',
    };
}

/**
 * Upload a video to Meta Ads as an ad creative
 * Uses resumable upload for reliability
 */
export async function uploadVideoToMeta(
    adAccountId: string,
    accessToken: string,
    videoSource: string | Blob,
    videoName: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
): Promise<VideoUploadResult> {
    // Full-upload retries: SSL blips mid-chunk often kill the whole session.
    const MAX_ATTEMPTS = 3;
    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal?.aborted) return { success: false, error: 'Cancelled' };
        try {
            if (attempt > 1) {
                onProgress?.(5);
                console.warn(`Retrying video upload "${videoName}" (attempt ${attempt}/${MAX_ATTEMPTS})`);
                await sleep(1000 * attempt, signal);
            }

            onProgress?.(5);
            let videoBlob: Blob;
            if (typeof videoSource === 'string') {
                const videoResponse = await fetchWithNetworkRetry(
                    videoSource,
                    { signal },
                    `read:${videoName}`,
                );
                if (!videoResponse.ok) {
                    return { success: false, error: `Failed to read video (${videoResponse.status})` };
                }
                videoBlob = await videoResponse.blob();
            } else {
                videoBlob = videoSource;
            }
            const fileSize = videoBlob.size;
            if (fileSize === 0) return { success: false, error: 'Video file is empty' };
            onProgress?.(10);

            const initFormData = new FormData();
            initFormData.append('upload_phase', 'start');
            initFormData.append('file_size', fileSize.toString());

            const initResponse = await fetchWithNetworkRetry(
                `${GRAPH_API_BASE}/${adAccountId}/advideos?access_token=${accessToken}`,
                { method: 'POST', body: initFormData, signal },
                `advideos:start:${videoName}`,
            );

            if (!initResponse.ok) {
                const errData = await initResponse.json();
                return { success: false, error: errData.error?.message || 'Failed to init upload' };
            }

            const initData = await initResponse.json();
            const uploadSessionId = initData.upload_session_id;
            const videoId = initData.video_id;
            if (!uploadSessionId || !videoId) {
                return { success: false, error: 'Meta did not return a video upload session' };
            }
            onProgress?.(15);

            // Keep under Vercel’s ~4.5MB request limit (multipart overhead included).
            const FALLBACK_CHUNK_SIZE = 2.5 * 1024 * 1024;
            let startOffset = Number(initData.start_offset ?? 0);
            let endOffset = Number(initData.end_offset ?? Math.min(FALLBACK_CHUNK_SIZE, fileSize));

            while (startOffset < fileSize) {
                if (signal?.aborted) return { success: false, error: 'Cancelled' };
                const requestedEnd = endOffset > startOffset
                    ? Math.min(endOffset, fileSize)
                    : Math.min(startOffset + FALLBACK_CHUNK_SIZE, fileSize);
                const chunk = videoBlob.slice(startOffset, requestedEnd);

                const formData = new FormData();
                formData.append('upload_phase', 'transfer');
                formData.append('upload_session_id', uploadSessionId);
                formData.append('start_offset', startOffset.toString());
                formData.append('video_file_chunk', chunk, videoName);

                const transferResponse = await fetchWithNetworkRetry(
                    `${GRAPH_API_BASE}/${adAccountId}/advideos?access_token=${accessToken}`,
                    { method: 'POST', body: formData, signal },
                    `advideos:transfer:${videoName}@${startOffset}`,
                    4,
                );

                if (!transferResponse.ok) {
                    const errData = await transferResponse.json();
                    return { success: false, error: errData.error?.message || 'Chunk upload failed' };
                }

                const transferData = await transferResponse.json();
                const nextStart = Number(transferData.start_offset);
                const nextEnd = Number(transferData.end_offset);
                if (!Number.isFinite(nextStart) || nextStart <= startOffset) {
                    return { success: false, error: 'Meta video upload stalled at the same byte offset' };
                }
                startOffset = nextStart;
                endOffset = Number.isFinite(nextEnd) ? nextEnd : startOffset + FALLBACK_CHUNK_SIZE;

                const uploadProgress = 15 + Math.round((startOffset / fileSize) * 70);
                onProgress?.(uploadProgress);
            }

            const finishFormData = new FormData();
            finishFormData.append('upload_phase', 'finish');
            finishFormData.append('upload_session_id', uploadSessionId);
            finishFormData.append('title', videoName);

            const finishResponse = await fetchWithNetworkRetry(
                `${GRAPH_API_BASE}/${adAccountId}/advideos?access_token=${accessToken}`,
                { method: 'POST', body: finishFormData, signal },
                `advideos:finish:${videoName}`,
            );

            if (!finishResponse.ok) {
                const errData = await finishResponse.json();
                return { success: false, error: errData.error?.message || 'Failed to finish upload' };
            }

            await finishResponse.json();
            onProgress?.(90);

            const ready = await waitForVideoReady(videoId, accessToken, onProgress, signal);
            if (!ready.success) return ready;

            return { success: true, videoId };
        } catch (error) {
            if (isAbortError(error) || signal?.aborted) {
                return { success: false, error: 'Cancelled' };
            }
            lastError = networkErrorMessage(error);
            console.error(`Error uploading video to Meta (attempt ${attempt}/${MAX_ATTEMPTS}):`, error);
            if (!isTransientNetworkError(error) || attempt === MAX_ATTEMPTS) {
                return { success: false, error: lastError };
            }
        }
    }

    return { success: false, error: lastError };
}

/**
 * Upload multiple videos to Meta
 */
export async function uploadBatchToMeta(
    adAccountId: string,
    accessToken: string,
    videos: { url: string; name: string }[],
    onVideoProgress?: (index: number, percent: number) => void,
    onVideoComplete?: (index: number, success: boolean) => void
): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        const result = await uploadVideoToMeta(
            adAccountId,
            accessToken,
            video.url,
            video.name,
            (percent) => onVideoProgress?.(i, percent)
        );

        if (result.success) {
            successful++;
        } else {
            failed++;
        }
        onVideoComplete?.(i, result.success);
    }

    return { successful, failed };
}

export interface ImageUploadResult {
    success: boolean;
    imageHash?: string;
    imageUrl?: string;
    error?: string;
}

/**
 * Upload an image file to Meta Ads
 */
export async function uploadImageToMeta(
    adAccountId: string,
    accessToken: string,
    file: File,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
): Promise<ImageUploadResult> {
    try {
        if (signal?.aborted) return { success: false, error: 'Cancelled' };
        if (file.size === 0) return { success: false, error: 'Image file is empty' };
        onProgress?.(10);

        const formData = new FormData();
        formData.append('filename', file, file.name);

        onProgress?.(50);

        const response = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/adimages?access_token=${encodeURIComponent(accessToken)}`,
            {
                method: 'POST',
                body: formData,
                signal,
            }
        );

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return { success: false, error: data.error?.message || `Failed to upload image (${response.status})` };
        }

        const imagesData = data.images;
        const firstKey = imagesData ? Object.keys(imagesData)[0] : undefined;
        if (!firstKey || !imagesData[firstKey]?.hash) {
            return { success: false, error: 'Meta accepted the request but returned no image hash' };
        }
        const imageInfo = imagesData[firstKey];
        onProgress?.(100);

        return {
            success: true,
            imageHash: imageInfo.hash,
            imageUrl: imageInfo.url,
        };
    } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
            return { success: false, error: 'Cancelled' };
        }
        console.error('Error uploading image to Meta:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// ============================================
// Video Library Functions
// ============================================

export interface AdVideo {
    id: string;
    title: string;
    created_time: string;
    updated_time?: string;
    length?: number;
    picture?: string; // thumbnail URL
    source?: string;
}

/**
 * Fetch existing videos from an ad account's video library.
 * Returns up to `limit` videos, newest first.
 */
export async function getAdVideos(
    accessToken: string,
    adAccountId: string,
    limit: number = 100
): Promise<AdVideo[]> {
    try {
        const url = `${GRAPH_API_BASE}/${adAccountId}/advideos?fields=id,title,created_time,updated_time,length,picture,source&limit=${limit}&access_token=${accessToken}`;
        console.log('Fetching ad videos:', url.replace(accessToken, '***'));
        const response = await fetch(url);
        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            console.error('getAdVideos failed:', response.status, errData);
            return [];
        }
        const data = await response.json();
        console.log(`getAdVideos: got ${data.data?.length ?? 0} videos`);
        return data.data || [];
    } catch (error) {
        console.error('Error fetching ad videos:', error);
        return [];
    }
}

// ============================================
// Pixel Functions
// ============================================

interface Pixel {
    id: string;
    name: string;
}

/**
 * Fetch available pixels for an ad account
 */
export async function getPixels(accessToken: string, adAccountId: string): Promise<Pixel[]> {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/adspixels?fields=id,name&limit=50&access_token=${accessToken}`
        );
        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            console.error('getPixels failed:', response.status, errData);
            return [];
        }
        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('Error fetching pixels:', error);
        return [];
    }
}

// ============================================
// Campaign & Ad Creation Functions
// ============================================

interface Campaign {
    id: string;
    name: string;
    status: string;
    objective: string;
    bid_strategy?: string;
    special_ad_categories?: string[];
    /** Present when the campaign uses CBO (campaign-level budget). */
    daily_budget?: string;
}

interface AdSet {
    id: string;
    name: string;
    status: string;
    campaign_id: string;
    daily_budget?: string;
    optimization_goal?: string;
    billing_event?: string;
    bid_amount?: string;
    bid_strategy?: string;
    bid_constraints?: Record<string, unknown>;
    targeting?: Record<string, unknown>;
    promoted_object?: Record<string, unknown>;
}

interface Page {
    id: string;
    name: string;
    access_token: string;
    picture?: {
        data?: {
            url: string;
        };
    };
}

interface AdCreationResult {
    success: boolean;
    adId?: string;
    error?: string;
}

/**
 * Fetch campaigns for an ad account
 */
export async function getCampaigns(accessToken: string, adAccountId: string): Promise<Campaign[]> {
    try {
        const statusFilter = encodeURIComponent(JSON.stringify([{field:'effective_status',operator:'IN',value:['ACTIVE','PAUSED','ARCHIVED']}]));
        const response = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/campaigns?fields=id,name,status,objective,bid_strategy,special_ad_categories,daily_budget&limit=100&filtering=${statusFilter}&access_token=${accessToken}`
        );

        if (!response.ok) {
            throw new Error('Failed to fetch campaigns');
        }

        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        return [];
    }
}

/**
 * Fetch ad sets for a campaign
 */
export async function getAdSets(accessToken: string, campaignId: string): Promise<AdSet[]> {
    try {
        // effective_status of an ad set reflects parent state: a paused campaign's ad sets
        // report CAMPAIGN_PAUSED (not PAUSED), so we must include those or they vanish.
        const statusFilter = encodeURIComponent(JSON.stringify([{field:'effective_status',operator:'IN',value:['ACTIVE','PAUSED','CAMPAIGN_PAUSED','ARCHIVED','IN_PROCESS','WITH_ISSUES']}]));
        const response = await fetch(
            `${GRAPH_API_BASE}/${campaignId}/adsets?fields=id,name,status,campaign_id,daily_budget,optimization_goal,billing_event,bid_amount,bid_strategy,bid_constraints,targeting,promoted_object&limit=100&filtering=${statusFilter}&access_token=${accessToken}`
        );

        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            console.error('getAdSets failed:', response.status, errData);
            throw new Error('Failed to fetch ad sets');
        }

        const data = await response.json();
        console.log('getAdSets response:', data.data?.length, 'ad sets');
        return data.data || [];
    } catch (error) {
        console.error('Error fetching ad sets:', error);
        return [];
    }
}

/**
 * Fetch one existing ad set from a campaign to use as a template for new ad sets.
 * Returns the optimization_goal, billing_event, targeting, and bid_amount.
 */
export async function getAdSetTemplate(accessToken: string, campaignId: string): Promise<{
    optimizationGoal?: string;
    billingEvent?: string;
    targeting?: Record<string, unknown>;
    bidAmount?: number;
    promotedObject?: Record<string, unknown>;
} | null> {
    try {
        const response = await fetch(
            `${GRAPH_API_BASE}/${campaignId}/adsets?fields=optimization_goal,billing_event,bid_amount,targeting,promoted_object&limit=1&access_token=${accessToken}`
        );
        if (!response.ok) return null;
        const data = await response.json();
        const adSet = data.data?.[0];
        if (!adSet) return null;
        console.log('Ad set template from campaign:', JSON.stringify(adSet, null, 2));
        return {
            optimizationGoal: adSet.optimization_goal,
            billingEvent: adSet.billing_event,
            targeting: adSet.targeting,
            bidAmount: adSet.bid_amount ? parseInt(adSet.bid_amount) : undefined,
            promotedObject: adSet.promoted_object,
        };
    } catch (error) {
        console.error('Error fetching ad set template:', error);
        return null;
    }
}

/**
 * Create a new campaign
 */
export interface CreateCampaignParams {
    name: string;
    objective?: string; // Defaults to OUTCOME_TRAFFIC
    status?: 'ACTIVE' | 'PAUSED';
    special_ad_categories?: string[];
    /** Campaign-level daily budget in cents — enables CBO when set. */
    dailyBudget?: number;
    bidStrategy?: string;
}

export interface CreateCampaignResult {
    success: boolean;
    campaignId?: string;
    error?: string;
}

export async function createCampaign(
    accessToken: string,
    adAccountId: string,
    params: CreateCampaignParams
): Promise<CreateCampaignResult> {
    try {
        const formData = new URLSearchParams();
        formData.append('name', params.name);
        formData.append('objective', params.objective || 'OUTCOME_TRAFFIC');
        formData.append('status', params.status || 'PAUSED');
        // special_ad_categories is required - use empty array for non-special ads
        formData.append('special_ad_categories', JSON.stringify(params.special_ad_categories || []));

        if (params.dailyBudget !== undefined) {
            // CBO — budget lives on the campaign; ad sets must omit daily_budget
            formData.append('daily_budget', String(params.dailyBudget));
            if (params.bidStrategy) formData.append('bid_strategy', params.bidStrategy);
        } else {
            // ABO — budgets live on ad sets. Required by Meta when the campaign
            // has no campaign-level budget.
            formData.append('is_adset_budget_sharing_enabled', 'false');
        }

        console.log('Creating campaign with params:', {
            name: params.name,
            objective: params.objective || 'OUTCOME_TRAFFIC',
            status: params.status || 'PAUSED',
            special_ad_categories: params.special_ad_categories || [],
            dailyBudget: params.dailyBudget,
            adAccountId,
        });

        const response = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/campaigns?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString(),
            }
        );

        if (!response.ok) {
            const errData = await response.json();
            console.error('Campaign creation error:', JSON.stringify(errData, null, 2));
            return { success: false, error: formatMetaError(errData, 'Failed to create campaign') };
        }

        const data = await response.json();
        return { success: true, campaignId: data.id };
    } catch (error) {
        console.error('Error creating campaign:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Soft-delete a campaign (status=DELETED). Used to roll back empty campaigns
 * when ad-set/ad creation fails after the campaign was already created.
 */
export async function deleteCampaign(
    accessToken: string,
    campaignId: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const formData = new URLSearchParams();
        formData.append('status', 'DELETED');
        const response = await fetch(
            `${GRAPH_API_BASE}/${campaignId}?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString(),
            },
        );
        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            console.error('Campaign delete failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: formatMetaError(errData, 'Failed to delete campaign') };
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Soft-delete an ad set (status=DELETED). Used to roll back empty ad sets
 * when every ad upload into a newly created ad set fails.
 */
export async function deleteAdSet(
    accessToken: string,
    adSetId: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const formData = new URLSearchParams();
        formData.append('status', 'DELETED');
        const response = await fetch(
            `${GRAPH_API_BASE}/${adSetId}?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString(),
            },
        );
        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            console.error('Ad set delete failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: formatMetaError(errData, 'Failed to delete ad set') };
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Create a new ad set
 */
export interface CreateAdSetParams {
    name: string;
    campaignId: string;
    dailyBudget?: number;
    bidAmount?: number;
    bidStrategy?: string;
    bidConstraints?: Record<string, unknown>;
    billingEvent?: 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY';
    optimizationGoal?: string;
    status?: 'ACTIVE' | 'PAUSED';
    targeting?: Record<string, unknown>;
    promotedObject?: Record<string, unknown>;
    isDynamicCreative?: boolean;
    /** ISO-8601 start time (UTC or offset). Interpreted for the ad account. */
    startTime?: string;
    /** Optional ISO-8601 end time. */
    endTime?: string;
}

export interface CreateAdSetResult {
    success: boolean;
    adSetId?: string;
    error?: string;
}

export async function createAdSet(
    accessToken: string,
    adAccountId: string,
    params: CreateAdSetParams
): Promise<CreateAdSetResult> {
    try {
        // Default targeting: US, ages 18-65+
        const targeting = params.targeting || {
            geo_locations: { countries: ['US'] },
            age_min: 18,
            age_max: 65,
        };

        const formData = new URLSearchParams();
        formData.append('name', params.name);
        formData.append('campaign_id', params.campaignId);
        // daily_budget only for ABO (ad-set-budget) campaigns; CBO campaigns skip this
        if (params.dailyBudget !== undefined) {
            formData.append('daily_budget', (params.dailyBudget).toString());
        }
        if (params.bidAmount !== undefined) {
            formData.append('bid_amount', params.bidAmount.toString());
        }
        if (params.bidConstraints) {
            formData.append('bid_constraints', JSON.stringify(params.bidConstraints));
        }
        if (params.bidStrategy) {
            formData.append('bid_strategy', params.bidStrategy);
        }
        formData.append('billing_event', params.billingEvent || 'IMPRESSIONS');
        if (params.optimizationGoal) {
            formData.append('optimization_goal', params.optimizationGoal);
        }
        formData.append('status', params.status || 'PAUSED');
        formData.append('targeting', JSON.stringify(targeting));
        if (params.promotedObject) {
            formData.append('promoted_object', JSON.stringify(params.promotedObject));
        }
        if (params.isDynamicCreative) {
            formData.append('is_dynamic_creative', 'true');
        }
        if (params.startTime) {
            formData.append('start_time', params.startTime);
        }
        if (params.endTime) {
            formData.append('end_time', params.endTime);
        }

        console.log('Creating ad set:', Object.fromEntries(formData));

        const response = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/adsets?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString(),
            }
        );

        if (!response.ok) {
            const errData = await response.json();
            console.error('Ad set creation failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: formatMetaError(errData, 'Failed to create ad set') };
        }

        const data = await response.json();
        return { success: true, adSetId: data.id };
    } catch (error) {
        console.error('Error creating ad set:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Fetch full configuration of a specific ad set by ID, for use as a sibling template.
 */
export async function getAdSetById(accessToken: string, adSetId: string): Promise<{
    campaignId: string;
    dailyBudget?: number;
    bidAmount?: number;
    bidStrategy?: string;
    bidConstraints?: Record<string, unknown>;
    billingEvent?: string;
    optimizationGoal?: string;
    targeting?: Record<string, unknown>;
    promotedObject?: Record<string, unknown>;
} | null> {
    try {
        const fields = 'campaign_id,daily_budget,bid_amount,bid_strategy,bid_constraints,billing_event,optimization_goal,targeting,promoted_object';
        const response = await fetch(
            `${GRAPH_API_BASE}/${adSetId}?fields=${fields}&access_token=${accessToken}`
        );
        if (!response.ok) {
            console.error('getAdSetTemplate failed:', response.status);
            return null;
        }
        const data = await response.json();
        return {
            campaignId: data.campaign_id || '',
            dailyBudget: data.daily_budget ? parseInt(data.daily_budget) : undefined,
            bidAmount: data.bid_amount ? parseInt(data.bid_amount) : undefined,
            bidStrategy: data.bid_strategy,
            bidConstraints: data.bid_constraints,
            billingEvent: data.billing_event,
            optimizationGoal: data.optimization_goal,
            targeting: data.targeting,
            promotedObject: data.promoted_object,
        };
    } catch (error) {
        console.error('Error fetching ad set template:', error);
        return null;
    }
}

/**
 * Fetch the Facebook Pages the connected token can publish ads from.
 *
 * A system user sees its Pages on `assigned_pages`, a personal login on `/me/accounts`.
 * Graph drops Pages it cannot mint a page token for, so if the full field set comes back
 * empty the same edge is retried with `access_token` left out.
 */
export async function getPages(accessToken: string): Promise<Page[]> {
    const pages = await fetchAssignedOrOwnedAssets<Page>(
        accessToken,
        'id,name,access_token,picture{url}',
        'assigned_pages',
        'accounts',
        'getPages',
    );
    if (pages.length > 0) return pages;

    return fetchAssignedOrOwnedAssets<Page>(
        accessToken,
        'id,name,picture{url}',
        'assigned_pages',
        'accounts',
        'getPages:noPageToken',
    );
}

interface VideoThumbnail {
    imageHash?: string;
    imageUrl?: string;
}

/** Extract a JPEG thumbnail from the first decodable frame in the browser. */
async function createFirstFrameThumbnail(
    videoSource: string | Blob,
    videoName: string,
): Promise<File> {
    const ownsUrl = typeof videoSource !== 'string';
    const sourceUrl = ownsUrl ? URL.createObjectURL(videoSource) : videoSource;

    try {
        return await new Promise<File>((resolve, reject) => {
            const video = document.createElement('video');
            const timeout = window.setTimeout(
                () => reject(new Error('Timed out while reading the first video frame')),
                20_000,
            );
            let settled = false;

            const finish = (result: File | Error) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                video.removeAttribute('src');
                video.load();
                result instanceof Error ? reject(result) : resolve(result);
            };

            const capture = () => {
                try {
                    const sourceWidth = video.videoWidth;
                    const sourceHeight = video.videoHeight;
                    if (!sourceWidth || !sourceHeight) {
                        finish(new Error('Video has no readable frame dimensions'));
                        return;
                    }

                    const maxDimension = 1280;
                    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
                    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
                    const context = canvas.getContext('2d');
                    if (!context) {
                        finish(new Error('Could not create the thumbnail canvas'));
                        return;
                    }
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(blob => {
                        if (!blob) {
                            finish(new Error('Could not encode the video thumbnail'));
                            return;
                        }
                        const baseName = videoName.replace(/\.[^/.]+$/, '') || 'video';
                        finish(new File([blob], `${baseName}-thumbnail.jpg`, { type: 'image/jpeg' }));
                    }, 'image/jpeg', 0.9);
                } catch (error) {
                    finish(error instanceof Error ? error : new Error('Could not capture the video frame'));
                }
            };

            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            if (typeof videoSource === 'string' && /^https?:/i.test(videoSource)) {
                video.crossOrigin = 'anonymous';
            }
            video.addEventListener('error', () => finish(new Error('Could not load the video for thumbnail generation')), { once: true });
            video.addEventListener('loadeddata', () => {
                const seekTime = Number.isFinite(video.duration) && video.duration > 0.1
                    ? Math.min(0.1, video.duration / 2)
                    : 0;
                if (seekTime > 0) {
                    video.addEventListener('seeked', capture, { once: true });
                    video.currentTime = seekTime;
                } else {
                    capture();
                }
            }, { once: true });
            video.src = sourceUrl;
            video.load();
        });
    } finally {
        if (ownsUrl) URL.revokeObjectURL(sourceUrl);
    }
}

/** Fallback for existing/remote videos where a local frame cannot be captured. */
async function getVideoThumbnailUrl(videoId: string, accessToken: string): Promise<string | null> {
    try {
        const fields = encodeURIComponent('picture,thumbnails.limit(20){uri,is_preferred}');
        const response = await fetch(
            `${GRAPH_API_BASE}/${videoId}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`,
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) return null;
        const thumbnails = Array.isArray(data.thumbnails?.data) ? data.thumbnails.data : [];
        const preferred = thumbnails.find((item: { is_preferred?: boolean }) => item.is_preferred);
        return preferred?.uri || thumbnails[0]?.uri || data.picture || null;
    } catch (error) {
        console.warn('Could not resolve Meta video thumbnail', error);
        return null;
    }
}

/**
 * Image hashes are ad-account-scoped. Reusing a source-account hash in another
 * account fails with "The image you selected is not available".
 * Same account → reuse hash. Cross-account → re-upload or fall back to image_url.
 */
async function resolveDestMediaImage(
    destAccountId: string,
    accessToken: string,
    opts: {
        sameAccount: boolean;
        sourceHash?: string;
        sourceUrl?: string;
        /** Prefer thumbnails from a video already in the destination account. */
        destVideoId?: string;
        sourceVideoId?: string;
        fileName: string;
    },
): Promise<VideoThumbnail & { error?: string }> {
    if (opts.sameAccount && opts.sourceHash) {
        return { imageHash: opts.sourceHash };
    }

    const candidateUrls: string[] = [];
    if (opts.sourceUrl) candidateUrls.push(opts.sourceUrl);
    if (opts.destVideoId) {
        const destThumb = await getVideoThumbnailUrl(opts.destVideoId, accessToken);
        if (destThumb) candidateUrls.push(destThumb);
    }
    if (opts.sourceVideoId && opts.sourceVideoId !== opts.destVideoId) {
        const srcThumb = await getVideoThumbnailUrl(opts.sourceVideoId, accessToken);
        if (srcThumb) candidateUrls.push(srcThumb);
    }

    // Try to materialize a dest-account hash (best). CDN fetch can fail in-browser
    // due to CORS — then fall back to image_url so Meta pulls it server-side.
    for (const url of candidateUrls) {
        try {
            const imgRes = await fetch(url);
            if (!imgRes.ok) continue;
            const blob = await imgRes.blob();
            if (!blob.size) continue;
            const ext = blob.type.includes('png') ? 'png' : 'jpg';
            const file = new File(
                [blob],
                opts.fileName.endsWith(`.${ext}`) ? opts.fileName : `${opts.fileName}.${ext}`,
                { type: blob.type || `image/${ext === 'png' ? 'png' : 'jpeg'}` },
            );
            const upload = await uploadImageToMeta(destAccountId, accessToken, file);
            if (upload.success && upload.imageHash) {
                return { imageHash: upload.imageHash, imageUrl: upload.imageUrl };
            }
        } catch (err) {
            console.warn('Could not re-upload image into dest account, will try image_url:', err);
        }
    }

    if (candidateUrls[0]) {
        return { imageUrl: candidateUrls[0] };
    }

    return {
        error: 'No usable thumbnail/image for destination account (source hash cannot be reused cross-account)',
    };
}

/**
 * Create an ad from an uploaded video
 * This creates the ad creative and the ad in one flow
 */
export async function createAdFromVideo(
    adAccountId: string,
    adSetId: string,
    pageId: string,
    accessToken: string,
    videoId: string,
    adName: string,
    adSettings?: CopiedAdSettings,
    thumbnail?: VideoThumbnail,
): Promise<AdCreationResult> {
    try {
        // Always use standard creatives (not DCO asset_feed_spec) so multiple
        // ads can coexist in one ad set. Meta API enforces a 1-ad limit on DCO ad sets.
        const headline = adSettings?.headlines[0] || adName;
        const primaryText = adSettings?.primaryTexts[0] || '';
        const ctaType = adSettings?.callToAction || 'LEARN_MORE';
        const linkUrl = adSettings?.websiteUrl || undefined;

        let resolvedThumbnail = thumbnail;
        if (!resolvedThumbnail?.imageHash && !resolvedThumbnail?.imageUrl) {
            const imageUrl = await getVideoThumbnailUrl(videoId, accessToken);
            if (imageUrl) resolvedThumbnail = { imageUrl };
        }
        if (!resolvedThumbnail?.imageHash && !resolvedThumbnail?.imageUrl) {
            return {
                success: false,
                error: 'Could not generate or retrieve the required video thumbnail',
            };
        }

        // Build video_data, stripping undefined values
        const videoData: Record<string, unknown> = {
            video_id: videoId,
            title: headline,
        };
        if (resolvedThumbnail.imageHash) videoData.image_hash = resolvedThumbnail.imageHash;
        else if (resolvedThumbnail.imageUrl) videoData.image_url = resolvedThumbnail.imageUrl;
        if (primaryText) videoData.message = primaryText;
        if (adSettings?.description) videoData.link_description = adSettings.description;
        if (linkUrl) {
            const ctaValue: Record<string, string> = { link: linkUrl };
            if (adSettings?.displayUrl) ctaValue.display_url = adSettings.displayUrl;
            videoData.call_to_action = { type: ctaType, value: ctaValue };
        }

        const objectStorySpec = { page_id: pageId, video_data: videoData };

        // Step 1: Create ad creative — use form-encoded to avoid CORS preflight
        const creativeForm = new URLSearchParams();
        creativeForm.append('name', `${adName} Creative`);
        creativeForm.append('object_story_spec', JSON.stringify(objectStorySpec));

        console.log('Creating video creative:', { name: `${adName} Creative`, object_story_spec: objectStorySpec });

        const creativeResponse = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/adcreatives?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: creativeForm.toString(),
            }
        );

        if (!creativeResponse.ok) {
            const errData = await creativeResponse.json();
            console.error('Video creative creation failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: errData.error?.error_user_msg || errData.error?.message || 'Failed to create ad creative' };
        }

        const creativeData = await creativeResponse.json();
        const creativeId = creativeData.id;

        // Step 2: Create the ad linking the creative to the ad set
        const adForm = new URLSearchParams();
        adForm.append('name', adName);
        adForm.append('adset_id', adSetId);
        adForm.append('creative', JSON.stringify({ creative_id: creativeId }));
        adForm.append('status', 'ACTIVE');

        const adResponse = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/ads?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: adForm.toString(),
            }
        );

        if (!adResponse.ok) {
            const errData = await adResponse.json();
            console.error('Video ad creation failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: errData.error?.error_user_msg || errData.error?.message || 'Failed to create ad' };
        }

        const adData = await adResponse.json();
        return { success: true, adId: adData.id };
    } catch (error) {
        console.error('Error creating ad:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Create one Flex / Dynamic Creative ad that contains multiple videos.
 * The ad set should be created with isDynamicCreative=true (Meta allows only
 * one ad per DCO ad set). Max 10 videos per Meta asset_feed_spec limits.
 */
export async function createFlexAdFromVideos(
    adAccountId: string,
    adSetId: string,
    pageId: string,
    accessToken: string,
    videos: { videoId: string; name: string; thumbnailUrl?: string }[],
    adSettings?: CopiedAdSettings,
    adName?: string,
): Promise<AdCreationResult> {
    try {
        if (videos.length === 0) {
            return { success: false, error: 'Select at least one video for a flex ad' };
        }
        if (videos.length > 10) {
            return { success: false, error: 'Flex ads support at most 10 videos' };
        }

        const name = adName || adSettings?.sourceAdName || 'Flex Ad';
        const headlines = (adSettings?.headlines || []).map(h => h.trim()).filter(Boolean);
        const bodies = (adSettings?.primaryTexts || []).map(t => t.trim()).filter(Boolean);
        const description = (adSettings?.description || '').trim();
        const ctaType = adSettings?.callToAction || 'LEARN_MORE';
        const linkUrl = adSettings?.websiteUrl || undefined;

        const videoAssets: Array<Record<string, string>> = [];
        for (const video of videos) {
            let thumbnailUrl = video.thumbnailUrl;
            if (!thumbnailUrl) {
                thumbnailUrl = (await getVideoThumbnailUrl(video.videoId, accessToken)) || undefined;
            }
            if (!thumbnailUrl) {
                return {
                    success: false,
                    error: `Could not resolve thumbnail for "${video.name}"`,
                };
            }
            videoAssets.push({
                video_id: video.videoId,
                thumbnail_url: thumbnailUrl,
            });
        }

        const titles = (headlines.length > 0 ? headlines : [name]).slice(0, 5).map(text => ({ text }));
        const bodyTexts = (bodies.length > 0 ? bodies : [name]).slice(0, 5).map(text => ({ text }));
        const descriptions = description
            ? [{ text: description }]
            : [{ text: titles[0].text }];

        const assetFeedSpec: Record<string, unknown> = {
            videos: videoAssets,
            bodies: bodyTexts,
            titles,
            descriptions,
            ad_formats: ['SINGLE_VIDEO'],
            call_to_action_types: [ctaType],
        };
        if (linkUrl) {
            const link: Record<string, string> = { website_url: linkUrl };
            if (adSettings?.displayUrl) link.display_url = adSettings.displayUrl;
            assetFeedSpec.link_urls = [link];
        }

        const objectStorySpec = { page_id: pageId };

        const creativeForm = new URLSearchParams();
        creativeForm.append('name', `${name} Flex Creative`);
        creativeForm.append('object_story_spec', JSON.stringify(objectStorySpec));
        creativeForm.append('asset_feed_spec', JSON.stringify(assetFeedSpec));

        console.log('Creating flex video creative:', {
            name: `${name} Flex Creative`,
            videoCount: videoAssets.length,
            asset_feed_spec: assetFeedSpec,
        });

        const creativeResponse = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/adcreatives?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: creativeForm.toString(),
            }
        );

        if (!creativeResponse.ok) {
            const errData = await creativeResponse.json();
            console.error('Flex creative creation failed:', JSON.stringify(errData, null, 2));
            return {
                success: false,
                error: formatMetaError(errData, 'Failed to create flex ad creative'),
            };
        }

        const creativeData = await creativeResponse.json();
        const creativeId = creativeData.id;

        const adForm = new URLSearchParams();
        adForm.append('name', name);
        adForm.append('adset_id', adSetId);
        adForm.append('creative', JSON.stringify({ creative_id: creativeId }));
        adForm.append('status', 'ACTIVE');

        const adResponse = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/ads?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: adForm.toString(),
            }
        );

        if (!adResponse.ok) {
            const errData = await adResponse.json();
            console.error('Flex ad creation failed:', JSON.stringify(errData, null, 2));
            return {
                success: false,
                error: formatMetaError(errData, 'Failed to create flex ad'),
            };
        }

        const adData = await adResponse.json();
        return { success: true, adId: adData.id };
    } catch (error) {
        console.error('Error creating flex ad:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Upload videos and create ads in a batch
 */
export async function uploadBatchToMetaAsAds(
    adAccountId: string,
    adSetId: string,
    pageId: string,
    accessToken: string,
    videos: { url: string | Blob; name: string }[],
    adSettings?: CopiedAdSettings,
    onVideoProgress?: (index: number, percent: number) => void,
    onVideoComplete?: (index: number, success: boolean, error?: string) => void,
    existingVideos?: AdVideo[],
    signal?: AbortSignal,
): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < videos.length; i++) {
        if (signal?.aborted) {
            for (let j = i; j < videos.length; j++) {
                failed++;
                onVideoComplete?.(j, false, 'Cancelled');
            }
            break;
        }
        const video = videos[i];
        let thumbnail: VideoThumbnail | undefined;

        // Meta requires image_hash/image_url even for video creatives. Generate
        // a first-frame JPEG and add it to this ad account's image library.
        try {
            onVideoProgress?.(i, 2);
            const thumbnailFile = await createFirstFrameThumbnail(video.url, video.name);
            const thumbnailUpload = await uploadImageToMeta(
                adAccountId,
                accessToken,
                thumbnailFile,
                percent => onVideoProgress?.(i, 2 + Math.round(percent * 0.08)),
                signal,
            );
            if (thumbnailUpload.success && thumbnailUpload.imageHash) {
                thumbnail = { imageHash: thumbnailUpload.imageHash };
            } else if (thumbnailUpload.error === 'Cancelled') {
                failed++;
                onVideoComplete?.(i, false, 'Cancelled');
                for (let j = i + 1; j < videos.length; j++) {
                    failed++;
                    onVideoComplete?.(j, false, 'Cancelled');
                }
                break;
            } else {
                console.warn(`Thumbnail upload failed for "${video.name}":`, thumbnailUpload.error);
            }
        } catch (error) {
            // Existing/remote videos can fail canvas capture due to CORS. The
            // creative function falls back to Meta's generated thumbnail URL.
            console.warn(`First-frame thumbnail failed for "${video.name}":`, error);
        }

        // Check if video already exists in the library by matching title
        const nameSansExt = video.name.replace(/\.[^/.]+$/, '');
        const existingMatch = existingVideos?.find(ev => {
            const evTitle = (ev.title || '').toLowerCase();
            return evTitle === video.name.toLowerCase()
                || evTitle === nameSansExt.toLowerCase();
        });

        let videoId: string;

        if (existingMatch) {
            // Skip upload — reuse existing video
            console.log(`Skipping upload for "${video.name}" — already exists as video ${existingMatch.id} ("${existingMatch.title}")`);
            videoId = existingMatch.id;
            if (!thumbnail && existingMatch.picture) thumbnail = { imageUrl: existingMatch.picture };
            onVideoProgress?.(i, 80);
        } else {
            // Step 1: Upload video
            const uploadResult = await uploadVideoToMeta(
                adAccountId,
                accessToken,
                video.url,
                video.name,
                (percent) => onVideoProgress?.(i, 10 + Math.round(percent * 0.7)),
                signal,
            );

            if (!uploadResult.success || !uploadResult.videoId) {
                failed++;
                onVideoComplete?.(i, false, uploadResult.error);
                if (uploadResult.error === 'Cancelled' || signal?.aborted) {
                    for (let j = i + 1; j < videos.length; j++) {
                        failed++;
                        onVideoComplete?.(j, false, 'Cancelled');
                    }
                    break;
                }
                continue;
            }
            videoId = uploadResult.videoId;
        }

        onVideoProgress?.(i, 85);

        // Step 2: Create ad from the uploaded video
        const adResult = await createAdFromVideo(
            adAccountId,
            adSetId,
            pageId,
            accessToken,
            videoId,
            video.name,
            adSettings,
            thumbnail,
        );

        onVideoProgress?.(i, 100);

        if (adResult.success) {
            successful++;
            onVideoComplete?.(i, true);
        } else {
            failed++;
            onVideoComplete?.(i, false, adResult.error);
        }
    }

    return { successful, failed };
}

/**
 * Create an ad from an uploaded image hash
 */
export async function createAdFromImage(
    adAccountId: string,
    adSetId: string,
    pageId: string,
    accessToken: string,
    imageHash: string,
    adName: string,
    adSettings?: CopiedAdSettings
): Promise<AdCreationResult> {
    try {
        // Always use standard creatives (not DCO asset_feed_spec) so multiple
        // ads can coexist in one ad set. Meta API enforces a 1-ad limit on DCO ad sets.
        const headline = adSettings?.headlines[0] || adName;
        const primaryText = adSettings?.primaryTexts[0] || '';
        const ctaType = adSettings?.callToAction || 'LEARN_MORE';
        const linkUrl = adSettings?.websiteUrl || 'https://google.com';

        // Build link_data, stripping undefined values
        const linkData: Record<string, unknown> = {
            image_hash: imageHash,
            link: linkUrl,
            name: headline,
        };
        if (primaryText) linkData.message = primaryText;
        if (adSettings?.description) linkData.description = adSettings.description;
        const ctaValue: Record<string, string> = { link: linkUrl };
        if (adSettings?.displayUrl) ctaValue.display_url = adSettings.displayUrl;
        linkData.call_to_action = { type: ctaType, value: ctaValue };

        const objectStorySpec = { page_id: pageId, link_data: linkData };

        // Use form-encoded to avoid CORS preflight
        const creativeForm = new URLSearchParams();
        creativeForm.append('name', `${adName} Creative`);
        creativeForm.append('object_story_spec', JSON.stringify(objectStorySpec));

        console.log('Creating image creative:', { name: `${adName} Creative`, object_story_spec: objectStorySpec });

        const creativeResponse = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/adcreatives?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: creativeForm.toString(),
            }
        );

        if (!creativeResponse.ok) {
            const errData = await creativeResponse.json();
            console.error('Image creative creation failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: errData.error?.error_user_msg || errData.error?.message || 'Failed to create ad creative' };
        }

        const creativeData = await creativeResponse.json();
        const creativeId = creativeData.id;

        const adForm = new URLSearchParams();
        adForm.append('name', adName);
        adForm.append('adset_id', adSetId);
        adForm.append('creative', JSON.stringify({ creative_id: creativeId }));
        adForm.append('status', 'ACTIVE');

        const adResponse = await fetch(
            `${GRAPH_API_BASE}/${adAccountId}/ads?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: adForm.toString(),
            }
        );

        if (!adResponse.ok) {
            const errData = await adResponse.json();
            console.error('Image ad creation failed:', JSON.stringify(errData, null, 2));
            return { success: false, error: errData.error?.error_user_msg || errData.error?.message || 'Failed to create ad' };
        }

        const adData = await adResponse.json();
        return { success: true, adId: adData.id };
    } catch (error) {
        console.error('Error creating image ad:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Upload multiple images and create ads in a batch
 */
export async function uploadBatchImagesToMetaAsAds(
    adAccountId: string,
    adSetId: string,
    pageId: string,
    accessToken: string,
    images: { file: File; name: string }[],
    adSettings?: CopiedAdSettings,
    onImageProgress?: (index: number, percent: number) => void,
    onImageComplete?: (index: number, success: boolean, error?: string) => void,
    signal?: AbortSignal,
): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < images.length; i++) {
        if (signal?.aborted) {
            for (let j = i; j < images.length; j++) {
                failed++;
                onImageComplete?.(j, false, 'Cancelled');
            }
            break;
        }
        const image = images[i];

        const uploadResult = await uploadImageToMeta(
            adAccountId,
            accessToken,
            image.file,
            (percent) => onImageProgress?.(i, Math.round(percent * 0.8)),
            signal,
        );

        if (!uploadResult.success || !uploadResult.imageHash) {
            failed++;
            onImageComplete?.(i, false, uploadResult.error);
            if (uploadResult.error === 'Cancelled' || signal?.aborted) {
                for (let j = i + 1; j < images.length; j++) {
                    failed++;
                    onImageComplete?.(j, false, 'Cancelled');
                }
                break;
            }
            continue;
        }

        onImageProgress?.(i, 85);

        const adResult = await createAdFromImage(
            adAccountId,
            adSetId,
            pageId,
            accessToken,
            uploadResult.imageHash,
            image.name,
            adSettings
        );

        onImageProgress?.(i, 100);

        if (adResult.success) {
            successful++;
            onImageComplete?.(i, true);
        } else {
            failed++;
            onImageComplete?.(i, false, adResult.error);
        }
    }

    return { successful, failed };
}


// ============================================
// Ad Settings Cloning Functions
// ============================================

interface Ad {
    id: string;
    name: string;
    status: string;
    adset_id: string;
}

interface AdCreativeDetails {
    id: string;
    name?: string;
    title?: string;
    body?: string;
    call_to_action_type?: string;
    link_url?: string;
    object_story_spec?: {
        page_id: string;
        video_data?: {
            video_id: string;
            image_hash?: string;
            image_url?: string;
            title?: string;
            message?: string;
            link_description?: string;
            call_to_action?: {
                type: string;
                value?: { link?: string; display_url?: string };
            };
        };
        link_data?: {
            link: string;
            message?: string;
            name?: string;
            description?: string;
            image_hash?: string;
            picture?: string;
            call_to_action?: {
                type: string;
                value?: { link?: string };
            };
        };
    };
    asset_feed_spec?: {
        bodies?: { text: string }[];
        titles?: { text: string }[];
        descriptions?: { text: string }[];
        call_to_action_types?: string[];
        link_urls?: { website_url: string; display_url?: string }[];
        videos?: { video_id: string; thumbnail_hash?: string; thumbnail_url?: string }[];
        images?: { hash: string; url?: string }[];
    };
}

interface CopiedAdSettings {
    headlines: string[];
    primaryTexts: string[];
    description: string;
    callToAction: string;
    websiteUrl: string;
    displayUrl: string;
    pageId: string;
    sourceAdId: string;
    sourceAdName: string;
}

/**
 * Fetch ads for an ad set
 */
export async function getAds(accessToken: string, adSetId: string): Promise<Ad[]> {
    try {
        // An ad's effective_status reflects parent state: under a paused campaign/ad set it
        // reports CAMPAIGN_PAUSED / ADSET_PAUSED (not PAUSED), plus review states. Include them all.
        const statusFilter = encodeURIComponent(JSON.stringify([{field:'effective_status',operator:'IN',value:['ACTIVE','PAUSED','CAMPAIGN_PAUSED','ADSET_PAUSED','ARCHIVED','IN_PROCESS','WITH_ISSUES','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO']}]));
        const response = await fetch(
            `${GRAPH_API_BASE}/${adSetId}/ads?fields=id,name,status,adset_id&limit=100&filtering=${statusFilter}&access_token=${accessToken}`
        );

        if (!response.ok) {
            throw new Error('Failed to fetch ads');
        }

        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('Error fetching ads:', error);
        return [];
    }
}

/**
 * Fetch creative details for an ad
 */
export async function getAdCreative(accessToken: string, adId: string): Promise<AdCreativeDetails | null> {
    try {
        // First get the creative ID from the ad
        const adResponse = await fetch(
            `${GRAPH_API_BASE}/${adId}?fields=creative{id,name,title,body,call_to_action_type,link_url,object_story_spec,asset_feed_spec}&access_token=${accessToken}`
        );

        if (!adResponse.ok) {
            throw new Error('Failed to fetch ad creative');
        }

        const adData = await adResponse.json();
        return adData.creative || null;
    } catch (error) {
        console.error('Error fetching ad creative:', error);
        return null;
    }
}

/**
 * Extract editable settings from an ad's creative
 */
export async function extractAdSettings(
    accessToken: string,
    adId: string,
    adName: string
): Promise<CopiedAdSettings | null> {
    try {
        const creative = await getAdCreative(accessToken, adId);
        if (!creative) return null;

        const settings: CopiedAdSettings = {
            headlines: [],
            primaryTexts: [],
            description: '',
            callToAction: 'LEARN_MORE',
            websiteUrl: '',
            displayUrl: '',
            pageId: '',
            sourceAdId: adId,
            sourceAdName: adName,
        };

        // Check for Advantage+ Creative / Flexible Ads (asset_feed_spec)
        if (creative.asset_feed_spec) {
            const afs = creative.asset_feed_spec;
            if (afs.titles) {
                settings.headlines = afs.titles.map(t => t.text).slice(0, 5);
            }
            if (afs.bodies) {
                settings.primaryTexts = afs.bodies.map(b => b.text).slice(0, 5);
            }
            if (afs.descriptions && afs.descriptions.length > 0) {
                settings.description = afs.descriptions[0].text;
            }
            if (afs.call_to_action_types && afs.call_to_action_types.length > 0) {
                settings.callToAction = afs.call_to_action_types[0];
            }
            if (afs.link_urls && afs.link_urls.length > 0) {
                settings.websiteUrl = afs.link_urls[0].website_url || '';
                settings.displayUrl = afs.link_urls[0].display_url || '';
            }
        }
        // Check for standard video ad (object_story_spec.video_data)
        else if (creative.object_story_spec?.video_data) {
            const vd = creative.object_story_spec.video_data;
            settings.pageId = creative.object_story_spec.page_id || '';
            if (vd.title) settings.headlines = [vd.title];
            if (vd.message) settings.primaryTexts = [vd.message];
            if (vd.link_description) settings.description = vd.link_description;
            if (vd.call_to_action) {
                settings.callToAction = vd.call_to_action.type || 'LEARN_MORE';
                settings.websiteUrl = vd.call_to_action.value?.link || '';
                settings.displayUrl = vd.call_to_action.value?.display_url || '';
            }
        }
        // Check for link ad (object_story_spec.link_data)
        else if (creative.object_story_spec?.link_data) {
            const ld = creative.object_story_spec.link_data;
            settings.pageId = creative.object_story_spec.page_id || '';
            if (ld.name) settings.headlines = [ld.name];
            if (ld.message) settings.primaryTexts = [ld.message];
            if (ld.description) settings.description = ld.description;
            settings.websiteUrl = ld.link || '';
            if (ld.call_to_action) {
                settings.callToAction = ld.call_to_action.type || 'LEARN_MORE';
            }
        }
        // Fallback to top-level creative fields
        else {
            if (creative.title) settings.headlines = [creative.title];
            if (creative.body) settings.primaryTexts = [creative.body];
            settings.callToAction = creative.call_to_action_type || 'LEARN_MORE';
            settings.websiteUrl = creative.link_url || '';
        }

        // Ensure at least empty arrays
        if (settings.headlines.length === 0) settings.headlines = [''];
        if (settings.primaryTexts.length === 0) settings.primaryTexts = [''];

        return settings;
    } catch (error) {
        console.error('Error extracting ad settings:', error);
        return null;
    }
}

// ============================================
// Cross-Account Campaign Copy
// ============================================

export interface FullCampaign {
    campaign: Campaign;
    adSets: {
        adSet: AdSet;
        ads: {
            ad: Ad;
            creative: AdCreativeDetails | null;
        }[];
    }[];
}

export interface CopyProgress {
    phase: 'reading' | 'campaign' | 'adset' | 'ad' | 'done';
    message: string;
    current: number;
    total: number;
}

/**
 * Fetch the complete campaign tree: campaign → ad sets → ads with creative details.
 */
export async function getCampaignFull(
    accessToken: string,
    campaignId: string
): Promise<FullCampaign | null> {
    try {
        // Fetch campaign details
        const campRes = await fetch(
            `${GRAPH_API_BASE}/${campaignId}?fields=id,name,status,objective,bid_strategy,special_ad_categories,daily_budget&access_token=${accessToken}`
        );
        if (!campRes.ok) return null;
        const campaign = await campRes.json() as Campaign;

        // Fetch all ad sets
        const adSets = await getAdSets(accessToken, campaignId);

        // For each ad set, fetch ads + creatives
        const adSetDetails = [];
        for (const adSet of adSets) {
            const ads = await getAds(accessToken, adSet.id);
            const adsWithCreatives = [];
            for (const ad of ads) {
                const creative = await getAdCreative(accessToken, ad.id);
                adsWithCreatives.push({ ad, creative });
            }
            adSetDetails.push({ adSet, ads: adsWithCreatives });
        }

        return { campaign, adSets: adSetDetails };
    } catch (error) {
        console.error('getCampaignFull error:', error);
        return null;
    }
}

/**
 * Copy a full campaign from one ad account to another.
 * Handles video matching/re-upload, pixel remapping, and page swapping.
 */
export async function copyCampaignToAccount(
    accessToken: string,
    source: FullCampaign,
    destAccountId: string,
    destPageId: string,
    destPixelId?: string,
    onProgress?: (progress: CopyProgress) => void,
    sourceAccountId?: string,
): Promise<{ success: boolean; campaignId?: string; error?: string; stats: { adSets: number; ads: number; failed: number } }> {
    const stats = { adSets: 0, ads: 0, failed: 0 };
    const failures: string[] = [];
    const totalAds = source.adSets.reduce((sum, as) => sum + as.ads.length, 0);
    let adCounter = 0;
    const sameAccount = Boolean(sourceAccountId && sourceAccountId === destAccountId);

    try {
        // 1. Fetch existing videos in destination for matching
        onProgress?.({ phase: 'reading', message: 'Loading destination video library...', current: 0, total: totalAds });
        const destVideos = await getAdVideos(accessToken, destAccountId, 500);
        const destVideoIds = new Set(destVideos.map(v => v.id));
        console.log(`Destination has ${destVideos.length} existing videos (sameAccount=${sameAccount})`);

        // 2. Create campaign (CBO budget copied when present)
        onProgress?.({ phase: 'campaign', message: `Creating campaign: ${source.campaign.name}`, current: 0, total: totalAds });
        const sourceCboBudget = source.campaign.daily_budget
            ? parseInt(source.campaign.daily_budget, 10)
            : undefined;
        const campResult = await createCampaign(accessToken, destAccountId, {
            name: source.campaign.name,
            objective: source.campaign.objective || 'OUTCOME_TRAFFIC',
            status: 'ACTIVE',
            special_ad_categories: source.campaign.special_ad_categories || [],
            dailyBudget: sourceCboBudget && sourceCboBudget > 0 ? sourceCboBudget : undefined,
            bidStrategy: sourceCboBudget && sourceCboBudget > 0
                ? (source.campaign.bid_strategy || 'LOWEST_COST_WITHOUT_CAP')
                : undefined,
        });
        if (!campResult.success || !campResult.campaignId) {
            return { success: false, error: `Campaign creation failed: ${campResult.error}`, stats };
        }
        const newCampaignId = campResult.campaignId;
        const createdAdSetIds: string[] = [];

        // 3. For each ad set
        for (const { adSet, ads } of source.adSets) {
            onProgress?.({ phase: 'adset', message: `Creating ad set: ${adSet.name}`, current: adCounter, total: totalAds });

            // Remap promoted_object pixel if user specified one
            let promotedObject = adSet.promoted_object || undefined;
            if (destPixelId && promotedObject) {
                promotedObject = { ...promotedObject, pixel_id: destPixelId };
            } else if (destPixelId) {
                promotedObject = { pixel_id: destPixelId };
            }

            // Strip custom_audiences from targeting (account-specific)
            const targeting = adSet.targeting ? { ...adSet.targeting } : undefined;
            if (targeting) {
                delete (targeting as Record<string, unknown>).custom_audiences;
                delete (targeting as Record<string, unknown>).excluded_custom_audiences;
            }

            const isCbo = Boolean(sourceCboBudget && sourceCboBudget > 0);
            const asResult = await createAdSet(accessToken, destAccountId, {
                name: adSet.name,
                campaignId: newCampaignId,
                dailyBudget: isCbo ? undefined : (adSet.daily_budget ? parseInt(adSet.daily_budget) : undefined),
                bidAmount: adSet.bid_amount ? parseInt(adSet.bid_amount) : undefined,
                bidStrategy: isCbo ? undefined : adSet.bid_strategy,
                bidConstraints: adSet.bid_constraints,
                billingEvent: (adSet.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                optimizationGoal: adSet.optimization_goal,
                targeting,
                promotedObject,
                isDynamicCreative: false,
                status: 'ACTIVE',
            });

            if (!asResult.success || !asResult.adSetId) {
                console.error(`Ad set "${adSet.name}" failed:`, asResult.error);
                stats.failed += ads.length;
                adCounter += ads.length;
                continue;
            }
            createdAdSetIds.push(asResult.adSetId);
            stats.adSets++;

            // 4. For each ad in this ad set
            for (const { ad, creative } of ads) {
                adCounter++;
                onProgress?.({ phase: 'ad', message: `Creating ad: ${ad.name}`, current: adCounter, total: totalAds });

                if (!creative) {
                    const reason = `Ad "${ad.name}": no creative attached`;
                    console.warn(reason);
                    failures.push(reason);
                    stats.failed++;
                    continue;
                }

                try {
                    let adResult: AdCreationResult | null = null;

                    // Normalize media + copy from object_story_spec or asset_feed_spec
                    const vd = creative.object_story_spec?.video_data;
                    const ld = creative.object_story_spec?.link_data;
                    const afs = creative.asset_feed_spec;
                    const afsVideo = afs?.videos?.[0];
                    const afsImage = afs?.images?.[0];

                    const sourceVideoId = vd?.video_id || afsVideo?.video_id;
                    const sourceImageHash = ld?.image_hash || afsImage?.hash || vd?.image_hash || afsVideo?.thumbnail_hash;
                    const sourceImageUrl = ld?.picture || afsImage?.url || vd?.image_url || afsVideo?.thumbnail_url;

                    const settings: CopiedAdSettings = {
                        headlines: vd?.title
                            ? [vd.title]
                            : ld?.name
                                ? [ld.name]
                                : (afs?.titles?.map(t => t.text).filter(Boolean).slice(0, 5) || ['']),
                        primaryTexts: vd?.message
                            ? [vd.message]
                            : ld?.message
                                ? [ld.message]
                                : (afs?.bodies?.map(b => b.text).filter(Boolean).slice(0, 5) || ['']),
                        description: vd?.link_description
                            || ld?.description
                            || afs?.descriptions?.[0]?.text
                            || '',
                        callToAction: vd?.call_to_action?.type
                            || ld?.call_to_action?.type
                            || afs?.call_to_action_types?.[0]
                            || creative.call_to_action_type
                            || 'LEARN_MORE',
                        websiteUrl: vd?.call_to_action?.value?.link
                            || ld?.link
                            || afs?.link_urls?.[0]?.website_url
                            || creative.link_url
                            || '',
                        displayUrl: vd?.call_to_action?.value?.display_url
                            || afs?.link_urls?.[0]?.display_url
                            || '',
                        pageId: destPageId,
                        sourceAdId: ad.id,
                        sourceAdName: ad.name,
                    };
                    if (settings.headlines.length === 0) settings.headlines = [ad.name];
                    if (settings.primaryTexts.length === 0) settings.primaryTexts = [''];

                    if (sourceVideoId) {
                        // Same-account: reuse the video id directly. Cross-account: match library / re-upload.
                        let destVideoId =
                            (sameAccount || destVideoIds.has(sourceVideoId) ? sourceVideoId : undefined)
                            || destVideos.find(v =>
                                (v.title || '').toLowerCase() === (settings.headlines[0] || ad.name).toLowerCase()
                            )?.id
                            || destVideos.find(v =>
                                (v.title || '').toLowerCase() === (ad.name || '').toLowerCase()
                            )?.id;

                        if (!destVideoId) {
                            const srcVideoRes = await fetch(
                                `${GRAPH_API_BASE}/${sourceVideoId}?fields=source&access_token=${accessToken}`
                            );
                            const srcVideoData = srcVideoRes.ok ? await srcVideoRes.json() : null;
                            if (srcVideoData?.source) {
                                onProgress?.({
                                    phase: 'ad',
                                    message: `Uploading video: ${settings.headlines[0] || ad.name}`,
                                    current: adCounter,
                                    total: totalAds,
                                });
                                const uploadResult = await uploadVideoToMeta(
                                    destAccountId, accessToken, srcVideoData.source, settings.headlines[0] || ad.name,
                                );
                                if (uploadResult.success && uploadResult.videoId) {
                                    destVideoId = uploadResult.videoId;
                                    destVideoIds.add(uploadResult.videoId);
                                } else if (uploadResult.error) {
                                    failures.push(`Ad "${ad.name}": video upload failed — ${uploadResult.error}`);
                                }
                            } else {
                                failures.push(
                                    `Ad "${ad.name}": could not reuse or download source video ${sourceVideoId}`,
                                );
                            }
                        }

                        if (!destVideoId) {
                            stats.failed++;
                            continue;
                        }

                        onProgress?.({
                            phase: 'ad',
                            message: `Preparing thumbnail: ${ad.name}`,
                            current: adCounter,
                            total: totalAds,
                        });
                        const thumbnail = await resolveDestMediaImage(destAccountId, accessToken, {
                            sameAccount,
                            sourceHash: sourceImageHash,
                            sourceUrl: sourceImageUrl,
                            destVideoId,
                            sourceVideoId,
                            fileName: `${ad.name}-thumb`,
                        });
                        if (thumbnail.error && !thumbnail.imageHash && !thumbnail.imageUrl) {
                            failures.push(`Ad "${ad.name}": ${thumbnail.error}`);
                            stats.failed++;
                            continue;
                        }

                        adResult = await createAdFromVideo(
                            destAccountId, asResult.adSetId, destPageId, accessToken,
                            destVideoId, ad.name, settings,
                            { imageHash: thumbnail.imageHash, imageUrl: thumbnail.imageUrl },
                        );
                    } else if (sourceImageHash || sourceImageUrl) {
                        onProgress?.({
                            phase: 'ad',
                            message: `Copying image: ${ad.name}`,
                            current: adCounter,
                            total: totalAds,
                        });
                        const resolved = await resolveDestMediaImage(destAccountId, accessToken, {
                            sameAccount,
                            sourceHash: sourceImageHash,
                            sourceUrl: sourceImageUrl,
                            fileName: ad.name,
                        });
                        if (!resolved.imageHash) {
                            failures.push(
                                `Ad "${ad.name}": ${resolved.error
                                    || 'could not copy image into destination account (hashes are account-specific)'}`,
                            );
                            stats.failed++;
                            continue;
                        }

                        adResult = await createAdFromImage(
                            destAccountId, asResult.adSetId, destPageId, accessToken,
                            resolved.imageHash, ad.name, settings,
                        );
                    } else {
                        const reason = `Ad "${ad.name}": unsupported creative (no video/image in object_story_spec or asset_feed_spec)`;
                        console.warn(reason);
                        failures.push(reason);
                        stats.failed++;
                        continue;
                    }

                    if (adResult.success) {
                        stats.ads++;
                    } else {
                        const reason = `Ad "${ad.name}": ${adResult.error || 'creation failed'}`;
                        console.error(reason);
                        failures.push(reason);
                        stats.failed++;
                    }
                } catch (adError) {
                    const reason = `Ad "${ad.name}": ${adError instanceof Error ? adError.message : 'Unknown error'}`;
                    console.error(reason);
                    failures.push(reason);
                    stats.failed++;
                }
            }
        }

        // Nothing landed → roll back the empty shell campaign
        if (stats.ads === 0) {
            for (const id of createdAdSetIds) {
                await deleteAdSet(accessToken, id);
            }
            await deleteCampaign(accessToken, newCampaignId);
            onProgress?.({ phase: 'done', message: 'Copy failed — empty campaign rolled back', current: totalAds, total: totalAds });
            const detail = failures.slice(0, 3).join(' · ');
            return {
                success: false,
                error: detail
                    ? `${detail}${failures.length > 3 ? ` (+${failures.length - 3} more)` : ''} — empty campaign rolled back`
                    : 'Copy produced no ads; empty campaign was rolled back',
                stats,
            };
        }

        onProgress?.({ phase: 'done', message: 'Copy complete', current: totalAds, total: totalAds });
        return {
            success: stats.failed === 0,
            campaignId: newCampaignId,
            error: failures.length > 0 ? failures.slice(0, 3).join(' · ') : undefined,
            stats,
        };

    } catch (error) {
        console.error('copyCampaignToAccount error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error', stats };
    }
}

// TypeScript declarations for Facebook SDK
declare global {
    interface Window {
        FB: typeof FB;
        fbAsyncInit: () => void;
    }

    namespace fb {
        interface StatusResponse {
            status: 'connected' | 'not_authorized' | 'unknown';
            authResponse: {
                accessToken: string;
                expiresIn: number;
                signedRequest: string;
                userID: string;
            } | null;
        }
    }

    const FB: {
        init(params: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void;
        login(callback: (response: fb.StatusResponse) => void, options?: { scope: string }): void;
        logout(callback: () => void): void;
        getLoginStatus(callback: (response: fb.StatusResponse) => void): void;
        api(path: string, params: object, callback: (response: unknown) => void): void;
    };
}

export type { MetaUser, AdAccount, VideoUploadResult, Campaign, AdSet, Page, AdCreationResult, Ad, CopiedAdSettings };

