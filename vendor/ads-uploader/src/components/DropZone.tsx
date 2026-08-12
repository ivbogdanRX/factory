import { useRef, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Upload, Film, ImageIcon, X, Grid3X3, List, Settings, Sparkles, Type, Trash, CornerDownLeft } from 'lucide-react';
import { classifyCreatives, buildNames, type CreativeClassification } from '../lib/creativeIntel';
import { addToTaxonomy, getTaxonomy, customFieldToken, type TaxonomyField } from '../lib/taxonomy';
import { ScrambleNumber } from './ScrambleNumber';
import { ScrambleText } from './ScrambleText';
import { PortalDropdown } from './PortalDropdown';
import { DotGridLoader } from './DotGridLoader';
import { TagBar } from './TagBar';

export interface MediaFile {
    id: string;
    file: File;
    name: string;
    type: 'video' | 'image';
    thumbnail: string | null; // object URL or canvas data URL
    // AI organizer metadata
    aiPersona?: string;
    aiStyle?: string;
    aiDescription?: string;
    aiGroup?: string;
    // Tag-based naming
    audience?: string;
    hookAngle?: string;
    creativeStyle?: string;
    // Dynamic custom tags
    customTags?: Record<string, string>;
}

interface DropZoneProps {
    files: MediaFile[];
    onChange: (files: MediaFile[]) => void;
    selectedFileIds: Set<string>;
    onSelectionChange: (ids: Set<string>) => void;
}

/** Extract first-frame thumbnail from a video File */
function extractVideoThumbnail(file: File): Promise<string> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.src = url;
        video.currentTime = 0.5;
        video.addEventListener('seeked', () => {
            const canvas = document.createElement('canvas');
            const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
            // Preserve the full frame (no center-crop) so 9:16 verticals aren't sliced.
            // Scale so the longest side is 320px; keep the native aspect ratio.
            const maxDim = 320;
            const scale = Math.min(maxDim / vw, maxDim / vh, 1);
            canvas.width = Math.round(vw * scale);
            canvas.height = Math.round(vh * scale);
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', 0.75));
        }, { once: true });
        video.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(''); }, { once: true });
    });
}

async function buildMediaFile(file: File): Promise<MediaFile> {
    const id = Math.random().toString(36).slice(2);
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    let thumbnail: string | null = null;
    if (isImage) {
        thumbnail = URL.createObjectURL(file);
    } else if (isVideo) {
        thumbnail = await extractVideoThumbnail(file);
    }
    return {
        id,
        file,
        name: file.name,
        type: isVideo ? 'video' : 'image',
        thumbnail,
    };
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── SuggestionRow ────────────────────────────────────────────────────
function SuggestionRow({
    suggestion, color, affectedFiles, animDelay, onAdd, onDismiss,
}: {
    suggestion: { fieldLabel: string; label: string; fileIds: string[] };
    color: string;
    affectedFiles: MediaFile[];
    animDelay: number;
    onAdd: (label: string) => void;
    onDismiss: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState(suggestion.label);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleEditStart = () => {
        setEditing(true);
        setEditValue(suggestion.label);
        setTimeout(() => inputRef.current?.select(), 10);
    };

    const handleConfirm = () => {
        const final = editValue.trim().replace(/\s+/g, '-');
        if (final) onAdd(final);
        setEditing(false);
    };

    return (
        <div style={{
            borderRadius: 8, overflow: 'hidden',
            background: 'rgba(0,0,0,0.15)',
            animation: `fade-in 0.2s ease ${animDelay}s both`,
        }}>
            {/* Main row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                <span style={{
                    fontSize: 8, fontWeight: 700, color, letterSpacing: '0.06em',
                    textTransform: 'uppercase', minWidth: 48, flexShrink: 0,
                }}>
                    {suggestion.fieldLabel}
                </span>

                {/* Editable label */}
                {editing ? (
                    <input
                        ref={inputRef}
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') handleConfirm();
                            if (e.key === 'Escape') setEditing(false);
                        }}
                        onBlur={handleConfirm}
                        style={{
                            flex: 1, background: 'rgba(6,104,225,0.1)',
                            border: '1px solid rgba(6,104,225,0.4)', borderRadius: 5,
                            padding: '2px 7px', color: '#E5F0FF', fontSize: 11,
                            fontFamily: 'var(--font-mono)', fontWeight: 600, outline: 'none',
                        }}
                    />
                ) : (
                    <button
                        onClick={handleEditStart}
                        title="Click to edit"
                        style={{
                            flex: 1, textAlign: 'left', background: 'none', border: 'none',
                            color: '#ddd', fontSize: 12, fontWeight: 600,
                            fontFamily: 'var(--font-mono)', cursor: 'text', padding: 0,
                        }}
                    >
                        {suggestion.label}
                        <span style={{ marginLeft: 5, fontSize: 9, color: '#555' }}>✎</span>
                    </button>
                )}

                {/* File count */}
                <span style={{ fontSize: 9, color: '#555', flexShrink: 0 }}>
                    {affectedFiles.length} file{affectedFiles.length !== 1 ? 's' : ''}
                </span>

                {/* Add */}
                <button
                    onClick={() => onAdd(editValue.trim().replace(/\s+/g, '-') || suggestion.label)}
                    style={{
                        padding: '3px 10px', borderRadius: 6, flexShrink: 0,
                        background: 'rgba(6,104,225,0.12)', border: '1px solid rgba(6,104,225,0.3)',
                        color: '#6DB3F8', fontSize: 10, fontWeight: 700,
                        cursor: 'pointer', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,104,225,0.22)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(6,104,225,0.12)'; }}
                >
                    Add
                </button>

                {/* Dismiss */}
                <button
                    onClick={onDismiss}
                    style={{
                        width: 22, height: 22, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
                        color: '#555', fontSize: 11, cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#555'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                >
                    ✕
                </button>
            </div>

            {/* File thumbnail strip */}
            {affectedFiles.length > 0 && (
                <div className="hide-scrollbar" style={{
                    display: 'flex', gap: 4, padding: '0 10px 8px',
                    overflowX: 'auto',
                }}>
                    {affectedFiles.map(f => (
                        <div key={f.id} title={f.name} style={{
                            width: 32, height: 32, borderRadius: 5, flexShrink: 0,
                            overflow: 'hidden', background: '#111',
                            border: '1px solid rgba(255,255,255,0.06)',
                        }}>
                            {f.thumbnail ? (
                                <img src={f.thumbnail} alt={f.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                            ) : (
                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    {f.type === 'video'
                                        ? <Film style={{ width: 12, height: 12, color: '#555' }} />
                                        : <ImageIcon style={{ width: 12, height: 12, color: '#555' }} />}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export function DropZone({ files, onChange, selectedFileIds, onSelectionChange }: DropZoneProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [gridCols, setGridCols] = useState(2);
    const [sortKey, setSortKey] = useState<'name' | 'type' | 'size' | 'tags' | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

    const handleSort = (key: 'name' | 'type' | 'size' | 'tags') => {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('asc'); }
    };

    const tagCount = (f: MediaFile) =>
        (f.audience ? 1 : 0) + (f.creativeStyle ? 1 : 0) + (f.hookAngle ? 1 : 0) +
        Object.values(f.customTags ?? {}).filter(Boolean).length;

    const sortedFiles = sortKey ? [...files].sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
        else if (sortKey === 'type') cmp = a.type.localeCompare(b.type);
        else if (sortKey === 'size') cmp = a.file.size - b.file.size;
        else if (sortKey === 'tags') cmp = tagCount(a) - tagCount(b);
        return sortDir === 'asc' ? cmp : -cmp;
    }) : files;
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analyzingFileIds, setAnalyzingFileIds] = useState<Set<string>>(new Set());
    const [, setProgressText] = useState('Processing...');
    const [customFields, setCustomFields] = useState(() => getTaxonomy().customFields);

    useEffect(() => {
        const handleTaxUpdate = () => setCustomFields(getTaxonomy().customFields);
        window.addEventListener('taxonomy-updated', handleTaxUpdate);
        return () => window.removeEventListener('taxonomy-updated', handleTaxUpdate);
    }, []);

    // Inline Editing
    const [editingFileId, setEditingFileId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string>('');

    // Fullscreen Preview
    const [previewFileId, setPreviewFileId] = useState<string | null>(null);

    const handleRenameSubmit = (id: string) => {
        if (!editingName.trim()) {
            setEditingFileId(null);
            return;
        }
        changeWithHistory(files.map(f => f.id === id ? { ...f, name: editingName.trim() } : f));
        setEditingFileId(null);
    };

    const removeTag = (fileId: string, field: 'audience' | 'creativeStyle' | 'hookAngle' | string) => {
        changeWithHistory(files.map(f => {
            if (f.id !== fileId) return f;
            if (field === 'audience') return { ...f, audience: undefined };
            if (field === 'creativeStyle') return { ...f, creativeStyle: undefined };
            if (field === 'hookAngle') return { ...f, hookAngle: undefined };
            // Custom tag
            const customTags = { ...f.customTags };
            delete customTags[field];
            return { ...f, customTags };
        }));
    };

    const [, setIsOrganized] = useState(false);
    const [gearOpen, setGearOpen] = useState(false);
    const [bulkRenameMode, setBulkRenameMode] = useState(false);
    const [bulkRenameExiting, setBulkRenameExiting] = useState(false);
    const [bulkRenameBase, setBulkRenameBase] = useState('');
    const [exitKey, setExitKey] = useState(0);
    const [toastMsg, setToastMsg] = useState<string | null>(null);
    const lastClickedIndex = useRef<number | null>(null);
    const gearRef = useRef<HTMLButtonElement>(null);
    // Undo / Redo history
    const fileHistoryRef = useRef<MediaFile[][]>([]);
    const fileRedoRef = useRef<MediaFile[][]>([]);
    const [, setCanUndo] = useState(false);
    const [, setCanRedo] = useState(false);

    const changeWithHistory = useCallback((newFiles: MediaFile[]) => {
        fileHistoryRef.current = [...fileHistoryRef.current.slice(-29), files];
        fileRedoRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
        onChange(newFiles);
    }, [files, onChange]);

    const handleUndo = useCallback(() => {
        const prev = fileHistoryRef.current.pop();
        if (!prev) return;
        fileRedoRef.current = [...fileRedoRef.current, files];
        setCanUndo(fileHistoryRef.current.length > 0);
        setCanRedo(true);
        onChange(prev);
    }, [files, onChange]);

    const handleRedo = useCallback(() => {
        const next = fileRedoRef.current.pop();
        if (!next) return;
        fileHistoryRef.current = [...fileHistoryRef.current, files];
        setCanUndo(true);
        setCanRedo(fileRedoRef.current.length > 0);
        onChange(next);
    }, [files, onChange]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); handleUndo(); }
            if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) { e.preventDefault(); handleRedo(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [handleUndo, handleRedo]);
    // Tag bar state
    const [tagAudience, setTagAudience] = useState('');
    const [tagHookAngle, setTagHookAngle] = useState('');
    const [tagStyle, setTagStyle] = useState('');
    const [tagCustom, setTagCustom] = useState<Record<string, string>>({});

    // Taxonomy suggestion state
    interface TaxonomySuggestion {
        field: TaxonomyField;
        fieldLabel: string;
        label: string;
        fileIds: string[];
    }
    const [pendingSuggestions, setPendingSuggestions] = useState<TaxonomySuggestion[]>([]);
    const pendingClassificationsRef = useRef<Map<string, CreativeClassification> | null>(null);

    const handleAutoOrganize = async () => {
        const hasSelection = selectedFileIds.size > 0;
        const targetFiles = hasSelection ? files.filter(f => selectedFileIds.has(f.id)) : files;
        if (targetFiles.length === 0) return;
        setIsAnalyzing(true);
        setAnalyzingFileIds(new Set(targetFiles.map(f => f.id)));
        setProgressText('Processing...');

        try {
            const jobsToClassify = targetFiles.map(f => ({ id: f.id, file: f.file, name: f.name, type: f.type }));

            const { classifications, dimensions } = await classifyCreatives(
                jobsToClassify,
                { audience: tagAudience, hookAngle: tagHookAngle, style: tagStyle },
                (phase, current, total) => {
                    if (phase === 'preparing') setProgressText(`Preparing ${current}/${total}`);
                    else if (phase === 'uploading') setProgressText(`Uploading ${current}/${total}`);
                    else setProgressText(`Classifying ${current}/${total}`);
                }
            );

            // Collect names of files NOT being organized, to avoid name collisions
            const existingNames = files
                .filter(f => !targetFiles.some(tf => tf.id === f.id))
                .map(f => f.name);

            const nameMap = buildNames(
                jobsToClassify.map(j => ({ id: j.id, name: j.name })),
                classifications,
                dimensions,
                existingNames
            );

            onChange(files.map(f => {
                const c = classifications.get(f.id);
                if (!c) return f;
                const aiName = nameMap.get(f.id) || f.name;

                // Priority: TagBar force → existing per-file tag → AI result → undefined
                const audience = tagAudience
                    || f.audience
                    || (c.audience !== 'Unknown' ? c.audience : undefined);
                const hookAngle = tagHookAngle
                    || f.hookAngle
                    || (c.hookAngle !== 'Unknown' ? c.hookAngle : undefined);
                const creativeStyle = tagStyle
                    || f.creativeStyle
                    || (c.style !== 'Unknown' ? c.style : undefined);

                return {
                    ...f,
                    name: aiName,
                    audience,
                    hookAngle,
                    creativeStyle,
                    aiPersona: c.audience,
                    aiStyle: c.style,
                    aiDescription: c.description,
                    aiGroup: `${c.audience}-${c.style}`,
                };
            }));

            setIsOrganized(true);

            // Collect AI taxonomy suggestions for Unknown fields
            const suggestionMap = new Map<string, TaxonomySuggestion>();
            for (const [fileId, c] of classifications) {
                const suggestions: { field: TaxonomyField; fieldLabel: string; suggested?: string }[] = [
                    { field: 'audiences', fieldLabel: 'Audience', suggested: c.suggestedAudience },
                    { field: 'hooks', fieldLabel: 'Hook', suggested: c.suggestedHookAngle },
                    { field: 'styles', fieldLabel: 'Style', suggested: c.suggestedStyle },
                ];
                for (const s of suggestions) {
                    if (s.suggested) {
                        const key = `${s.field}:${s.suggested}`;
                        const existing = suggestionMap.get(key);
                        if (existing) {
                            existing.fileIds.push(fileId);
                        } else {
                            suggestionMap.set(key, {
                                field: s.field,
                                fieldLabel: s.fieldLabel,
                                label: s.suggested,
                                fileIds: [fileId],
                            });
                        }
                    }
                }
            }
            const newSuggestions = Array.from(suggestionMap.values());
            if (newSuggestions.length > 0) {
                setPendingSuggestions(newSuggestions);
                pendingClassificationsRef.current = classifications;
            } else {
                setToastMsg(`Organized ${targetFiles.length} file${targetFiles.length !== 1 ? 's' : ''}`);
                setTimeout(() => setToastMsg(null), 2200);
            }

            // Keep organized creatives selected so Deploy still targets them.
            onSelectionChange(new Set(targetFiles.map(f => f.id)));
            lastClickedIndex.current = null;
        } catch (err) {
            console.error('Auto-organize failed:', err);
        }
        setIsAnalyzing(false);
        setAnalyzingFileIds(new Set());
        setProgressText('');
    };

    const handleBulkRename = () => {
        const base = bulkRenameBase.trim().replace(/\}\{/g, '}_{');
        if (!base || files.length === 0) return;
        const hasSelection = selectedFileIds.size > 0;
        const targetIds = hasSelection ? selectedFileIds : new Set(files.map(f => f.id));
        const targetFiles = files.filter(f => targetIds.has(f.id));
        const padLen = targetFiles.length >= 100 ? 3 : 2;
        const customFields = getTaxonomy().customFields;
        const customTokenKeys = customFields.map(cf => cf.key.toLowerCase().replace(/\s+/g, '-'));
        const allTokens = ['n', 'audience', 'style', 'hook', ...customTokenKeys];
        const hasPlaceholders = new RegExp(`\\{(${allTokens.join('|')})\\}`).test(base);
        const ext = (f: MediaFile) => {
            const parts = f.file.name.split('.');
            return parts.length > 1 ? '.' + parts[parts.length - 1] : '';
        };
        // Build prefix counts from existing non-targeted files to avoid collisions
        const prefixCounts = new Map<string, number>();
        for (const f of files) {
            if (targetIds.has(f.id)) continue;
            const nameSansExt = f.name.replace(/\.[^/.]+$/, '');
            const m = nameSansExt.match(/^(.+?)_(\d+)$/);
            if (m) {
                prefixCounts.set(m[1], Math.max(prefixCounts.get(m[1]) || 0, parseInt(m[2], 10)));
            }
        }

        // First pass: resolve each file's prefix (without the number) to group them
        const resolvePrefix = (f: MediaFile) => {
            if (hasPlaceholders) {
                let result = base
                    .replace(/\{n\}/g, '')  // strip the number placeholder
                    .replace(/\{audience\}/g, (f.audience || 'Unknown').replace(/\s+/g, '-'))
                    .replace(/\{style\}/g, (f.creativeStyle || f.aiStyle || 'Unknown').replace(/\s+/g, '-'))
                    .replace(/\{hook\}/g, (f.hookAngle || 'Unknown').replace(/\s+/g, '-'));
                customFields.forEach(cf => {
                    const token = cf.key.toLowerCase().replace(/\s+/g, '-');
                    result = result.replace(new RegExp(`\\{${token}\\}`, 'g'), (f.customTags?.[cf.key] || 'Unknown').replace(/\s+/g, '-'));
                });
                return result.replace(/_$/, '').replace(/^_/, '');
            }
            return base;
        };

        changeWithHistory(files.map(f => {
            if (!targetIds.has(f.id)) return f;
            const prefix = resolvePrefix(f);
            const nextNum = (prefixCounts.get(prefix) || 0) + 1;
            prefixCounts.set(prefix, nextNum);
            const num = String(nextNum).padStart(padLen, '0');
            let name: string;
            if (hasPlaceholders) {
                name = base
                    .replace(/\{n\}/g, num)
                    .replace(/\{audience\}/g, (f.audience || 'Unknown').replace(/\s+/g, '-'))
                    .replace(/\{style\}/g, (f.creativeStyle || f.aiStyle || 'Unknown').replace(/\s+/g, '-'))
                    .replace(/\{hook\}/g, (f.hookAngle || 'Unknown').replace(/\s+/g, '-'));
                customFields.forEach(cf => {
                    const token = cf.key.toLowerCase().replace(/\s+/g, '-');
                    name = name.replace(new RegExp(`\\{${token}\\}`, 'g'), (f.customTags?.[cf.key] || 'Unknown').replace(/\s+/g, '-'));
                });
                name += ext(f);
            } else {
                name = `${base}_${num}${ext(f)}`;
            }
            return { ...f, name };
        }));
        setBulkRenameBase('');
        setBulkRenameMode(false);
        setExitKey(k => k + 1);
        setGearOpen(false);
        onSelectionChange(new Set());
        lastClickedIndex.current = null;
    };

    const exitBulkRename = () => {
        if (bulkRenameExiting) return;
        setBulkRenameExiting(true);
        setTimeout(() => {
            setBulkRenameMode(false);
            setBulkRenameExiting(false);
            setBulkRenameBase('');
            setExitKey(k => k + 1);
            onSelectionChange(new Set());
            lastClickedIndex.current = null;
        }, 150);
    };

    const handleFileClick = (fileId: string, index: number, e: React.MouseEvent) => {
        e.preventDefault();

        const next = new Set(selectedFileIds);

        if (e.shiftKey && lastClickedIndex.current !== null) {
            // Range select — like native OS, shift-click clears previous un-anchored selections
            next.clear();
            const start = Math.min(lastClickedIndex.current, index);
            const end = Math.max(lastClickedIndex.current, index);
            for (let i = start; i <= end; i++) {
                next.add(files[i].id);
            }
        } else if (e.ctrlKey || e.metaKey) {
            // Toggle individual
            if (next.has(fileId)) next.delete(fileId);
            else next.add(fileId);
            // Update anchor on ctrl+click
            lastClickedIndex.current = index;
        } else {
            // Single click — toggle
            if (next.has(fileId) && next.size === 1) {
                next.clear();
            } else {
                next.clear();
                next.add(fileId);
            }
            // Update anchor on normal click
            lastClickedIndex.current = index;
        }

        onSelectionChange(next);
    };

    const addFiles = useCallback(async (newFiles: FileList | File[]) => {
        const arr = Array.from(newFiles).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
        if (arr.length === 0) return;
        const built = await Promise.all(arr.map(buildMediaFile));
        onChange([...files, ...built]);
    }, [files, onChange]);

    const removeFile = (id: string) => {
        const mf = files.find(f => f.id === id);
        if (mf?.thumbnail && mf.type === 'image') URL.revokeObjectURL(mf.thumbnail);
        changeWithHistory(files.filter(f => f.id !== id));
    };

    // Revoke image object URLs on unmount
    useEffect(() => {
        return () => {
            files.forEach(f => { if (f.thumbnail && f.type === 'image') URL.revokeObjectURL(f.thumbnail); });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
    const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); };
    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    };

    const isEmpty = files.length === 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            {/* Drop target — stays compact so Deploy stays usable beside the uploader */}
            <div
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onClick={() => inputRef.current?.click()}
                className={`skeuo-inset ${isDragOver ? 'drop-zone-active' : ''}`}
                style={{
                    flex: 'none',
                    height: isEmpty ? 160 : 100,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer',
                    userSelect: 'none', gap: 12,
                    padding: '16px 20px',
                }}
            >
                {isEmpty ? (
                    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Upload style={{ width: 18, height: 18, color: 'var(--text-muted)' }} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#c0c0c0' }}>
                                Drop media here
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <Film style={{ width: 13, height: 13, color: '#666' }} />
                                <ImageIcon style={{ width: 13, height: 13, color: '#666' }} />
                            </div>
                        </div>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                            Videos and images · click to browse
                        </p>
                    </div>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Upload style={{ width: 18, height: 18, color: 'var(--text-muted)' }} />
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
                            Add more media
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <Film style={{ width: 13, height: 13, color: '#666' }} />
                            <ImageIcon style={{ width: 13, height: 13, color: '#666' }} />
                        </div>
                    </div>
                )}
            </div>

            <input
                ref={inputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files) { addFiles(e.target.files); e.target.value = ''; } }}
            />

            {/* Toast */}
            {toastMsg && (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '6px 14px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#888', fontSize: 11, fontWeight: 600,
                    animation: 'fade-in 0.2s ease both',
                    letterSpacing: '0.03em',
                }}>
                    ✓ {toastMsg}
                </div>
            )}

            {/* Taxonomy Suggestions Panel */}
            {pendingSuggestions.length > 0 && (() => {
                const fieldMap: Record<TaxonomyField, 'audience' | 'hookAngle' | 'creativeStyle'> = {
                    audiences: 'audience', hooks: 'hookAngle', styles: 'creativeStyle',
                };
                return (
                <div style={{
                    borderRadius: 10, padding: 10,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    animation: 'slide-down-fade 0.25s ease both',
                }}>
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        marginBottom: 8,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Sparkles style={{ width: 12, height: 12, color: '#888' }} />
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#888', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                New labels detected
                            </span>
                        </div>
                        <button
                            onClick={() => { setPendingSuggestions([]); pendingClassificationsRef.current = null; }}
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: '#666', fontSize: 10, fontWeight: 600,
                                transition: 'color 0.15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = '#aaa'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = '#666'; }}
                        >
                            Dismiss all
                        </button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {pendingSuggestions.map((s, i) => {
                            const fieldColorMap: Record<string, string> = {
                                Audience: '#6DB3F8',
                                Style: '#30D158',
                                Hook: '#FF9F0A',
                            };
                            const color = fieldColorMap[s.fieldLabel] || '#888';
                            const affectedFiles = files.filter(f => s.fileIds.includes(f.id));

                            return (
                                <SuggestionRow
                                    key={`${s.field}-${s.label}-${i}`}
                                    suggestion={s}
                                    color={color}
                                    affectedFiles={affectedFiles}
                                    animDelay={i * 0.05}
                                    onAdd={(finalLabel) => {
                                        addToTaxonomy(s.field, finalLabel);
                                        const prop = fieldMap[s.field];
                                        onChange(files.map(f => {
                                            if (!s.fileIds.includes(f.id)) return f;
                                            return { ...f, [prop]: finalLabel };
                                        }));
                                        setPendingSuggestions(prev => prev.filter((_, idx) => idx !== i));
                                        setToastMsg(`Added "${finalLabel}" to ${s.fieldLabel}`);
                                        setTimeout(() => setToastMsg(null), 2200);
                                    }}
                                    onDismiss={() => {
                                        setPendingSuggestions(prev => prev.filter((_, idx) => idx !== i));
                                    }}
                                />
                            );
                        })}
                    </div>
                    {/* Accept all button */}
                    {pendingSuggestions.length > 1 && (
                        <button
                            onClick={() => {
                                let updatedFiles = [...files];
                                for (const s of pendingSuggestions) {
                                    addToTaxonomy(s.field, s.label);
                                    const prop = fieldMap[s.field];
                                    updatedFiles = updatedFiles.map(f => {
                                        if (!s.fileIds.includes(f.id)) return f;
                                        return { ...f, [prop]: s.label };
                                    });
                                }
                                onChange(updatedFiles);
                                const count = pendingSuggestions.length;
                                setPendingSuggestions([]);
                                pendingClassificationsRef.current = null;
                                setToastMsg(`Added ${count} new label${count !== 1 ? 's' : ''} to taxonomy`);
                                setTimeout(() => setToastMsg(null), 2200);
                            }}
                            style={{
                                marginTop: 8, width: '100%', padding: '6px 12px', borderRadius: 8,
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid rgba(255,255,255,0.08)',
                                color: '#888', fontSize: 10, fontWeight: 700,
                                cursor: 'pointer', transition: 'all 0.15s',
                                letterSpacing: '0.04em',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                        >
                            Accept all ({pendingSuggestions.length})
                        </button>
                    )}
                </div>
                );
            })()}

            {/* File listing */}
            {files.length > 0 && (
                <div style={{
                    paddingBottom: 8,
                    position: 'sticky',
                    top: 0,
                    zIndex: 20,
                    background: 'linear-gradient(160deg, #242424, #1C1C1E)',
                    marginLeft: -24,
                    marginRight: -24,
                    paddingLeft: 24,
                    paddingRight: 24,
                    paddingTop: 4,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 32 }}>
                        {bulkRenameMode ? (
                            <div style={{ display: 'flex', alignItems: 'flex-start', flex: 1 }}>
                                <span className="cyber-label" style={{
                                    flexShrink: 0, marginRight: 10, width: 95, display: 'inline-block',
                                    marginTop: 8,
                                    animation: bulkRenameExiting ? 'fade-out 0.15s ease forwards' : undefined,
                                }}>
                                    <ScrambleText text="BULK RENAME" style={{ color: '#777' }} />
                                </span>
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                                    <div
                                        className="cyber-input"
                                        style={{
                                            display: 'flex', alignItems: 'center',
                                            padding: '0 6px 0 10px',
                                            animation: bulkRenameExiting ? 'fade-out 0.15s ease forwards' : 'fade-in 0.2s ease both',
                                            height: 32, position: 'relative', zIndex: 2,
                                        }}
                                    >
                                        <input
                                            autoFocus
                                            type="text"
                                            value={bulkRenameBase}
                                            onChange={e => setBulkRenameBase(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') handleBulkRename();
                                                if (e.key === 'Escape') exitBulkRename();
                                            }}
                                            placeholder={`e.g. {audience}_{style}_{hook}${customFields.length > 0 ? '_' + customFields.map(cf => customFieldToken(cf.key)).join('_') : ''}_{n}`}
                                            style={{
                                                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                                                color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)',
                                                padding: 0,
                                            }}
                                        />
                                        <button
                                            onClick={() => { if (bulkRenameBase.trim()) handleBulkRename(); else exitBulkRename(); }}
                                            style={{
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                                                background: bulkRenameBase.trim() ? '#0668E1' : 'transparent',
                                                border: 'none', cursor: 'pointer',
                                                transition: 'all 0.15s',
                                            }}
                                            title={bulkRenameBase.trim() ? 'Apply rename' : 'Cancel'}
                                        >
                                            <CornerDownLeft style={{
                                                width: 12, height: 12,
                                                color: bulkRenameBase.trim() ? '#fff' : '#555',
                                            }} />
                                        </button>
                                    </div>
                                    {/* Placeholder chips */}
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: 4, marginTop: 4,
                                        animation: bulkRenameExiting ? 'fade-out 0.1s ease forwards' : 'slide-down-fade 0.25s ease 0.15s both',
                                    }}>
                                        <span style={{ fontSize: 9, color: '#444', marginRight: 2 }}>Insert:</span>
                                        {[
                                            { label: '{audience}', desc: 'Audience tag' },
                                            { label: '{style}', desc: 'Creative style tag' },
                                            { label: '{hook}', desc: 'Hook / Angle tag' },
                                            { label: '{type}', desc: 'Image or Video' },
                                            ...customFields.map(cf => ({
                                                label: customFieldToken(cf.key),
                                                desc: `${cf.key} tag`,
                                            })),
                                            { label: '{n}', desc: 'Number' },
                                        ].map(p => (
                                            <button
                                                key={p.label}
                                                onClick={() => setBulkRenameBase(prev => prev + p.label)}
                                                title={p.desc}
                                                style={{
                                                    padding: '2px 6px', borderRadius: 4,
                                                    background: 'rgba(255,255,255,0.04)',
                                                    border: '1px solid rgba(255,255,255,0.08)',
                                                    color: '#666', fontSize: 9,
                                                    fontFamily: 'var(--font-mono)',
                                                    cursor: 'pointer', transition: 'all 0.1s',
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.color = '#0668E1'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                                                onMouseLeave={e => { e.currentTarget.style.color = '#666'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                                            >
                                                {p.label}
                                            </button>
                                        ))}
                                    </div>
                                    {/* Live preview */}
                                    {bulkRenameBase.trim() && (() => {
                                        const hasSelection = selectedFileIds.size > 0;
                                        const targetIds = hasSelection ? selectedFileIds : new Set(files.map(f => f.id));
                                        const previewFiles = files.filter(f => targetIds.has(f.id)).slice(0, 2);
                                        const previewCustomTokenKeys = customFields.map(cf => cf.key.toLowerCase().replace(/\s+/g, '-'));
                                        const previewAllTokens = ['n', 'audience', 'style', 'hook', ...previewCustomTokenKeys];
                                        const hasPlaceholders = new RegExp(`\\{(${previewAllTokens.join('|')})\\}`).test(bulkRenameBase);
                                        const padLen = files.filter(f => targetIds.has(f.id)).length >= 100 ? 3 : 2;
                                        return (
                                            <div style={{
                                                marginTop: 6, padding: '4px 8px', borderRadius: 6,
                                                background: 'rgba(0,0,0,0.2)',
                                                border: '1px solid rgba(255,255,255,0.04)',
                                                animation: 'fade-in 0.15s ease both',
                                            }}>
                                                <span style={{ fontSize: 8, color: '#444', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Preview</span>
                                                {previewFiles.map((f, i) => {
                                                    const num = String(i + 1).padStart(padLen, '0');
                                                    const ext = f.file.name.match(/\.[^/.]+$/)?.[0] || '';
                                                    let name: string;
                                                    if (hasPlaceholders) {
                                                        name = bulkRenameBase.replace(/\}\{/g, '}_{')
                                                            .replace(/\{n\}/g, num)
                                                            .replace(/\{offer\}/g, (f.customTags?.offer || f.customTags?.Offer || '').replace(/\s+/g, '-'))
                                                            .replace(/\{audience\}/g, (f.audience || 'Unknown').replace(/\s+/g, '-'))
                                                            .replace(/\{style\}/g, (f.creativeStyle || f.aiStyle || 'Unknown').replace(/\s+/g, '-'))
                                                            .replace(/\{hook\}/g, (f.hookAngle || 'Unknown').replace(/\s+/g, '-'));
                                                        customFields.forEach(cf => {
                                                            const token = cf.key.toLowerCase().replace(/\s+/g, '-');
                                                            name = name.replace(new RegExp(`\\{${token}\\}`, 'g'), (f.customTags?.[cf.key] || 'Unknown').replace(/\s+/g, '-'));
                                                        });
                                                        name += ext;
                                                    } else {
                                                        name = `${bulkRenameBase}_${num}${ext}`;
                                                    }
                                                    return (
                                                        <div key={f.id} style={{ fontSize: 10, color: '#888', fontFamily: 'var(--font-mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {name}
                                                        </div>
                                                    );
                                                })}
                                                {files.filter(f => targetIds.has(f.id)).length > 2 && (
                                                    <div style={{ fontSize: 9, color: '#444', marginTop: 1 }}>…and {files.filter(f => targetIds.has(f.id)).length - 2} more</div>
                                                )}
                                            </div>
                                        );
                                    })()}
                                </div>
                            </div>
                        ) : (
                            /* ── Normal mode: label + toolbar ── */
                            <>
                                <span key={`label-${exitKey}`} className="cyber-label" style={{ animation: 'fade-in 0.2s ease both' }}>
                                    <ScrambleNumber value={selectedFileIds.size} style={{ color: '#0668E1' }} />
                                    {' of '}
                                    <ScrambleNumber value={files.length} style={{ color: '#888' }} />
                                    {' '}
                                    <ScrambleText text="selected" style={{ color: '#777' }} />
                                </span>
                                <div key={`controls-${exitKey}`} style={{ display: 'flex', alignItems: 'center', gap: 6, animation: 'fade-in 0.2s ease both' }}>
                                    {/* Gear menu + optional revert */}
                                    {isAnalyzing ? (
                                        <div style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                                        }}>
                                            <DotGridLoader size={18} />
                                            Processing...
                                        </div>
                                    ) : (
                                        <>
                                            <div style={{ position: 'relative' }}>
                                                <button
                                                    ref={gearRef}
                                                    onClick={() => { setGearOpen(o => !o); }}
                                                    style={{
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        width: 28, height: 28, borderRadius: 8,
                                                        background: gearOpen ? 'rgba(255,255,255,0.07)' : 'transparent',
                                                        border: '1px solid rgba(255,255,255,0.07)',
                                                        cursor: 'pointer', transition: 'all 0.15s',
                                                        color: gearOpen ? 'var(--text)' : 'var(--text-muted)',
                                                    }}
                                                    title="File options"
                                                    onMouseEnter={e => { if (!gearOpen) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'var(--text)'; } }}
                                                    onMouseLeave={e => { if (!gearOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
                                                >
                                                    <Settings style={{ width: 13, height: 13, transition: 'transform 0.3s', transform: gearOpen ? 'rotate(60deg)' : 'none' }} />
                                                </button>

                                                <PortalDropdown isOpen={gearOpen} onClose={() => setGearOpen(false)} anchorRef={gearRef}>
                                                    <div
                                                        className="skeuo-raised animate-fade-in"
                                                        style={{ borderRadius: 12, padding: 6, minWidth: 230 }}
                                                    >
                                                        {/* AI Organize */}
                                                        <button
                                                            onClick={() => { setGearOpen(false); handleAutoOrganize(); }}
                                                            style={{
                                                                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                                                                padding: '9px 10px', borderRadius: 8,
                                                                background: 'transparent', border: 'none',
                                                                fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
                                                                cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                                                            }}
                                                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                                                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                                        >
                                                            <Sparkles style={{ width: 13, height: 13, flexShrink: 0 }} />
                                                            <div>
                                                                <div>AI Smart Organize</div>
                                                                <div style={{ fontSize: 10, fontWeight: 400, color: '#666', marginTop: 1, whiteSpace: 'nowrap' }}>Auto-tag audience, style &amp; hook</div>
                                                            </div>
                                                        </button>

                                                        <div style={{ height: 1, background: 'rgba(255,255,255,0.04)', margin: '4px 0' }} />

                                                        {/* Bulk Rename */}
                                                        <button
                                                            onClick={() => { setGearOpen(false); setBulkRenameMode(true); }}
                                                            style={{
                                                                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                                                                padding: '9px 10px', borderRadius: 8,
                                                                background: 'transparent', border: 'none',
                                                                fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
                                                                cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                                                            }}
                                                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                                                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                                        >
                                                            <Type style={{ width: 13, height: 13, flexShrink: 0 }} />
                                                            <div>
                                                                <div>Bulk Rename</div>
                                                                <div style={{ fontSize: 10, fontWeight: 400, color: '#666', marginTop: 1, whiteSpace: 'nowrap' }}>Rename all to base_01, base_02&hellip;</div>
                                                            </div>
                                                        </button>
                                                    </div>
                                                </PortalDropdown>
                                            </div>
                                        </>
                                    )}
                                    {/* View toggle */}
                                    <div className="skeuo-inset" style={{ display: 'flex', padding: 3, borderRadius: 10, gap: 2 }}>
                                        {viewMode === 'grid' && ([1, 2, 3] as const).map(cols => (
                                            <button
                                                key={cols}
                                                onClick={() => setGridCols(cols)}
                                                className={gridCols === cols ? 'skeuo-raised' : ''}
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    width: 26, height: 26, borderRadius: 8,
                                                    border: 'none', cursor: 'pointer',
                                                    background: gridCols === cols ? undefined : 'transparent',
                                                    color: gridCols === cols ? '#fff' : '#666',
                                                    fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
                                                    transition: 'all 0.2s',
                                                }}
                                            >
                                                {cols}x
                                            </button>
                                        ))}
                                        {(['grid', 'list'] as const).map(mode => (
                                            <button
                                                key={mode}
                                                onClick={() => setViewMode(mode)}
                                                className={viewMode === mode ? 'skeuo-raised' : ''}
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    width: 26, height: 26, borderRadius: 8,
                                                    border: 'none', cursor: 'pointer',
                                                    background: viewMode === mode ? undefined : 'transparent',
                                                    color: viewMode === mode ? '#fff' : '#666',
                                                    transition: 'all 0.2s',
                                                }}
                                            >
                                                {mode === 'grid'
                                                    ? <Grid3X3 style={{ width: 13, height: 13 }} />
                                                    : <List style={{ width: 13, height: 13 }} />
                                                }
                                            </button>
                                        ))}
                                    </div>
                                    <button
                                        onClick={() => {
                                            files.forEach(f => { if (f.thumbnail && f.type === 'image') URL.revokeObjectURL(f.thumbnail); });
                                            onChange([]);
                                            onSelectionChange(new Set());
                                            setIsOrganized(false);
                                        }}
                                        style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            width: 26, height: 26, borderRadius: 8,
                                            background: 'none', border: 'none', cursor: 'pointer',
                                            color: 'var(--text-muted)', transition: 'color 0.15s',
                                            marginLeft: 4,
                                        }}
                                        title="Clear all files"
                                        onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                                    >
                                        <Trash style={{ width: 15, height: 15 }} />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Tag Bar */}
                    {!bulkRenameMode && (
                        <TagBar
                            audience={tagAudience}
                            hookAngle={tagHookAngle}
                            style={tagStyle}
                            onAudienceChange={setTagAudience}
                            onHookAngleChange={setTagHookAngle}
                            onStyleChange={setTagStyle}
                            onApply={() => {
                                if (selectedFileIds.size === 0) return;
                                const targetIds = selectedFileIds;

                                // Apply mode: only set fields that have values, preserve existing
                                const ext = (f: MediaFile) => {
                                    const parts = f.file.name.split('.');
                                    return parts.length > 1 ? '.' + parts[parts.length - 1] : '';
                                };
                                const prefixCounts = new Map<string, number>();
                                for (const f of files) {
                                    if (targetIds.has(f.id)) continue;
                                    const nameSansExt = f.name.replace(/\.[^/.]+$/, '');
                                    const m = nameSansExt.match(/^(.+?)_(\d+)$/);
                                    if (m) {
                                        const prefix = m[1];
                                        const num = parseInt(m[2], 10);
                                        prefixCounts.set(prefix, Math.max(prefixCounts.get(prefix) || 0, num));
                                    }
                                }
                                const totalTargets = files.filter(f => targetIds.has(f.id)).length;
                                const padLen = totalTargets >= 100 ? 3 : 2;

                                changeWithHistory(files.map(f => {
                                    if (!targetIds.has(f.id)) return f;

                                    // empty = preserve existing, __CLEAR__ = remove, value = set
                                    const resolveTag = (tagVal: string, existing: string | undefined) =>
                                        tagVal === '__CLEAR__' ? undefined : tagVal || existing || undefined;
                                    const resolvedAudience = resolveTag(tagAudience, f.audience);
                                    const resolvedStyle = resolveTag(tagStyle, f.creativeStyle);
                                    const resolvedHook = resolveTag(tagHookAngle, f.hookAngle);

                                    // Merge custom tags: __CLEAR__ = delete, empty = keep, value = set
                                    const mergedCustom: Record<string, string> = { ...f.customTags };
                                    for (const [k, v] of Object.entries(tagCustom)) {
                                        if (v === '__CLEAR__') delete mergedCustom[k];
                                        else if (v) mergedCustom[k] = v;
                                    }

                                    const customValues = Object.values(mergedCustom)
                                        .filter(Boolean)
                                        .map(v => v.replace(/\s+/g, '-'));

                                    const parts = [
                                        resolvedAudience,
                                        resolvedStyle,
                                        resolvedHook,
                                        ...customValues,
                                    ].filter(Boolean);

                                    // Build new name; revert to original filename if all tags cleared
                                    let name: string;
                                    if (parts.length > 0) {
                                        const prefix = parts.join('_');
                                        const nextNum = (prefixCounts.get(prefix) || 0) + 1;
                                        prefixCounts.set(prefix, nextNum);
                                        const num = String(nextNum).padStart(padLen, '0');
                                        name = `${prefix}_${num}${ext(f)}`;
                                    } else {
                                        name = f.file.name; // revert to original
                                    }

                                    return {
                                        ...f,
                                        name,
                                        audience: resolvedAudience,
                                        hookAngle: resolvedHook,
                                        creativeStyle: resolvedStyle,
                                        customTags: mergedCustom,
                                    };
                                }));
                                const count = targetIds.size;
                                setToastMsg(`Applied to ${count} file${count !== 1 ? 's' : ''}`);
                                setTimeout(() => setToastMsg(null), 2200);
                            }}
                            customTags={tagCustom}
                            onCustomTagChange={(key, val) => setTagCustom(prev => ({ ...prev, [key]: val }))}
                            onRemoveCustomField={(key) => {
                                changeWithHistory(files.map(f => {
                                    if (!f.customTags || !(key in f.customTags)) return f;
                                    const { [key]: _, ...rest } = f.customTags;
                                    return { ...f, customTags: rest };
                                }));
                                setTagCustom(prev => {
                                    const { [key]: _, ...rest } = prev;
                                    return rest;
                                });
                            }}
                            onCustomFieldsChange={() => setCustomFields(getTaxonomy().customFields)}
                            canApply={true}
                            selectedCount={selectedFileIds.size}
                            totalCount={files.length}
                        />
                    )}
                </div>
            )}

            {/* File Cards */}
            {files.length > 0 && (
                <>
                    {/* Grid View */}
                    {viewMode === 'grid' && (
                        <div className="thumb-grid" style={{ animation: 'fade-in 0.25s ease both', gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}>
                            {files.map((mf, idx) => {
                                const isSelected = selectedFileIds.has(mf.id);
                                const isBeingAnalyzed = analyzingFileIds.has(mf.id);
                                const tags: { color: string; bg: string; border: string; text: string; field: string }[] = [];
                                if (mf.audience) tags.push({ color: '#0668E1', bg: 'rgba(6,104,225,0.1)', border: 'rgba(6,104,225,0.2)', text: mf.audience, field: 'audience' });
                                if (mf.creativeStyle) tags.push({ color: '#30D158', bg: 'rgba(48,209,88,0.08)', border: 'rgba(48,209,88,0.2)', text: mf.creativeStyle, field: 'creativeStyle' });
                                if (mf.hookAngle) tags.push({ color: '#FF9F0A', bg: 'rgba(255,159,10,0.08)', border: 'rgba(255,159,10,0.2)', text: mf.hookAngle, field: 'hookAngle' });
                                if (mf.customTags) {
                                    Object.entries(mf.customTags).forEach(([k, v]) => {
                                        if (v) tags.push({ color: '#BF5AF2', bg: 'rgba(191,90,242,0.08)', border: 'rgba(191,90,242,0.2)', text: v, field: k });
                                    });
                                }
                                return (
                                    <div
                                        key={mf.id}
                                        className={`thumb-item${isBeingAnalyzed ? ' ai-analyzing' : ''}`}
                                        onClick={(e) => handleFileClick(mf.id, idx, e)}
                                        style={{
                                            cursor: 'pointer',
                                            userSelect: 'none',
                                            borderColor: isSelected ? '#0668E1' : undefined,
                                        }}
                                    >
                                        {/* Thumbnail area */}
                                        <div className="thumb-item-img">
                                            {mf.thumbnail ? (
                                                <img src={mf.thumbnail} alt={mf.name} />
                                            ) : (
                                                <div style={{
                                                    width: '100%', height: '100%',
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    background: '#1C1C1E',
                                                }}>
                                                    {mf.type === 'video'
                                                        ? <Film style={{ width: 28, height: 28, color: '#555' }} />
                                                        : <ImageIcon style={{ width: 28, height: 28, color: '#555' }} />
                                                    }
                                                </div>
                                            )}
                                            {isSelected && (
                                                <div style={{
                                                    position: 'absolute', inset: 0,
                                                    background: 'linear-gradient(180deg, transparent 0%, rgba(6,104,225,0.9) 100%)',
                                                    pointerEvents: 'none',
                                                }} />
                                            )}
                                            <button
                                                className="thumb-remove"
                                                onClick={(e) => { e.stopPropagation(); removeFile(mf.id); }}
                                                title="Remove"
                                            >
                                                <X style={{ width: 10, height: 10 }} />
                                            </button>
                                        </div>

                                        {/* Footer: name + tags */}
                                        <div className="thumb-footer">
                                            <div
                                                className="thumb-footer-name"
                                                onDoubleClick={(e) => {
                                                    e.stopPropagation();
                                                    setEditingFileId(mf.id);
                                                    setEditingName(mf.name);
                                                }}
                                            >
                                                {mf.type === 'video'
                                                    ? <Film style={{ width: 10, height: 10, flexShrink: 0 }} />
                                                    : <ImageIcon style={{ width: 10, height: 10, flexShrink: 0 }} />
                                                }
                                                {editingFileId === mf.id ? (
                                                    <input
                                                        autoFocus
                                                        type="text"
                                                        value={editingName}
                                                        onChange={(e) => setEditingName(e.target.value)}
                                                        onBlur={() => handleRenameSubmit(mf.id)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') handleRenameSubmit(mf.id);
                                                            if (e.key === 'Escape') setEditingFileId(null);
                                                        }}
                                                        onClick={(e) => e.stopPropagation()}
                                                        style={{
                                                            background: 'transparent', border: 'none', outline: 'none',
                                                            color: '#fff', fontSize: 9, width: '100%', fontFamily: 'inherit'
                                                        }}
                                                    />
                                                ) : (
                                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {mf.name}
                                                    </span>
                                                )}
                                            </div>
                                            {tags.length > 0 && (
                                                <div className="thumb-footer-tags">
                                                    {tags.map((t, i) => (
                                                        <span key={i} style={{
                                                            padding: '0px 4px', borderRadius: 3, flexShrink: 0,
                                                            background: t.bg, border: `1px solid ${t.border}`,
                                                            color: t.color, fontSize: 7, fontWeight: 700,
                                                            lineHeight: '14px', whiteSpace: 'nowrap',
                                                            display: 'inline-flex', alignItems: 'center', gap: 2,
                                                        }}>
                                                            {t.text}
                                                            <span onClick={(e) => { e.stopPropagation(); removeTag(mf.id, t.field); }} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 6, lineHeight: 1 }} title="Remove">✕</span>
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* List View */}
                    {viewMode === 'list' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, animation: 'fade-in 0.25s ease both' }}>
                            {/* Sort header */}
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '0 12px 2px', userSelect: 'none',
                            }}>
                                {/* thumbnail spacer */}
                                <div style={{ width: 36, flexShrink: 0 }} />
                                {/* Name */}
                                {(['name', 'type', 'size', 'tags'] as const).map((key) => {
                                    const labels: Record<string, string> = { name: 'Name', type: 'Type', size: 'Size', tags: 'Tags' };
                                    const active = sortKey === key;
                                    return (
                                        <div
                                            key={key}
                                            onClick={() => handleSort(key)}
                                            style={{
                                                flex: key === 'name' ? 1 : 'none',
                                                minWidth: key === 'name' ? 0 : undefined,
                                                width: key === 'type' ? 38 : key === 'size' ? 38 : key === 'tags' ? 28 : undefined,
                                                fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                                                color: active ? '#aaa' : '#444',
                                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3,
                                                transition: 'color 0.15s',
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.color = active ? '#ccc' : '#777')}
                                            onMouseLeave={e => (e.currentTarget.style.color = active ? '#aaa' : '#444')}
                                        >
                                            {labels[key]}
                                            {active && (
                                                <span style={{ fontSize: 8, lineHeight: 1 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                                            )}
                                        </div>
                                    );
                                })}
                                {/* remove btn spacer */}
                                <div style={{ width: 24, flexShrink: 0 }} />
                            </div>
                            {sortedFiles.map((mf, idx) => {
                                const isSelected = selectedFileIds.has(mf.id);
                                const isBeingAnalyzed = analyzingFileIds.has(mf.id);
                                return (
                                    <div
                                        key={mf.id}
                                        className={`skeuo-raised${isBeingAnalyzed ? ' ai-analyzing' : ''}`}
                                        onClick={(e) => handleFileClick(mf.id, idx, e)}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 10,
                                            padding: '8px 12px', borderRadius: 12,
                                            cursor: 'pointer', userSelect: 'none',
                                            border: isSelected ? '1px solid #0668E1' : undefined,
                                        }}
                                    >
                                        {/* Mini thumbnail */}
                                        <div 
                                            onClick={(e) => { e.stopPropagation(); setPreviewFileId(mf.id); }}
                                            style={{
                                                width: 36, height: 36, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
                                                background: '#0D0D0D', boxShadow: 'inset 1px 1px 4px rgba(0,0,0,0.6)', cursor: 'zoom-in'
                                            }}
                                            title="Click to preview"
                                        >
                                            {mf.thumbnail ? (
                                                <img src={mf.thumbnail} alt={mf.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                            ) : (
                                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                    {mf.type === 'video'
                                                        ? <Film style={{ width: 16, height: 16, color: '#555' }} />
                                                        : <ImageIcon style={{ width: 16, height: 16, color: '#555' }} />
                                                    }
                                                </div>
                                            )}
                                        </div>
                                        {/* File name + meta + tags */}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div 
                                                onDoubleClick={(e) => { e.stopPropagation(); setEditingFileId(mf.id); setEditingName(mf.name); }}
                                                style={{ fontSize: 12, fontWeight: 600, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}
                                            >
                                                {editingFileId === mf.id ? (
                                                    <input autoFocus type="text" value={editingName}
                                                        onChange={(e) => setEditingName(e.target.value)}
                                                        onBlur={() => handleRenameSubmit(mf.id)}
                                                        onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(mf.id); if (e.key === 'Escape') setEditingFileId(null); }}
                                                        onClick={(e) => e.stopPropagation()}
                                                        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(6,104,225,0.5)', outline: 'none', borderRadius: 4, color: '#fff', fontSize: 12, width: '100%', fontFamily: 'inherit', padding: '0 4px' }}
                                                    />
                                                ) : (
                                                    <span className={isBeingAnalyzed ? 'ai-analyzing-name' : ''}>{mf.name}</span>
                                                )}
                                            </div>
                                            <div style={{ position: 'relative', marginTop: 2, overflow: 'hidden' }}>
                                                <div
                                                    className="hide-scrollbar"
                                                    style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 6, color: '#555', overflowX: 'auto', paddingRight: 16 }}
                                                    onWheel={(e) => { if (e.shiftKey) { e.preventDefault(); (e.currentTarget as HTMLDivElement).scrollLeft += e.deltaY; } }}
                                                >
                                                    <span style={{ flexShrink: 0 }}>{formatSize(mf.file.size)}</span>
                                                    {mf.audience && (
                                                        <span style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(6,104,225,0.1)', border: '1px solid rgba(6,104,225,0.2)', color: '#6DB3F8', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                            {mf.audience}
                                                            <span onClick={(e) => { e.stopPropagation(); removeTag(mf.id, 'audience'); }} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 8, lineHeight: 1 }} title="Remove tag">✕</span>
                                                        </span>
                                                    )}
                                                    {mf.creativeStyle && (
                                                        <span style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(48,209,88,0.08)', border: '1px solid rgba(48,209,88,0.2)', color: '#30D158', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                            {mf.creativeStyle}
                                                            <span onClick={(e) => { e.stopPropagation(); removeTag(mf.id, 'creativeStyle'); }} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 8, lineHeight: 1 }} title="Remove tag">✕</span>
                                                        </span>
                                                    )}
                                                    {mf.hookAngle && (
                                                        <span style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.2)', color: '#FF9F0A', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                            {mf.hookAngle}
                                                            <span onClick={(e) => { e.stopPropagation(); removeTag(mf.id, 'hookAngle'); }} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 8, lineHeight: 1 }} title="Remove tag">✕</span>
                                                        </span>
                                                    )}
                                                    {mf.customTags && Object.entries(mf.customTags).map(([key, val]) => val ? (
                                                        <span key={key} style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(191,90,242,0.08)', border: '1px solid rgba(191,90,242,0.2)', color: '#BF5AF2', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                            {val}
                                                            <span onClick={(e) => { e.stopPropagation(); removeTag(mf.id, key); }} style={{ cursor: 'pointer', opacity: 0.5, fontSize: 8, lineHeight: 1 }} title="Remove tag">✕</span>
                                                        </span>
                                                    ) : null)}
                                                </div>
                                                <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 20, pointerEvents: 'none', background: 'linear-gradient(to right, transparent, #1e1e1e)' }} />
                                            </div>
                                        </div>
                                        {/* Remove */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); removeFile(mf.id); }}
                                            title="Remove"
                                            style={{
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                                                background: 'none', border: 'none', cursor: 'pointer',
                                                color: '#555', transition: 'color 0.15s, background 0.15s',
                                            }}
                                            onMouseEnter={e => { e.currentTarget.style.color = '#FF453A'; e.currentTarget.style.background = 'rgba(255,69,58,0.1)'; }}
                                            onMouseLeave={e => { e.currentTarget.style.color = '#555'; e.currentTarget.style.background = 'none'; }}
                                        >
                                            <X style={{ width: 12, height: 12 }} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}

            {/* Fullscreen Preview Modal */}
            {previewFileId && (() => {
                const previewFile = files.find(f => f.id === previewFileId);
                if (!previewFile) return null;
                const srcUrl = URL.createObjectURL(previewFile.file);
                return createPortal(
                    <div 
                        onClick={() => setPreviewFileId(null)}
                        style={{
                            position: 'fixed', inset: 0, zIndex: 10000,
                            background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 40
                        }}
                    >
                        <div 
                            onClick={(e) => e.stopPropagation()}
                            style={{ position: 'relative', maxWidth: '100%', maxHeight: '100%' }}
                        >
                            <button
                                onClick={() => setPreviewFileId(null)}
                                style={{
                                    position: 'absolute', top: -40, right: 0,
                                    background: 'transparent', border: 'none', color: '#fff',
                                    cursor: 'pointer', padding: 8
                                }}
                            >
                                <X style={{ width: 24, height: 24 }} />
                            </button>
                            {previewFile.type === 'video' ? (
                                <video 
                                    src={srcUrl} 
                                    autoPlay 
                                    controls 
                                    style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 80px)', borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} 
                                />
                            ) : (
                                <img 
                                    src={srcUrl} 
                                    alt={previewFile.name} 
                                    style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 80px)', borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} 
                                />
                            )}
                        </div>
                    </div>,
                    document.body
                );
            })()}
        </div>
    );
}
