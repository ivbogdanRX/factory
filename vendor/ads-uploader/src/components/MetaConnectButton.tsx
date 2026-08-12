import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, Loader2, KeyRound, X } from 'lucide-react';
import {
    restoreSystemUserSession,
    connectWithAccessToken,
    logoutFromMeta,
    hasEnvSystemUserToken,
    type MetaUser,
} from '../lib/meta';

const MetaIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
    </svg>
);

function formatMetaError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/api access blocked/i.test(msg)) {
        return 'Meta rejected this token: “API access blocked.” This is a Business Manager / app restriction, not an app bug. In BM → System users → Generate token: pick the real App (not the system-user id), add ads_management + ads_read + pages_show_list, assign ad accounts + pages, then paste the new token into .env and restart npm run dev. Verify at developers.facebook.com/tools/debug/accesstoken/';
    }
    return msg;
}

interface MetaConnectButtonProps {
    onConnect?: (user: MetaUser) => void;
    onDisconnect?: () => void;
}

export function MetaConnectButton({ onConnect, onDisconnect }: MetaConnectButtonProps) {
    const [metaUser, setMetaUser] = useState<MetaUser | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isConnecting, setIsConnecting] = useState(false);
    const [showTokenForm, setShowTokenForm] = useState(false);
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [panelPos, setPanelPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLFormElement>(null);
    const envBacked = hasEnvSystemUserToken();

    const closePanel = useCallback(() => {
        setShowTokenForm(false);
    }, []);

    useEffect(() => {
        async function init() {
            try {
                const user = await restoreSystemUserSession();
                if (user) {
                    setMetaUser(user);
                    onConnect?.(user);
                } else if (envBacked) {
                    setError('Saved system-user token could not connect. Open to paste a fresh token.');
                }
            } catch (err) {
                console.error('Failed to restore Meta session:', err);
                setError(formatMetaError(err));
            }
            setIsLoading(false);
        }
        init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!showTokenForm) return;
        inputRef.current?.focus();

        const place = () => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (!rect) return;
            setPanelPos({
                top: rect.bottom + 10,
                right: Math.max(12, window.innerWidth - rect.right),
            });
        };
        place();

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closePanel();
        };
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node;
            if (panelRef.current?.contains(t)) return;
            if (buttonRef.current?.contains(t)) return;
            closePanel();
        };

        window.addEventListener('resize', place);
        window.addEventListener('scroll', closePanel, true);
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', closePanel, true);
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [showTokenForm, closePanel]);

    async function handleConnectToken(e?: React.FormEvent) {
        e?.preventDefault();
        setError('');
        setIsConnecting(true);
        try {
            const user = await connectWithAccessToken(token, 'system');
            setMetaUser(user);
            setToken('');
            setShowTokenForm(false);
            onConnect?.(user);
        } catch (err) {
            setError(formatMetaError(err));
        }
        setIsConnecting(false);
    }

    async function handleDisconnect() {
        await logoutFromMeta();
        if (envBacked) {
            try {
                const user = await restoreSystemUserSession();
                if (user) {
                    setMetaUser(user);
                    onConnect?.(user);
                    return;
                }
            } catch { /* fall through */ }
        }
        setMetaUser(null);
        onDisconnect?.();
    }

    if (isLoading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="skeleton-shimmer" style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                }} />
                <div className="skeleton-shimmer" style={{
                    width: 52, height: 12, borderRadius: 6,
                }} />
            </div>
        );
    }

    if (metaUser) {
        const displayName = metaUser.name.split(' ')[0];
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                    {metaUser.picture ? (
                        <img
                            src={metaUser.picture}
                            alt={metaUser.name}
                            style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.1)', display: 'block' }}
                        />
                    ) : (
                        <div
                            title="System user"
                            style={{
                                width: 28, height: 28, borderRadius: '50%',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'linear-gradient(180deg, #0668E1 0%, #004FBB 100%)',
                                border: '1px solid rgba(0,0,0,0.4)',
                                color: '#fff',
                            }}
                        >
                            <KeyRound size={13} />
                        </div>
                    )}
                    <div style={{
                        position: 'absolute', bottom: -1, right: -1,
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#30D158', border: '2px solid var(--bg-surface)',
                    }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{
                        fontSize: 12, fontWeight: 600, color: '#ccc',
                        maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {displayName}
                    </span>
                    <span className="cyber-label" style={{ fontSize: 8, color: '#555', letterSpacing: '0.08em' }}>
                        {envBacked ? 'Shared' : 'System'}
                    </span>
                </div>
                {!envBacked && (
                    <button
                        onClick={handleDisconnect}
                        title="Disconnect"
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                            color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer',
                            transition: 'color 0.15s, background 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#FF453A'; e.currentTarget.style.background = 'rgba(255,69,58,0.1)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'none'; }}
                    >
                        <LogOut style={{ width: 14, height: 14 }} />
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="meta-connect-wrap">
            <button
                ref={buttonRef}
                onClick={() => {
                    setShowTokenForm(v => !v);
                    if (!showTokenForm && !token && error) {
                        // keep error visible when reopening
                    } else if (!showTokenForm) {
                        setError(error); // preserve restore error
                    }
                }}
                className="skeuo-primary"
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: 8, padding: '11px 18px', fontSize: 12,
                    letterSpacing: '0.05em', borderRadius: 12, border: 'none',
                }}
            >
                <MetaIcon className="meta-icon-sm" />
                Connect System User
            </button>

            {error && !showTokenForm && (
                <div className="meta-connect-inline-error" title={error}>
                    Token failed — click to retry
                </div>
            )}

            {showTokenForm && createPortal(
                <form
                    ref={panelRef}
                    className="meta-token-panel"
                    style={{ top: panelPos.top, right: panelPos.right }}
                    onSubmit={handleConnectToken}
                >
                    <div className="meta-token-panel-header">
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#f0f0f5' }}>
                                System user token
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                                Business Settings → System users → Generate token
                            </div>
                        </div>
                        <button
                            type="button"
                            className="meta-token-close"
                            onClick={closePanel}
                        >
                            <X size={14} />
                        </button>
                    </div>

                    <textarea
                        ref={inputRef}
                        className="cyber-input meta-token-input"
                        placeholder="Paste access token…"
                        value={token}
                        rows={3}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={e => { setToken(e.target.value); setError(''); }}
                    />

                    {error && <div className="meta-token-error">{error}</div>}

                    <div className="meta-token-hint">
                        Include scopes: <code>ads_management</code>, <code>ads_read</code>, <code>pages_show_list</code>.
                        Assign your ad accounts + pages to the system user first.
                    </div>

                    <button
                        type="submit"
                        className="skeuo-primary meta-token-submit"
                        disabled={!token.trim() || isConnecting}
                    >
                        {isConnecting ? (
                            <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
                        ) : (
                            <KeyRound size={14} />
                        )}
                        {isConnecting ? 'Validating…' : 'Connect'}
                    </button>
                </form>,
                document.body,
            )}
        </div>
    );
}
