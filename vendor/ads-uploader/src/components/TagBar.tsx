import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Pencil, X, Check, Plus, RotateCcw } from 'lucide-react';
import { getTaxonomy, addToTaxonomy, removeFromTaxonomy, updateInTaxonomy, addCustomField, removeCustomField, addCustomFieldValue, removeCustomFieldValue, updateCustomFieldValue, MAX_CUSTOM_FIELDS, type TaxonomyField } from '../lib/taxonomy';
import { PortalDropdown } from './PortalDropdown';

interface TagBarProps {
    audience: string;
    hookAngle: string;
    style: string;
    onAudienceChange: (v: string) => void;
    onHookAngleChange: (v: string) => void;
    onStyleChange: (v: string) => void;
    customTags: Record<string, string>;
    onCustomTagChange: (key: string, value: string) => void;
    onApply: () => void;
    onRemoveCustomField: (key: string) => void;
    onCustomFieldsChange: () => void;
    canApply: boolean;
    selectedCount: number;
    totalCount: number;
}

function ComboInput({
    label,
    value,
    onChange,
    field,
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    field: TaxonomyField;
    placeholder: string;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const anchorRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const editInputRef = useRef<HTMLInputElement>(null);

    // Editing State
    const [editingOption, setEditingOption] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState<string>('');
    const [, setTick] = useState(0);

    // Reload taxonomy state dynamically so updates reflect immediately
    const taxonomy = getTaxonomy();
    const options = taxonomy[field];

    const filtered = search
        ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
        : options;

    const handleSelect = (val: string) => {
        onChange(val);
        setIsOpen(false);
        setSearch('');
        setEditingOption(null);
    };

    const handleCustom = () => {
        const val = search.trim().replace(/\s+/g, '-');
        if (val) {
            addToTaxonomy(field, val);
            onChange(val);
            setSearch('');
            setIsOpen(false);
        }
    };

    return (
        <div style={{ width: '100%', minWidth: 80 }}>
            <div style={{ fontSize: 9, color: '#555', marginBottom: 3, fontWeight: 600, letterSpacing: '0.05em' }}>
                {label}
            </div>
            <button
                ref={anchorRef}
                onClick={() => { setIsOpen(o => !o); setSearch(''); }}
                style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '5px 8px', height: 28,
                    background: value === '__CLEAR__' ? 'rgba(255,59,48,0.08)' : value ? 'rgba(6,104,225,0.08)' : 'rgba(255,255,255,0.03)',
                    border: value === '__CLEAR__' ? '1px solid rgba(255,59,48,0.25)' : value ? '1px solid rgba(6,104,225,0.25)' : '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6, cursor: 'pointer', transition: 'all 0.15s',
                    color: value === '__CLEAR__' ? '#FF6961' : value ? '#E5F0FF' : '#666',
                    fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-mono)',
                }}
            >
                <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontStyle: value === '__CLEAR__' ? 'italic' : 'normal',
                }}>
                    {value === '__CLEAR__' ? 'Clear ✕' : value || placeholder}
                </span>
                <ChevronDown style={{
                    width: 10, height: 10, flexShrink: 0, opacity: 0.5,
                    transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s',
                }} />
            </button>
            <PortalDropdown isOpen={isOpen} onClose={() => { setIsOpen(false); setSearch(''); }} anchorRef={anchorRef}>
                <div
                    className="skeuo-raised animate-fade-in"
                    style={{ borderRadius: 10, padding: 4, minWidth: 160 }}
                >
                    {/* Search input */}
                    <div style={{ padding: '4px 4px 2px' }}>
                        <input
                            ref={inputRef}
                            autoFocus
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value.replace(/\s+/g, '-'))}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    if (filtered.length > 0) handleSelect(filtered[0]);
                                    else handleCustom();
                                }
                                if (e.key === 'Escape') setIsOpen(false);
                            }}
                            placeholder="Search or add..."
                            style={{
                                width: '100%', padding: '5px 8px',
                                background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)',
                                borderRadius: 6, color: 'var(--text)', fontSize: 11,
                                outline: 'none', fontFamily: 'var(--font-mono)',
                            }}
                        />
                    </div>
                    {/* Options */}
                    <div className="custom-scrollbar scroll-fade" style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1, padding: '2px 0' }}>
                        {/* Clear option */}
                        {value && value !== '__CLEAR__' && (
                            <button
                                onClick={() => handleSelect('__CLEAR__')}
                                style={{
                                    width: '100%', textAlign: 'left', padding: '5px 8px',
                                    background: 'transparent', color: '#666',
                                    border: 'none', borderRadius: 6, cursor: 'pointer',
                                    fontSize: 10, fontStyle: 'italic', transition: 'background 0.1s',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                                Clear
                            </button>
                        )}
                        {filtered.map(o => (
                            <div
                                key={o}
                                style={{
                                    display: 'flex', alignItems: 'center', width: '100%',
                                    background: value === o ? 'rgba(6,104,225,0.12)' : 'transparent',
                                    borderRadius: 6, transition: 'all 0.1s',
                                }}
                                className="group"
                                onMouseEnter={e => {
                                    if (value !== o) {
                                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                                    }
                                }}
                                onMouseLeave={e => {
                                    if (value !== o) {
                                        e.currentTarget.style.background = 'transparent';
                                    }
                                }}
                            >
                                {editingOption === o ? (
                                    <div style={{ display: 'flex', alignItems: 'center', width: '100%', padding: '5px 8px', gap: 6 }}>
                                        <input
                                            ref={editInputRef}
                                            autoFocus
                                            type="text"
                                            value={editingValue}
                                            onChange={e => setEditingValue(e.target.value.replace(/\s+/g, '-'))}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    updateInTaxonomy(field, o, editingValue);
                                                    if (value === o) onChange(editingValue.trim().replace(/\s+/g, '-'));
                                                    setEditingOption(null);
                                                    setTick(t => t + 1);
                                                }
                                                if (e.key === 'Escape') setEditingOption(null);
                                            }}
                                            style={{
                                                flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(6,104,225,0.5)', outline: 'none', borderRadius: 4,
                                                color: '#fff', fontSize: 11, fontFamily: 'var(--font-mono)', padding: '0 4px'
                                            }}
                                        />
                                        <button 
                                            onClick={() => {
                                                updateInTaxonomy(field, o, editingValue);
                                                if (value === o) onChange(editingValue.trim().replace(/\s+/g, '-'));
                                                setEditingOption(null);
                                                setTick(t => t + 1);
                                            }}
                                            style={{ background: 'transparent', border: 'none', color: '#0668E1', cursor: 'pointer', display: 'flex' }}
                                        >
                                            <Check style={{ width: 12, height: 12 }} />
                                        </button>
                                        <button 
                                            onClick={() => setEditingOption(null)}
                                            style={{ background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', display: 'flex' }}
                                        >
                                            <X style={{ width: 12, height: 12 }} />
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <button
                                            onClick={() => handleSelect(o)}
                                            style={{
                                                flex: 1, textAlign: 'left', padding: '5px 8px',
                                                background: 'transparent',
                                                color: value === o ? '#E5F0FF' : 'var(--text-muted)',
                                                border: 'none', cursor: 'pointer',
                                                fontSize: 11, fontFamily: 'var(--font-mono)',
                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                            }}
                                            onMouseEnter={e => {
                                                if (value !== o) {
                                                    e.currentTarget.style.color = 'var(--text)';
                                                }
                                            }}
                                            onMouseLeave={e => {
                                                if (value !== o) {
                                                    e.currentTarget.style.color = 'var(--text-muted)';
                                                }
                                            }}
                                        >
                                            {o}
                                        </button>
                                        <div style={{ display: 'flex', alignItems: 'center', opacity: 0, paddingRight: 6 }} className="group-hover-visible">
                                            <button
                                                title="Edit"
                                                onClick={(e) => { e.stopPropagation(); setEditingOption(o); setEditingValue(o); }}
                                                style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', padding: 4, display: 'flex' }}
                                                onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                                                onMouseLeave={e => e.currentTarget.style.color = '#888'}
                                            >
                                                <Pencil style={{ width: 10, height: 10 }} />
                                            </button>
                                            <button
                                                title="Delete"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeFromTaxonomy(field, o);
                                                    if (value === o) onChange('');
                                                    setTick(t => t + 1); 
                                                }}
                                                style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', padding: 4, display: 'flex' }}
                                                onMouseEnter={e => e.currentTarget.style.color = '#ff4444'}
                                                onMouseLeave={e => e.currentTarget.style.color = '#888'}
                                            >
                                                <X style={{ width: 11, height: 11 }} />
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                        {/* Add custom */}
                        {search.trim() && !options.some(o => o.toLowerCase() === search.trim().toLowerCase()) && (
                            <button
                                onClick={handleCustom}
                                style={{
                                    width: '100%', textAlign: 'left', padding: '5px 8px',
                                    background: 'transparent', color: '#0668E1',
                                    border: 'none', borderRadius: 6, cursor: 'pointer',
                                    fontSize: 11, fontFamily: 'var(--font-mono)',
                                    transition: 'background 0.1s', flexShrink: 0,
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,104,225,0.08)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                                + Add "{search.trim().replace(/\s+/g, '-')}"
                            </button>
                        )}
                    </div>
                </div>
            </PortalDropdown>
        </div>
    );
}

function CustomComboInput({
    label,
    value,
    onChange,
    fieldKey,
    placeholder,
    onRemoveField,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    fieldKey: string;
    placeholder: string;
    onRemoveField: () => void;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const anchorRef = useRef<HTMLButtonElement>(null);
    const editInputRef = useRef<HTMLInputElement>(null);
    const [editingOption, setEditingOption] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState<string>('');
    const [, setTick] = useState(0);

    const taxonomy = getTaxonomy();
    const field = taxonomy.customFields.find(cf => cf.key === fieldKey);
    const options = field?.values || [];
    const filtered = search
        ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
        : options;

    const handleSelect = (val: string) => { onChange(val); setIsOpen(false); setSearch(''); setEditingOption(null); };
    const handleCustom = () => {
        const val = search.trim().replace(/\s+/g, '-');
        if (val) { addCustomFieldValue(fieldKey, val); onChange(val); setSearch(''); setIsOpen(false); }
    };

    return (
        <div style={{ width: '100%', minWidth: 80 }}>
            <div style={{ fontSize: 9, color: '#555', marginBottom: 3, fontWeight: 600, letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4 }}>
                {label}
                <button
                    onClick={(e) => { e.stopPropagation(); onRemoveField(); }}
                    title={`Remove "${label}" field`}
                    style={{ background: 'transparent', border: 'none', color: '#444', cursor: 'pointer', padding: 0, display: 'flex', lineHeight: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = '#ff4444'}
                    onMouseLeave={e => e.currentTarget.style.color = '#444'}
                >
                    <X style={{ width: 8, height: 8 }} />
                </button>
            </div>
            <button
                ref={anchorRef}
                onClick={() => { setIsOpen(o => !o); setSearch(''); }}
                style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '5px 8px', height: 28,
                    background: value === '__CLEAR__' ? 'rgba(255,59,48,0.08)' : value ? 'rgba(6,104,225,0.08)' : 'rgba(255,255,255,0.03)',
                    border: value === '__CLEAR__' ? '1px solid rgba(255,59,48,0.25)' : value ? '1px solid rgba(6,104,225,0.25)' : '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6, cursor: 'pointer', transition: 'all 0.15s',
                    color: value === '__CLEAR__' ? '#FF6961' : value ? '#E5F0FF' : '#666',
                    fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-mono)',
                }}
            >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: value === '__CLEAR__' ? 'italic' : 'normal' }}>
                    {value === '__CLEAR__' ? 'Clear ✕' : value || placeholder}
                </span>
                <ChevronDown style={{ width: 10, height: 10, flexShrink: 0, opacity: 0.5, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
            </button>
            <PortalDropdown isOpen={isOpen} onClose={() => { setIsOpen(false); setSearch(''); }} anchorRef={anchorRef}>
                <div className="skeuo-raised animate-fade-in" style={{ borderRadius: 10, padding: 4, minWidth: 160 }}>
                    <div style={{ padding: '4px 4px 2px' }}>
                        <input
                            autoFocus type="text" value={search}
                            onChange={e => setSearch(e.target.value.replace(/\s+/g, '-'))}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { if (filtered.length > 0) handleSelect(filtered[0]); else handleCustom(); }
                                if (e.key === 'Escape') setIsOpen(false);
                            }}
                            placeholder="Search or add..."
                            style={{ width: '100%', padding: '5px 8px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: 'var(--text)', fontSize: 11, outline: 'none', fontFamily: 'var(--font-mono)' }}
                        />
                    </div>
                    <div className="custom-scrollbar scroll-fade" style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1, padding: '2px 0' }}>
                        {value && value !== '__CLEAR__' && (
                            <button onClick={() => handleSelect('__CLEAR__')} style={{ width: '100%', textAlign: 'left', padding: '5px 8px', background: 'transparent', color: '#666', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 10, fontStyle: 'italic', transition: 'background 0.1s' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >Clear</button>
                        )}
                        {filtered.map(o => (
                            <div key={o} style={{ display: 'flex', alignItems: 'center', width: '100%', background: value === o ? 'rgba(6,104,225,0.12)' : 'transparent', borderRadius: 6, transition: 'all 0.1s' }} className="group"
                                onMouseEnter={e => { if (value !== o) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                                onMouseLeave={e => { if (value !== o) e.currentTarget.style.background = 'transparent'; }}
                            >
                                {editingOption === o ? (
                                    <div style={{ display: 'flex', alignItems: 'center', width: '100%', padding: '5px 8px', gap: 6 }}>
                                        <input ref={editInputRef} autoFocus type="text" value={editingValue}
                                            onChange={e => setEditingValue(e.target.value.replace(/\s+/g, '-'))}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') { updateCustomFieldValue(fieldKey, o, editingValue); if (value === o) onChange(editingValue.trim().replace(/\s+/g, '-')); setEditingOption(null); setTick(t => t + 1); }
                                                if (e.key === 'Escape') setEditingOption(null);
                                            }}
                                            style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(6,104,225,0.5)', outline: 'none', borderRadius: 4, color: '#fff', fontSize: 11, fontFamily: 'var(--font-mono)', padding: '0 4px' }}
                                        />
                                        <button onClick={() => { updateCustomFieldValue(fieldKey, o, editingValue); if (value === o) onChange(editingValue.trim().replace(/\s+/g, '-')); setEditingOption(null); setTick(t => t + 1); }}
                                            style={{ background: 'transparent', border: 'none', color: '#0668E1', cursor: 'pointer', display: 'flex' }}><Check style={{ width: 12, height: 12 }} /></button>
                                        <button onClick={() => setEditingOption(null)} style={{ background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', display: 'flex' }}><X style={{ width: 12, height: 12 }} /></button>
                                    </div>
                                ) : (
                                    <>
                                        <button onClick={() => handleSelect(o)} style={{ flex: 1, textAlign: 'left', padding: '5px 8px', background: 'transparent', color: value === o ? '#E5F0FF' : 'var(--text-muted)', border: 'none', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                            onMouseEnter={e => { if (value !== o) e.currentTarget.style.color = 'var(--text)'; }}
                                            onMouseLeave={e => { if (value !== o) e.currentTarget.style.color = 'var(--text-muted)'; }}
                                        >{o}</button>
                                        <div style={{ display: 'flex', alignItems: 'center', opacity: 0, paddingRight: 6 }} className="group-hover-visible">
                                            <button title="Edit" onClick={(e) => { e.stopPropagation(); setEditingOption(o); setEditingValue(o); }}
                                                style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', padding: 4, display: 'flex' }}
                                                onMouseEnter={e => e.currentTarget.style.color = '#fff'} onMouseLeave={e => e.currentTarget.style.color = '#888'}
                                            ><Pencil style={{ width: 10, height: 10 }} /></button>
                                            <button title="Delete" onClick={(e) => { e.stopPropagation(); removeCustomFieldValue(fieldKey, o); if (value === o) onChange(''); setTick(t => t + 1); }}
                                                style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', padding: 4, display: 'flex' }}
                                                onMouseEnter={e => e.currentTarget.style.color = '#ff4444'} onMouseLeave={e => e.currentTarget.style.color = '#888'}
                                            ><X style={{ width: 11, height: 11 }} /></button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                        {search.trim() && !options.some(o => o.toLowerCase() === search.trim().toLowerCase()) && (
                            <button onClick={handleCustom} style={{ width: '100%', textAlign: 'left', padding: '5px 8px', background: 'transparent', color: '#0668E1', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)', transition: 'background 0.1s', flexShrink: 0 }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,104,225,0.08)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >+ Add "{search.trim().replace(/\s+/g, '-')}"</button>
                        )}
                    </div>
                </div>
            </PortalDropdown>
        </div>
    );
}

export function TagBar({
    audience, hookAngle, style,
    onAudienceChange, onHookAngleChange, onStyleChange,
    customTags, onCustomTagChange,
    onApply, onRemoveCustomField, onCustomFieldsChange, canApply: _canApply, selectedCount, totalCount,
}: TagBarProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [addingField, setAddingField] = useState(false);
    const [newFieldName, setNewFieldName] = useState('');
    const addInputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const taxonomy = getTaxonomy();

    const handleAddField = () => {
        const name = newFieldName.trim();
        if (name) {
            addCustomField(name);
            setNewFieldName('');
            setAddingField(false);
            onCustomFieldsChange();
        }
    };

    const handleRemoveField = (key: string) => {
        removeCustomField(key);
        onCustomTagChange(key, '');
        onRemoveCustomField(key);
        onCustomFieldsChange();
    };

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                // Check if they clicked inside a PortalDropdown (which attaches to body)
                // If it's a PortalDropdown, don't close the TagBar popover
                const isPortalClick = (e.target as HTMLElement).closest('[style*="z-index: 99999"]');
                if (!isPortalClick) {
                    setIsOpen(false);
                    setAddingField(false);
                }
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const appliedTagCount = [audience, style, hookAngle, ...Object.values(customTags)].filter(v => !!v).length;
    const customTagCount = Object.values(customTags).filter(v => !!v).length;
    const hasCustomTags = customTagCount > 0;

    return (
        <div style={{
            display: 'flex', alignItems: 'flex-end', gap: 12,
            padding: '8px 0', width: '100%',
            animation: 'slide-down-fade 0.25s ease both',
        }}>
            {/* Default Tags Inline */}
            <div style={{
                display: 'flex', alignItems: 'flex-end', gap: 8, flex: 1, minWidth: 0,
            }}>
                <ComboInput label="Audience" value={audience} onChange={onAudienceChange} field="audiences" placeholder="Select..." />
                <ComboInput label="Style" value={style} onChange={onStyleChange} field="styles" placeholder="Select..." />
                <ComboInput label="Hook / Angle" value={hookAngle} onChange={onHookAngleChange} field="hooks" placeholder="Select..." />
            </div>

            {/* Pinned actions on the right */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
                <div ref={containerRef} style={{ position: 'relative' }}>
                    <button
                        onClick={() => setIsOpen(!isOpen)}
                        title={hasCustomTags ? `Additional Tags (${customTagCount} set)` : 'Additional Tags'}
                        style={{
                            position: 'relative', flexShrink: 0, width: 28, height: 28, borderRadius: 6,
                            background: isOpen || hasCustomTags ? 'rgba(6,104,225,0.1)' : 'rgba(255,255,255,0.03)',
                            border: isOpen || hasCustomTags ? '1px solid rgba(6,104,225,0.3)' : '1px solid rgba(255,255,255,0.08)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: isOpen || hasCustomTags ? '#0668E1' : '#555',
                            transition: 'all 0.15s', marginBottom: 0,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,104,225,0.08)'; e.currentTarget.style.borderColor = 'rgba(6,104,225,0.25)'; e.currentTarget.style.color = '#0668E1'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = isOpen || hasCustomTags ? 'rgba(6,104,225,0.1)' : 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = isOpen || hasCustomTags ? 'rgba(6,104,225,0.3)' : 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = isOpen || hasCustomTags ? '#0668E1' : '#555'; }}
                    >
                        <Plus style={{ width: 14, height: 14 }} />
                        {hasCustomTags && (
                            <span style={{
                                position: 'absolute', top: -6, right: -6,
                                minWidth: 15, height: 15, padding: '0 4px',
                                background: '#0668E1', color: '#fff',
                                border: '1.5px solid #0F0F0F', borderRadius: 8,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 9, fontWeight: 700, lineHeight: 1,
                                fontFamily: 'var(--font-mono)', pointerEvents: 'none',
                            }}>
                                {customTagCount}
                            </span>
                        )}
                    </button>

                    {isOpen && (
                        <div style={{
                            position: 'absolute', top: '100%', right: 0, marginTop: 8,
                            width: 240, background: 'rgba(15, 15, 15, 0.95)',
                            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
                            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                            padding: 12, zIndex: 50,
                            animation: 'slide-down-fade 0.2s ease both',
                        }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 12, letterSpacing: '0.05em' }}>ADDITIONAL TAGS</div>
                            
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                {/* Dynamic custom fields */}
                                {taxonomy.customFields.map(cf => (
                                    <CustomComboInput
                                        key={cf.key}
                                        label={cf.key}
                                        value={customTags[cf.key] || ''}
                                        onChange={(v) => onCustomTagChange(cf.key, v)}
                                        fieldKey={cf.key}
                                        placeholder="Select..."
                                        onRemoveField={() => handleRemoveField(cf.key)}
                                    />
                                ))}

                                {taxonomy.customFields.length === 0 && !addingField && (
                                    <div style={{ fontSize: 10, color: '#555', fontStyle: 'italic', textAlign: 'center', padding: '10px 0' }}>
                                        No custom tags added yet.
                                    </div>
                                )}
                                
                                {/* Add custom field button */}
                                {taxonomy.customFields.length < MAX_CUSTOM_FIELDS && (
                                    addingField ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                            <div style={{ fontSize: 9, color: '#555', fontWeight: 600, letterSpacing: '0.05em' }}>New Field</div>
                                            <div style={{ display: 'flex', gap: 4 }}>
                                                <input
                                                    ref={addInputRef}
                                                    autoFocus
                                                    type="text"
                                                    value={newFieldName}
                                                    onChange={e => setNewFieldName(e.target.value)}
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') handleAddField();
                                                        if (e.key === 'Escape') { setAddingField(false); setNewFieldName(''); }
                                                    }}
                                                    placeholder="Field name..."
                                                    style={{
                                                        flex: 1, minWidth: 0, padding: '4px 6px', height: 28,
                                                        background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(6,104,225,0.3)',
                                                        borderRadius: 6, color: 'var(--text)', fontSize: 10,
                                                        outline: 'none', fontFamily: 'var(--font-mono)',
                                                    }}
                                                />
                                                <button onClick={handleAddField} style={{ background: '#0668E1', border: 'none', borderRadius: 6, width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                                    <Check style={{ width: 12, height: 12, color: '#fff' }} />
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', alignItems: 'flex-end', paddingTop: 4 }}>
                                            <button
                                                onClick={() => setAddingField(true)}
                                                title="Add custom tag field"
                                                style={{
                                                    width: '100%', height: 28, borderRadius: 6,
                                                    background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.15)',
                                                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                                    color: '#666', transition: 'all 0.15s', fontSize: 10, fontWeight: 600,
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,104,225,0.08)'; e.currentTarget.style.borderColor = 'rgba(6,104,225,0.3)'; e.currentTarget.style.color = '#0668E1'; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = '#666'; }}
                                            >
                                                <Plus style={{ width: 12, height: 12 }} /> ADD CATEGORY
                                            </button>
                                        </div>
                                    )
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {appliedTagCount > 0 && (
                    <button
                        onClick={() => {
                            onAudienceChange('');
                            onStyleChange('');
                            onHookAngleChange('');
                            Object.keys(customTags).forEach(k => onCustomTagChange(k, ''));
                        }}
                        title="Clear all tags"
                        style={{
                            flexShrink: 0, width: 28, height: 28, borderRadius: 6,
                            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: '#555', transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#FF453A'; e.currentTarget.style.borderColor = 'rgba(255,69,58,0.3)'; e.currentTarget.style.background = 'rgba(255,69,58,0.08)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#555'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                    >
                        <RotateCcw style={{ width: 12, height: 12 }} />
                    </button>
                )}

                <button
                    onClick={onApply}
                    title={selectedCount > 0 && selectedCount < totalCount ? `Apply to ${selectedCount} files` : 'Apply to batch'}
                    style={{
                        flexShrink: 0, width: 28, height: 28,
                        borderRadius: 6, border: 'none', cursor: 'pointer',
                        background: '#0668E1',
                        color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                    }}
                >
                    <Check style={{ width: 14, height: 14 }} />
                </button>
            </div>
        </div>
    );
}
