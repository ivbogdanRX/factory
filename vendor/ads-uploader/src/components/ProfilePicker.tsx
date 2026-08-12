import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, ChevronRight } from 'lucide-react';
import {
    getProfiles,
    getActiveProfileId,
    createProfile,
    deleteProfile,
    setActiveProfile,
    clearProfileData,
    type Profile,
} from '../lib/profiles';

interface ProfilePickerProps {
    onSelect: (profile: Profile) => void;
}

export function ProfilePicker({ onSelect }: ProfilePickerProps) {
    const [profiles, setProfiles] = useState<Profile[]>(() => getProfiles());
    const [lastUsedId] = useState(() => getActiveProfileId());
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [creating, setCreating] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const sync = () => setProfiles(getProfiles());
        window.addEventListener('profiles-updated', sync);
        return () => window.removeEventListener('profiles-updated', sync);
    }, []);

    useEffect(() => {
        if (creating || profiles.length === 0) {
            inputRef.current?.focus();
        }
    }, [creating, profiles.length]);

    function handleCreate(e?: React.FormEvent) {
        e?.preventDefault();
        setError('');
        try {
            const profile = createProfile(name);
            setName('');
            setCreating(false);
            setProfiles(getProfiles());
            setActiveProfile(profile.id);
            onSelect(profile);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create profile');
        }
    }

    function handleSelect(profile: Profile) {
        setActiveProfile(profile.id);
        onSelect(profile);
    }

    async function handleDelete(id: string) {
        await clearProfileData(id);
        deleteProfile(id);
        setProfiles(getProfiles());
        setConfirmDelete(null);
    }

    const showCreateForm = creating || profiles.length === 0;
    const isEmpty = profiles.length === 0;

    return (
        <div className="profile-picker">
            <div className="profile-picker-card">
                <div className="profile-picker-brand">
                    <div className="profile-picker-logo">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
                        </svg>
                    </div>
                    <h1 className="profile-picker-title">Uploader</h1>
                    <p className="profile-picker-sub">
                        {isEmpty
                            ? 'Create a profile to keep your creatives separate'
                            : 'Choose your profile to continue'}
                    </p>
                </div>

                <div className="profile-picker-body">
                    {!isEmpty && (
                        <div className="profile-list">
                            {profiles.map(p => (
                                <div key={p.id} className="profile-row">
                                    <button
                                        type="button"
                                        className={`profile-select-btn${p.id === lastUsedId ? ' is-last-used' : ''}`}
                                        onClick={() => handleSelect(p)}
                                    >
                                        <span
                                            className="profile-avatar"
                                            style={{ background: p.color }}
                                        >
                                            {p.name.charAt(0).toUpperCase()}
                                        </span>
                                        <span className="profile-name-block">
                                            <span className="profile-name">{p.name}</span>
                                            {p.id === lastUsedId && (
                                                <span className="profile-last-badge">Last used</span>
                                            )}
                                        </span>
                                        <ChevronRight className="profile-chevron" size={16} />
                                    </button>
                                    {confirmDelete === p.id ? (
                                        <div className="profile-delete-confirm">
                                            <button
                                                type="button"
                                                className="btn-danger-sm"
                                                onClick={() => handleDelete(p.id)}
                                            >
                                                Delete
                                            </button>
                                            <button
                                                type="button"
                                                className="btn-ghost-sm"
                                                onClick={() => setConfirmDelete(null)}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            className="profile-trash-btn"
                                            title="Delete profile"
                                            onClick={() => setConfirmDelete(p.id)}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {showCreateForm ? (
                        <form onSubmit={handleCreate} className="profile-create-form">
                            {!isEmpty && <div className="profile-form-divider" />}
                            <label className="cyber-label profile-form-label">
                                {isEmpty ? 'Your name' : 'New profile'}
                            </label>
                            <div className="profile-input-row">
                                <input
                                    ref={inputRef}
                                    className="cyber-input profile-name-input"
                                    placeholder="e.g. Alex"
                                    value={name}
                                    maxLength={40}
                                    onChange={e => { setName(e.target.value); setError(''); }}
                                />
                            </div>
                            {error && <div className="profile-form-error">{error}</div>}
                            <div className="profile-form-actions">
                                <button
                                    type="submit"
                                    className="skeuo-primary profile-submit-btn"
                                    disabled={!name.trim()}
                                >
                                    {isEmpty ? 'Get started' : 'Create & enter'}
                                </button>
                                {!isEmpty && (
                                    <button
                                        type="button"
                                        className="btn-secondary profile-cancel-btn"
                                        onClick={() => { setCreating(false); setName(''); setError(''); }}
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>
                        </form>
                    ) : (
                        <button
                            type="button"
                            className="profile-add-btn"
                            onClick={() => setCreating(true)}
                        >
                            <Plus size={15} />
                            Add profile
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
