import { Plus, Minus, Copy, ChevronDown, Check } from 'lucide-react';
import { useState, useRef } from 'react';
import { PortalDropdown } from './PortalDropdown';
import type { CopiedAdSettings } from '../lib/meta';

const CTA_OPTIONS = [
    { value: 'LEARN_MORE', label: 'Learn More' },
    { value: 'SHOP_NOW', label: 'Shop Now' },
    { value: 'SIGN_UP', label: 'Sign Up' },
    { value: 'SUBSCRIBE', label: 'Subscribe' },
    { value: 'GET_OFFER', label: 'Get Offer' },
    { value: 'GET_QUOTE', label: 'Get Quote' },
    { value: 'DOWNLOAD', label: 'Download' },
    { value: 'BOOK_NOW', label: 'Book Now' },
    { value: 'CONTACT_US', label: 'Contact Us' },
    { value: 'APPLY_NOW', label: 'Apply Now' },
    { value: 'ORDER_NOW', label: 'Order Now' },
    { value: 'WATCH_MORE', label: 'Watch More' },
    { value: 'SEE_MORE', label: 'See More' },
    { value: 'NO_BUTTON', label: 'No Button' },
];

function CtaDropdown({ value, onChange }: { value: string, onChange: (v: string) => void }) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLButtonElement>(null);

    const selectedOption = CTA_OPTIONS.find(o => o.value === value) || CTA_OPTIONS[0];

    return (
        <div style={{ position: 'relative' }}>
            <button
                ref={containerRef}
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="cyber-input"
                style={{
                    width: '100%', display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', cursor: 'pointer',
                    padding: '10px 14px', minHeight: 44,
                }}
            >
                <span style={{ fontSize: 13, color: 'var(--text)' }}>{selectedOption.label}</span>
                <ChevronDown style={{ width: 14, height: 14, color: 'var(--text-muted)', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
            </button>
            <PortalDropdown isOpen={isOpen} onClose={() => setIsOpen(false)} anchorRef={containerRef}>
                <div
                    className="skeuo-raised animate-fade-in"
                    style={{
                        borderRadius: 14, padding: 6,
                        display: 'flex', flexDirection: 'column',
                        overflow: 'hidden',
                    }}
                >
                    <div className="custom-scrollbar scroll-fade" style={{ overflowY: 'auto', maxHeight: 220, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {CTA_OPTIONS.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            onClick={() => { onChange(o.value); setIsOpen(false); }}
                            style={{
                                width: '100%', textAlign: 'left', padding: '10px 12px',
                                background: value === o.value ? 'rgba(6,104,225,0.12)' : 'transparent',
                                color: value === o.value ? '#E5F0FF' : 'var(--text-muted)',
                                border: 'none', borderRadius: 10, cursor: 'pointer',
                                fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                transition: 'all 0.1s', flexShrink: 0,
                            }}
                            onMouseEnter={e => {
                                if (value !== o.value) {
                                    e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                                    e.currentTarget.style.color = 'var(--text)';
                                }
                            }}
                            onMouseLeave={e => {
                                if (value !== o.value) {
                                    e.currentTarget.style.background = 'transparent';
                                    e.currentTarget.style.color = 'var(--text-muted)';
                                }
                            }}
                        >
                            {o.label}
                            {value === o.value && <Check style={{ width: 14, height: 14, color: '#0668E1' }} />}
                        </button>
                    ))}
                    </div>
                </div>
            </PortalDropdown>
        </div>
    );
}

interface AdSettingsFormProps {
    settings: CopiedAdSettings;
    onChange: (settings: CopiedAdSettings) => void;
    compact?: boolean;
}

export function AdSettingsForm({ settings, onChange, compact = false }: AdSettingsFormProps) {
    const updateField = <K extends keyof CopiedAdSettings>(field: K, value: CopiedAdSettings[K]) => {
        onChange({ ...settings, [field]: value });
    };

    const updateArrayField = (field: 'headlines' | 'primaryTexts', index: number, value: string) => {
        const arr = [...settings[field]];
        arr[index] = value;
        onChange({ ...settings, [field]: arr });
    };

    const addArrayField = (field: 'headlines' | 'primaryTexts') => {
        if (settings[field].length < 5) {
            onChange({ ...settings, [field]: [...settings[field], ''] });
        }
    };

    const removeArrayField = (field: 'headlines' | 'primaryTexts', index: number) => {
        if (settings[field].length > 1) {
            const arr = settings[field].filter((_, i) => i !== index);
            onChange({ ...settings, [field]: arr });
        }
    };

    const gap = compact ? 14 : 20;

    const addBtn = (field: 'headlines' | 'primaryTexts', label: string) => (
        <button
            onClick={() => addArrayField(field)}
            style={{
                marginTop: 8, display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const,
                background: 'rgba(6,104,225,0.06)',
                border: '1px solid rgba(6,104,225,0.15)',
                color: '#0668E1', 
                boxShadow: 'inset 1px 1px 3px rgba(6,104,225,0.05)',
                borderRadius: 8,
                padding: '5px 10px', cursor: 'pointer', transition: 'all 0.15s',
            }}
            onMouseOver={e => e.currentTarget.style.background = 'rgba(6,104,225,0.1)'}
            onMouseOut={e => e.currentTarget.style.background = 'rgba(6,104,225,0.06)'}
        >
            <Plus style={{ width: 11, height: 11, filter: 'drop-shadow(0 0 5px rgba(6,104,225,0.5))' }} />
            {label}
        </button>
    );

    const removeBtn = (field: 'headlines' | 'primaryTexts', index: number) => (
        <button
            onClick={() => removeArrayField(field, index)}
            style={{
                width: 36, height: 36, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: 10, color: '#666', cursor: 'pointer',
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { const b = e.currentTarget; b.style.color = '#f87171'; b.style.background = 'rgba(239,68,68,0.1)'; b.style.borderColor = 'rgba(239,68,68,0.2)'; }}
            onMouseLeave={e => { const b = e.currentTarget; b.style.color = '#666'; b.style.background = 'rgba(255,255,255,0.02)'; b.style.borderColor = 'rgba(255,255,255,0.05)'; }}
        >
            <Minus style={{ width: 13, height: 13 }} />
        </button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
            {settings.sourceAdName && (
                <div 
                    style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '10px 14px', fontSize: 11,
                        alignSelf: 'flex-start',
                        background: '#141414',
                        border: '1px solid rgba(255,255,255,0.1)',
                        boxShadow: 'inset 1px 1px 3px rgba(0,0,0,0.5)',
                        borderRadius: 6
                    }}
                >
                    <Copy style={{ width: 12, height: 12, color: 'var(--text-muted)' }} />
                    <span style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>Source</span>
                    <span style={{ 
                        maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', 
                        color: '#30D158', fontWeight: 500, fontFamily: 'monospace'
                    }}>
                        {settings.sourceAdName}
                    </span>
                </div>
            )}

            {/* Primary Texts */}
            <div>
                <label className="cyber-label" style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>
                    Primary Text ({settings.primaryTexts.length}/5)
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {settings.primaryTexts.map((text, index) => (
                        <div key={index} style={{ display: 'flex', gap: 6 }}>
                            <textarea
                                value={text}
                                onChange={(e) => updateArrayField('primaryTexts', index, e.target.value)}
                                placeholder="Enter primary text..."
                                rows={compact ? 3 : 4}
                                className="cyber-input"
                                style={{ flex: 1, resize: 'vertical', minHeight: compact ? 80 : 110 }}
                            />
                            {settings.primaryTexts.length > 1 && removeBtn('primaryTexts', index)}
                        </div>
                    ))}
                </div>
                {settings.primaryTexts.length < 5 && addBtn('primaryTexts', 'Add Primary Text')}
            </div>

            {/* Headlines */}
            <div>
                <label className="cyber-label" style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>
                    Headline ({settings.headlines.length}/5)
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {settings.headlines.map((headline, index) => (
                        <div key={index} style={{ display: 'flex', gap: 6 }}>
                            <input
                                type="text"
                                value={headline}
                                onChange={(e) => updateArrayField('headlines', index, e.target.value)}
                                placeholder="Enter headline..."
                                className="cyber-input"
                                style={{ flex: 1 }}
                            />
                            {settings.headlines.length > 1 && removeBtn('headlines', index)}
                        </div>
                    ))}
                </div>
                {settings.headlines.length < 5 && addBtn('headlines', 'Add Headline')}
            </div>

            {/* Description */}
            <div>
                <label className="cyber-label" style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>Link Description</label>
                <input
                    type="text"
                    value={settings.description}
                    onChange={(e) => updateField('description', e.target.value)}
                    placeholder="Enter description..."
                    className="cyber-input"
                    style={{ width: '100%' }}
                />
            </div>

            {/* CTA + Display URL */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                    <label className="cyber-label" style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>Call to Action</label>
                    <CtaDropdown
                        value={settings.callToAction}
                        onChange={(val) => updateField('callToAction', val)}
                    />
                </div>
                <div>
                    <label className="cyber-label" style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>Display URL (optional)</label>
                    <input
                        type="text"
                        value={settings.displayUrl}
                        onChange={(e) => updateField('displayUrl', e.target.value)}
                        placeholder="example.com"
                        className="cyber-input"
                        style={{ width: '100%' }}
                    />
                </div>
            </div>

            {/* Website URL */}
            <div>
                <label className="cyber-label" style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>Website URL</label>
                <input
                    type="text"
                    value={settings.websiteUrl}
                    onChange={(e) => updateField('websiteUrl', e.target.value)}
                    placeholder="https://track.domain.com/click?campaign=abc&sub5={audience}"
                    className="cyber-input"
                    style={{ width: '100%' }}
                />
                <div style={{ marginTop: 6, fontSize: 10, color: '#555', lineHeight: 1.5 }}>
                    Supports tokens: <span style={{ color: '#0668E1', fontFamily: 'var(--font-mono)' }}>{'{audience}'}</span> <span style={{ color: '#0668E1', fontFamily: 'var(--font-mono)' }}>{'{hook}'}</span> <span style={{ color: '#0668E1', fontFamily: 'var(--font-mono)' }}>{'{style}'}</span> — resolved per ad set group
                </div>

            </div>
        </div>
    );
}

export function getDefaultAdSettings(): CopiedAdSettings {
    return {
        headlines: [''],
        primaryTexts: [''],
        description: '',
        callToAction: 'LEARN_MORE',
        websiteUrl: '',
        displayUrl: '',
        pageId: '',
        sourceAdId: '',
        sourceAdName: '',
    };
}
