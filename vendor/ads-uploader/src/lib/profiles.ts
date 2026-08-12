/**
 * Local multi-profile support — no passwords, just named workspaces so
 * people sharing a browser don't mix staged creatives / taxonomy.
 */

export interface Profile {
    id: string;
    name: string;
    createdAt: number;
    /** Soft accent for the avatar chip (hex). */
    color: string;
}

const PROFILES_KEY = 'ads-uploader-profiles';
const ACTIVE_KEY = 'ads-uploader-active-profile';

/** Palette for avatar chips — cycles as profiles are created. */
const PROFILE_COLORS = [
    '#0668E1', '#30D158', '#FF9F0A', '#FF453A',
    '#BF5AF2', '#64D2FF', '#FF375F', '#AC8E68',
];

function loadProfiles(): Profile[] {
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p): p is Profile =>
                p && typeof p.id === 'string' && typeof p.name === 'string',
        );
    } catch {
        return [];
    }
}

function saveProfiles(profiles: Profile[]) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    window.dispatchEvent(new Event('profiles-updated'));
}

export function getProfiles(): Profile[] {
    return loadProfiles();
}

export function getActiveProfileId(): string | null {
    return localStorage.getItem(ACTIVE_KEY);
}

export function getActiveProfile(): Profile | null {
    const id = getActiveProfileId();
    if (!id) return null;
    return loadProfiles().find(p => p.id === id) ?? null;
}

export function setActiveProfile(id: string | null) {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
    window.dispatchEvent(new Event('active-profile-changed'));
}

function nextColor(existing: Profile[]): string {
    const used = new Set(existing.map(p => p.color));
    return PROFILE_COLORS.find(c => !used.has(c)) ?? PROFILE_COLORS[existing.length % PROFILE_COLORS.length];
}

function slugId(name: string): string {
    const base = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 24) || 'user';
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates a profile. When it's the first one ever, migrate any pre-profile
 * taxonomy / IndexedDB data into it so existing work isn't orphaned.
 */
export function createProfile(name: string): Profile {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Profile name is required');

    const profiles = loadProfiles();
    if (profiles.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
        throw new Error('A profile with that name already exists');
    }

    const profile: Profile = {
        id: slugId(trimmed),
        name: trimmed,
        createdAt: Date.now(),
        color: nextColor(profiles),
    };

    const isFirst = profiles.length === 0;
    saveProfiles([...profiles, profile]);

    if (isFirst) migrateLegacyData(profile.id);

    return profile;
}

export function renameProfile(id: string, name: string): Profile | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const profiles = loadProfiles();
    if (profiles.some(p => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
        throw new Error('A profile with that name already exists');
    }
    const idx = profiles.findIndex(p => p.id === id);
    if (idx < 0) return null;
    profiles[idx] = { ...profiles[idx], name: trimmed };
    saveProfiles(profiles);
    return profiles[idx];
}

export function deleteProfile(id: string): void {
    const profiles = loadProfiles().filter(p => p.id !== id);
    saveProfiles(profiles);
    if (getActiveProfileId() === id) setActiveProfile(null);
    // Storage cleanup (IndexedDB + taxonomy) is handled by callers that
    // know about those modules — see clearProfileData.
}

/** Storage keys / DB names scoped to a profile. */
export function taxonomyStorageKey(profileId: string): string {
    return `ads-uploader-taxonomy:${profileId}`;
}

export function filesDbName(profileId: string): string {
    return `ads-uploader-${profileId}`;
}

const LEGACY_TAXONOMY_KEY = 'ads-uploader-taxonomy';
const LEGACY_DB_NAME = 'ads-uploader';

function migrateLegacyData(profileId: string) {
    try {
        const legacy = localStorage.getItem(LEGACY_TAXONOMY_KEY);
        if (legacy && !localStorage.getItem(taxonomyStorageKey(profileId))) {
            localStorage.setItem(taxonomyStorageKey(profileId), legacy);
            localStorage.removeItem(LEGACY_TAXONOMY_KEY);
        }
    } catch { /* ignore */ }
    // IndexedDB migration runs from App on first hydrate via migrateLegacyFilesDb
}

/** Copy blobs/state from the pre-profile DB into the new profile DB. */
export async function migrateLegacyFilesDb(profileId: string): Promise<void> {
    try {
        const legacyExists = await databaseExists(LEGACY_DB_NAME);
        if (!legacyExists) return;

        const source = await openNamedDb(LEGACY_DB_NAME);
        const target = await openNamedDb(filesDbName(profileId));

        const srcTx = source.transaction(['file-blobs', 'session-state'], 'readonly');
        const blobs = await idbGetAll(srcTx.objectStore('file-blobs'));
        const state = await idbGet(srcTx.objectStore('session-state'), 'files');
        source.close();

        if (blobs.length === 0 && !state) {
            target.close();
            return;
        }

        const dstTx = target.transaction(['file-blobs', 'session-state'], 'readwrite');
        for (const b of blobs) dstTx.objectStore('file-blobs').put(b);
        if (state) dstTx.objectStore('session-state').put(state);
        await idbTxDone(dstTx);
        target.close();

        // Drop legacy DB so it isn't double-migrated later
        await deleteDatabase(LEGACY_DB_NAME);
    } catch (err) {
        console.warn('Legacy file migration failed (non-fatal):', err);
    }
}

export async function clearProfileData(profileId: string): Promise<void> {
    try {
        localStorage.removeItem(taxonomyStorageKey(profileId));
        // Legacy per-profile token key (Meta token is now shared globally)
        localStorage.removeItem(`ads-uploader-meta-token:${profileId}`);
    } catch { /* ignore */ }
    try {
        await deleteDatabase(filesDbName(profileId));
    } catch (err) {
        console.warn('Failed to delete profile IndexedDB:', err);
    }
}

// ── tiny IndexedDB helpers (kept here so profiles can migrate/delete) ──

function databaseExists(name: string): Promise<boolean> {
    return new Promise(resolve => {
        if (!indexedDB.databases) {
            // Safari fallback: try open and check version — treat open as exists
            const req = indexedDB.open(name);
            req.onsuccess = () => {
                const db = req.result;
                const existed = db.objectStoreNames.length > 0;
                db.close();
                if (!existed) void deleteDatabase(name);
                resolve(existed);
            };
            req.onerror = () => resolve(false);
            return;
        }
        indexedDB.databases().then(dbs => {
            resolve(dbs.some(d => d.name === name));
        }).catch(() => resolve(false));
    });
}

function openNamedDb(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('file-blobs')) {
                db.createObjectStore('file-blobs', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('session-state')) {
                db.createObjectStore('session-state', { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(); // best-effort
    });
}

function idbGetAll(store: IDBObjectStore): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet(store: IDBObjectStore, key: IDBValidKey): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
