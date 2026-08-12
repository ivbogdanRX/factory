import { useState, useEffect, useRef, useCallback } from 'react';
import type { MetaUser } from './lib/meta';
import { persistFiles, loadPersistedFiles } from './lib/filePersistence';
import {
    migrateLegacyFilesDb,
    type Profile,
} from './lib/profiles';
import { DropZone, type MediaFile } from './components/DropZone';
import { MetaConnectButton } from './components/MetaConnectButton';
import { UploadPanel } from './components/UploadPanel';
import { ScrambleNumber } from './components/ScrambleNumber';
import { ScrambleText, type ScrambleTextHandle } from './components/ScrambleText';
import { ProfilePicker } from './components/ProfilePicker';
import { ArrowLeftRight } from 'lucide-react';

export default function App() {
    // Always pick a profile on open so shared machines don't land in someone else's workspace.
    // Last-used is remembered for highlighting in the picker, but not auto-entered.
    const [profile, setProfile] = useState<Profile | null>(null);
    const [metaUser, setMetaUser] = useState<MetaUser | null>(null);
    const [files, setFiles] = useState<MediaFile[]>([]);
    const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
    const [hydrated, setHydrated] = useState(false);
    const scrambleRef = useRef<ScrambleTextHandle>(null);
    const knownFileIdsRef = useRef<Set<string>>(new Set());

    const handleFilesChange = useCallback((nextFiles: MediaFile[]) => {
        setFiles(nextFiles);
        const nextIds = new Set(nextFiles.map(f => f.id));
        const prevIds = knownFileIdsRef.current;
        const addedIds = nextFiles.filter(f => !prevIds.has(f.id)).map(f => f.id);
        knownFileIdsRef.current = nextIds;

        setSelectedFileIds(prev => {
            // Drop ids for removed files; auto-select newly added creatives.
            const next = new Set([...prev].filter(id => nextIds.has(id)));
            for (const id of addedIds) next.add(id);
            // Fresh batch (e.g. restored from disk) with nothing selected → select all.
            if (next.size === 0 && nextFiles.length > 0 && addedIds.length === nextFiles.length) {
                return new Set(nextIds);
            }
            return next;
        });
    }, []);

    // Restore files for the active profile (expire after 24h)
    useEffect(() => {
        if (!profile) {
            setFiles([]);
            setSelectedFileIds(new Set());
            knownFileIdsRef.current = new Set();
            setHydrated(false);
            return;
        }

        let cancelled = false;
        setHydrated(false);
        setFiles([]);
        setSelectedFileIds(new Set());
        knownFileIdsRef.current = new Set();

        (async () => {
            await migrateLegacyFilesDb(profile.id);
            if (cancelled) return;
            const restored = await loadPersistedFiles();
            if (cancelled) return;
            if (restored.length > 0) {
                knownFileIdsRef.current = new Set(restored.map(f => f.id));
                setFiles(restored);
                setSelectedFileIds(new Set(restored.map(f => f.id)));
            }
            setHydrated(true);
        })();

        return () => { cancelled = true; };
    }, [profile?.id]);

    // Persist files on change (debounced) so a refresh doesn't lose them
    useEffect(() => {
        if (!hydrated || !profile) return;
        const t = setTimeout(() => { persistFiles(files); }, 500);
        return () => clearTimeout(t);
    }, [files, hydrated, profile?.id]);

    function handleProfileSelect(p: Profile) {
        setMetaUser(null);
        setProfile(p);
    }

    function handleSwitchProfile() {
        // Keep ACTIVE_KEY so the picker can highlight last-used; just leave the workspace.
        setProfile(null);
        setMetaUser(null);
        setFiles([]);
        setSelectedFileIds(new Set());
        knownFileIdsRef.current = new Set();
        setHydrated(false);
    }

    if (!profile) {
        return <ProfilePicker onSelect={handleProfileSelect} />;
    }

    return (
        <div className="app-container">
            <div className="dual-layout expanded">
                {/* ── Left Card: Header + Drop Zone ── */}
                <div className="main-card left-card">
                    <div className="card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div
                                className="skeuo-primary"
                                onClick={() => scrambleRef.current?.scramble()}
                                style={{
                                    width: 34, height: 34, borderRadius: 10,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    cursor: 'pointer', transition: 'transform 0.15s',
                                }}
                                onMouseDown={e => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(0.92)'; }}
                                onMouseUp={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; }}
                            >
                                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18, color: '#fff' }}>
                                    <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
                                </svg>
                            </div>
                            <ScrambleText ref={scrambleRef} text="Uploader" repeatInterval={[30000, 60000]} style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: '#f0f0f5', letterSpacing: '0.05em' }} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, minWidth: 160 }}>
                            <button
                                type="button"
                                className="profile-chip"
                                onClick={handleSwitchProfile}
                                title="Switch profile"
                            >
                                <span
                                    className="profile-avatar"
                                    style={{ background: profile.color, width: 22, height: 22, fontSize: 10 }}
                                >
                                    {profile.name.charAt(0).toUpperCase()}
                                </span>
                                <span className="profile-chip-name">{profile.name}</span>
                                <ArrowLeftRight size={12} style={{ opacity: 0.5 }} />
                            </button>
                            <MetaConnectButton onConnect={setMetaUser} onDisconnect={() => setMetaUser(null)} />
                        </div>
                    </div>

                    <div className="card-body custom-scrollbar">
                        <div className="card-section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                            <DropZone
                                files={files}
                                onChange={handleFilesChange}
                                selectedFileIds={selectedFileIds}
                                onSelectionChange={setSelectedFileIds}
                            />
                        </div>
                    </div>
                </div>

                {/* ── Right Card: Upload Panel (always available so campaign can be set up while adding media) ── */}
                <div className="main-card right-card">
                    <div className="card-header">
                        <ScrambleText 
                            text="Deploy" 
                            repeatInterval={[30000, 60000]} 
                            style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: '#f0f0f5', letterSpacing: '0.05em' }} 
                        />
                        <span className="cyber-label" style={{ color: '#666' }}>
                            <ScrambleNumber value={selectedFileIds.size} style={{ color: '#0668E1' }} />
                            {' of '}
                            <ScrambleNumber value={files.length} style={{ color: '#888' }} />
                            {' selected'}
                        </span>
                    </div>
                    <div className="card-body" style={{ overflow: 'hidden' }}>
                        <div className="card-section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingTop: 0 }}>
                            <UploadPanel
                                metaUser={metaUser}
                                files={files}
                                selectedFileIds={selectedFileIds}
                                onSelectionChange={setSelectedFileIds}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
