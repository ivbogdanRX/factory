import { useState, useRef } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { PortalDropdown } from './PortalDropdown';
import { SkeletonDropdownField } from './Skeletons';
import type { Page } from '../lib/meta';

interface PageSelectorProps {
    pages: Page[];
    selectedPage: Page | null;
    onChange: (page: Page | null) => void;
    isLoading?: boolean;
}

export function PageSelector({ pages, selectedPage, onChange, isLoading }: PageSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    if (isLoading) {
        return (
            <div className="cyber-input" style={{ width: '100%', borderRadius: 10 }}>
                <SkeletonDropdownField />
            </div>
        );
    }

    return (
        <div ref={containerRef} style={{ position: 'relative' }}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="cyber-input"
                style={{
                    width: '100%', display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', cursor: 'pointer',
                    padding: '10px 14px', minHeight: 44,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                    {selectedPage ? (
                        <>
                            {selectedPage.picture?.data?.url ? (
                                <img src={selectedPage.picture.data.url} alt={selectedPage.name}
                                    style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }} />
                            ) : (
                                <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />
                            )}
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedPage.name}</span>
                        </>
                    ) : (
                        <span style={{ fontSize: 13, color: '#555' }}>Select a Facebook Page...</span>
                    )}
                </div>
                <ChevronDown style={{ width: 14, height: 14, color: 'var(--text-muted)', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
            </button>

            <PortalDropdown isOpen={isOpen} onClose={() => setIsOpen(false)} anchorRef={containerRef}>
                <div
                    className="skeuo-raised animate-fade-in"
                    style={{
                        borderRadius: 14, padding: 6,
                        display: 'flex', flexDirection: 'column', gap: 2,
                        overflow: 'hidden', /* keeps scrollbar inside radius */
                    }}
                >
                    {/* inner scroll container */}
                    <div
                        className="custom-scrollbar scroll-fade"
                        style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}
                    >
                        {pages.map((page) => {
                            const isSelected = selectedPage?.id === page.id;
                            return (
                                <button
                                    key={page.id}
                                    type="button"
                                    onClick={() => { onChange(page); setIsOpen(false); }}
                                    style={{
                                        width: '100%', display: 'flex', alignItems: 'center',
                                        justifyContent: 'space-between', padding: '10px 12px',
                                        borderRadius: 10, fontSize: 13, cursor: 'pointer',
                                        background: isSelected ? 'rgba(6,104,225,0.12)' : 'transparent',
                                        color: isSelected ? '#E5F0FF' : 'var(--text-muted)',
                                        border: 'none', transition: 'background 0.12s, color 0.12s',
                                        textAlign: 'left', flexShrink: 0,
                                    }}
                                    onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'var(--text)'; } }}
                                    onMouseLeave={e => { if (!isSelected) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                                        {page.picture?.data?.url ? (
                                            <img src={page.picture.data.url} alt={page.name}
                                                style={{ width: 22, height: 22, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }} />
                                        ) : (
                                            <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />
                                        )}
                                        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.name}</span>
                                    </div>
                                    {isSelected && <Check style={{ width: 14, height: 14, color: '#0668E1', flexShrink: 0 }} />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </PortalDropdown>
        </div>
    );
}
