import type { MediaFile } from '../components/DropZone';
import { filesDbName, getActiveProfileId } from './profiles';

/**
 * Persists dropped files (blobs + tags) to IndexedDB so a page refresh
 * doesn't lose them. Entries expire after TTL_MS from the last save.
 * Storage is scoped per active profile.
 */

const DB_VERSION = 1;
const BLOB_STORE = 'file-blobs';       // { id, file } — written once per file, never rewritten on tag edits
const STATE_STORE = 'session-state';   // single record: file order + per-file metadata + savedAt
const STATE_KEY = 'files';
const TTL_MS = 24 * 60 * 60 * 1000;

type PersistedMeta = Omit<MediaFile, 'file'>;

interface PersistedState {
    key: string;
    savedAt: number;
    order: string[];
    metaById: Record<string, PersistedMeta>;
}

function requireProfileId(): string {
    const id = getActiveProfileId();
    if (!id) throw new Error('No active profile — cannot access file storage');
    return id;
}

function openDb(profileId?: string): Promise<IDBDatabase> {
    const dbName = filesDbName(profileId ?? requireProfileId());
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function persistFiles(files: MediaFile[]): Promise<void> {
    try {
        if (!getActiveProfileId()) return;
        const db = await openDb();
        const tx = db.transaction([BLOB_STORE, STATE_STORE], 'readwrite');
        const blobs = tx.objectStore(BLOB_STORE);

        // Only write blobs for new files and delete removed ones — tag edits
        // then only rewrite the small metadata record, not the videos.
        const wantedIds = new Set(files.map(f => f.id));
        const existingIds = (await asPromise(blobs.getAllKeys())) as string[];
        for (const id of existingIds) if (!wantedIds.has(id)) blobs.delete(id);
        const existing = new Set(existingIds);
        for (const f of files) if (!existing.has(f.id)) blobs.put({ id: f.id, file: f.file });

        const metaById: Record<string, PersistedMeta> = {};
        for (const f of files) {
            const { file: _file, ...meta } = f;
            // Object URLs die on refresh — image thumbnails get regenerated on restore
            if (meta.thumbnail?.startsWith('blob:')) meta.thumbnail = null;
            metaById[f.id] = meta;
        }
        const state: PersistedState = { key: STATE_KEY, savedAt: Date.now(), order: files.map(f => f.id), metaById };
        tx.objectStore(STATE_STORE).put(state);

        await txDone(tx);
        db.close();
    } catch (err) {
        console.warn('File persistence failed (non-fatal):', err);
    }
}

export async function loadPersistedFiles(): Promise<MediaFile[]> {
    try {
        if (!getActiveProfileId()) return [];
        const db = await openDb();
        const tx = db.transaction([BLOB_STORE, STATE_STORE], 'readonly');
        const state = (await asPromise(tx.objectStore(STATE_STORE).get(STATE_KEY))) as PersistedState | undefined;
        if (!state || state.order.length === 0) { db.close(); return []; }
        if (Date.now() - state.savedAt > TTL_MS) {
            db.close();
            await clearPersistedFiles();
            return [];
        }

        const records = (await asPromise(tx.objectStore(BLOB_STORE).getAll())) as { id: string; file: File | Blob }[];
        db.close();
        const blobById = new Map(records.map(r => [r.id, r.file]));

        const restored: MediaFile[] = [];
        for (const id of state.order) {
            const blob = blobById.get(id);
            const meta = state.metaById[id];
            if (!blob || !meta) continue;
            const file = blob instanceof File ? blob : new File([blob], meta.name, { type: blob.type });
            let thumbnail = meta.thumbnail;
            if (!thumbnail && meta.type === 'image') thumbnail = URL.createObjectURL(file);
            restored.push({ ...meta, file, thumbnail });
        }
        return restored;
    } catch (err) {
        console.warn('Restoring persisted files failed (non-fatal):', err);
        return [];
    }
}

export async function clearPersistedFiles(): Promise<void> {
    try {
        if (!getActiveProfileId()) return;
        const db = await openDb();
        const tx = db.transaction([BLOB_STORE, STATE_STORE], 'readwrite');
        tx.objectStore(BLOB_STORE).clear();
        tx.objectStore(STATE_STORE).clear();
        await txDone(tx);
        db.close();
    } catch (err) {
        console.warn('Clearing persisted files failed (non-fatal):', err);
    }
}
