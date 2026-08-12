import { useState, useEffect, useRef } from 'react';
import { Search, Loader2, ChevronRight, Check, Plus, RotateCcw } from 'lucide-react';
import { ScrambleNumber } from './ScrambleNumber';
import { SkeletonListItem } from './Skeletons';
import { getTaxonomy, customFieldToken } from '../lib/taxonomy';
import {
    getCampaigns,
    getAdSets,
    getAds,
    getPixels,
    extractAdSettings,
    type Campaign,
    type AdSet,
    type Ad,
    type CopiedAdSettings,
    type MetaUser,
    type AdAccount,
} from '../lib/meta';

// ── Ad Set Name Pattern editor (input + insertable tokens) ──────
function AdSetPatternEditor({ value, onChange, extraTokens }: {
    value: string;
    onChange: (v: string) => void;
    extraTokens?: { label: string; token: string }[];
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    const insertToken = (token: string) => {
        const input = inputRef.current;
        if (input) {
            const start = input.selectionStart ?? value.length;
            const end = input.selectionEnd ?? value.length;
            const newVal = value.substring(0, start) + token + value.substring(end);
            onChange(newVal);
            setTimeout(() => {
                input.focus();
                input.setSelectionRange(start + token.length, start + token.length);
            }, 0);
        } else {
            onChange(value + token);
        }
    };

    return (
        <div>
            <label className="cyber-label" style={{ display: 'block', marginBottom: 6 }}>Ad Set Name Pattern</label>
            <div style={{ position: 'relative' }}>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="{filename}"
                    className="cyber-input"
                    style={{ width: '100%', paddingRight: 34 }}
                />
                <span
                    title="Tokens: {filename} {index} {index_01} {index_001} {date} {short_date}"
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#444', cursor: 'help', userSelect: 'none' }}
                >ⓘ</span>
            </div>

            {/* Placeholder token buttons */}
            <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 5 }}>Click to insert placeholders:</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {[
                        ...(extraTokens || []),
                        { label: 'Filename', token: '{filename}' },
                        { label: 'Audience', token: '{audience}' },
                        { label: 'Hook', token: '{hook}' },
                        { label: 'Style', token: '{style}' },
                        { label: 'Type', token: '{type}' },
                        ...getTaxonomy().customFields.map(cf => ({
                            label: cf.key,
                            token: customFieldToken(cf.key),
                        })),
                        { label: 'Index', token: '{index}' },
                        { label: 'Index (01)', token: '{index_01}' },
                        { label: 'Index (001)', token: '{index_001}' },
                        { label: 'Date', token: '{date}' },
                        { label: 'Short Date', token: '{short_date}' },
                    ].map(({ label, token }) => (
                        <button
                            key={label}
                            type="button"
                            onClick={() => insertToken(token)}
                            style={{
                                fontSize: 10, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                                background: 'rgba(6,104,225,0.07)',
                                border: '1px solid rgba(6,104,225,0.22)',
                                color: '#5B9EF5', fontWeight: 600,
                                transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(6,104,225,0.18)'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(6,104,225,0.07)'; }}
                        >{label}</button>
                    ))}
                    {/* Custom Index */}
                    <button
                        type="button"
                        onClick={() => {
                            const startIdx = window.prompt('Custom index start number:', '1');
                            if (startIdx !== null && !isNaN(Number(startIdx))) {
                                insertToken(`{index_custom_${startIdx.trim()}}`);
                            }
                        }}
                        style={{
                            fontSize: 10, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                            background: 'rgba(139,92,246,0.07)',
                            border: '1px solid rgba(139,92,246,0.22)',
                            color: '#A78BFA', fontWeight: 600,
                            transition: 'background 0.1s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(139,92,246,0.18)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(139,92,246,0.07)'; }}
                    >Custom Index...</button>
                </div>
            </div>
        </div>
    );
}

interface InlineAdBrowserProps {
    metaUser: MetaUser;
    adAccount: AdAccount;
    onSelectionChange: (selection: {
        campaign: Campaign | null;
        adSet: AdSet | null;
        ad: Ad | null;
        settings: CopiedAdSettings | null;
    }) => void;
    createNewCampaign: boolean;
    onCreateNewCampaignChange: (value: boolean) => void;
    newCampaignName: string;
    onNewCampaignNameChange: (name: string) => void;
    // Ad set naming pattern for the new-campaign flow (supports {campaign} + taxonomy tokens)
    newCampaignAdSetPattern?: string;
    onNewCampaignAdSetPatternChange?: (v: string) => void;
    // New ad set creation
    createNewAdSet: boolean;
    onCreateNewAdSetChange: (value: boolean) => void;
    newAdSetName: string;           // used as the pattern e.g. "{filename}"
    onNewAdSetNameChange: (name: string) => void;
    newAdSetBudget: string;
    onNewAdSetBudgetChange: (v: string) => void;
    newAdSetBidAmount: string;
    onNewAdSetBidAmountChange: (v: string) => void;
    // Pixel list callback — sends fetched pixels up to parent for mapping
    onPixelsLoaded?: (pixels: { id: string; name: string }[]) => void;
    /** Hide create-campaign / create-ad-set controls (e.g. Copy Campaign mode). */
    selectionOnly?: boolean;
}

export function InlineAdBrowser({
    metaUser, adAccount, onSelectionChange,
    createNewCampaign, onCreateNewCampaignChange,
    newCampaignName, onNewCampaignNameChange,
    newCampaignAdSetPattern, onNewCampaignAdSetPatternChange,
    createNewAdSet, onCreateNewAdSetChange,
    newAdSetName, onNewAdSetNameChange,
    newAdSetBudget, onNewAdSetBudgetChange,
    newAdSetBidAmount, onNewAdSetBidAmountChange,
    onPixelsLoaded,
    selectionOnly = false,
}: InlineAdBrowserProps) {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [adSets, setAdSets] = useState<AdSet[]>([]);
    const [ads, setAds] = useState<Ad[]>([]);
    const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
    const [selectedAdSet, setSelectedAdSet] = useState<AdSet | null>(null);
    const [selectedAd, setSelectedAd] = useState<Ad | null>(null);
    const [extractedSettings, setExtractedSettings] = useState<CopiedAdSettings | null>(null);
    const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(true);
    const [isLoadingAdSets, setIsLoadingAdSets] = useState(false);
    const [isLoadingAds, setIsLoadingAds] = useState(false);
    const [isExtractingSettings, setIsExtractingSettings] = useState(false);
    // Off by default — PAUSED campaigns are common and the Active toggle hid them.
    const [onlyActive, setOnlyActive] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        async function fetchCampaigns() {
            setIsLoadingCampaigns(true);
            const data = await getCampaigns(metaUser.accessToken, adAccount.id);
            setCampaigns(data);
            setIsLoadingCampaigns(false);
        }
        fetchCampaigns();
    }, [metaUser.accessToken, adAccount.id, refreshKey]);

    useEffect(() => {
        if (!selectedCampaign) { setAdSets([]); setAds([]); return; }
        async function fetchAdSets() {
            setIsLoadingAdSets(true);
            setSelectedAdSet(null); setSelectedAd(null); setAds([]);
            const data = await getAdSets(metaUser.accessToken, selectedCampaign!.id);
            setAdSets(data);
            setIsLoadingAdSets(false);
        }
        fetchAdSets();
    }, [selectedCampaign, metaUser.accessToken]);

    useEffect(() => {
        if (!selectedAdSet) { setAds([]); return; }
        async function fetchAds() {
            setIsLoadingAds(true);
            setSelectedAd(null);
            const data = await getAds(metaUser.accessToken, selectedAdSet!.id);
            setAds(data);
            setIsLoadingAds(false);
        }
        fetchAds();
    }, [selectedAdSet, metaUser.accessToken]);

    useEffect(() => {
        onSelectionChange({ campaign: selectedCampaign, adSet: selectedAdSet, ad: selectedAd, settings: extractedSettings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedCampaign, selectedAdSet, selectedAd, extractedSettings]);

    // Fetch pixels for this ad account and pass to parent
    useEffect(() => {
        async function fetchPixels() {
            const data = await getPixels(metaUser.accessToken, adAccount.id);
            onPixelsLoaded?.(data);
        }
        fetchPixels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [metaUser.accessToken, adAccount.id]);

    async function handleAdSelect(ad: Ad) {
        setSelectedAd(ad);
        setIsExtractingSettings(true);
        const settings = await extractAdSettings(metaUser.accessToken, ad.id, ad.name);
        setIsExtractingSettings(false);
        setExtractedSettings(settings);
    }

    const filterItems = <T extends { name: string; status: string }>(items: T[], applyActiveFilter: boolean, applySearch: boolean): T[] => {
        let filtered = items;
        if (applyActiveFilter && onlyActive) filtered = filtered.filter(i => i.status === 'ACTIVE');
        if (applySearch && searchQuery) {
            const q = searchQuery.toLowerCase();
            filtered = filtered.filter(i => i.name.toLowerCase().includes(q));
        }
        return filtered;
    };

    // Active + search filters only apply to campaigns — ad sets and ads always show
    // everything inside the selected campaign (their names rarely match a campaign
    // search, so filtering them by the same query would hide them entirely)
    const filteredCampaigns = filterItems(campaigns, true, true);
    const filteredAdSets = filterItems(adSets, false, false);
    const filteredAds = filterItems(ads, false, false);

    const colStyle: React.CSSProperties = {
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        background: '#0D0D0D',
        border: '1px solid rgba(255,255,255,0.03)',
        borderTop: '1px solid rgba(0,0,0,0.6)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: 'inset 2px 2px 6px rgba(0,0,0,0.6), inset -1px -1px 3px rgba(255,255,255,0.02)',
    };
    const colHead: React.CSSProperties = {
        padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)',
        background: 'rgba(255,255,255,0.015)', flexShrink: 0,
    };

    const itemBtn = (key: string, selected: boolean, active: boolean, label: string, onClick: () => void, spinner?: boolean, check?: boolean) => (
        <button
            key={key}
            onClick={onClick}
            style={{
                width: '100%', textAlign: 'left', padding: '8px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.02)',
                display: 'flex', alignItems: 'center', gap: 8,
                background: selected ? 'rgba(6,104,225,0.12)' : 'transparent',
                color: selected ? '#E5F0FF' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer', transition: 'background 0.12s, color 0.12s', fontSize: 11,
            }}
            onMouseEnter={e => { if (!selected) { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'rgba(255,255,255,0.04)'; b.style.color = 'var(--text)'; } }}
            onMouseLeave={e => { if (!selected) { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'transparent'; b.style.color = 'var(--text-muted)'; } }}
        >
            <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: active ? '#30D158' : 'rgba(120,120,130,0.4)' }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{label}</span>
            {spinner && <Loader2 className="animate-spin" style={{ width: 13, height: 13, color: '#34d399', flexShrink: 0 }} />}
            {check && !spinner && <Check style={{ width: 13, height: 13, color: '#34d399', flexShrink: 0 }} />}
            {selected && !spinner && !check && <ChevronRight style={{ width: 12, height: 12, color: '#0668E1', opacity: 0.6, flexShrink: 0 }} />}
        </button>
    );

    const emptyMsg = (msg: string) => (
        <div style={{ textAlign: 'center', color: '#666', fontSize: 10, padding: '20px 0' }}>{msg}</div>
    );

    return (
        <div>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span className="cyber-label">Copy Settings From Ad</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                        onClick={() => setRefreshKey(k => k + 1)}
                        title="Refresh campaigns"
                        disabled={isLoadingCampaigns}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'transparent', border: 'none', padding: 4,
                            cursor: isLoadingCampaigns ? 'default' : 'pointer',
                            color: '#555', transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => { if (!isLoadingCampaigns) e.currentTarget.style.color = '#0668E1'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#555'; }}
                    >
                        <RotateCcw style={{ width: 12, height: 12, animation: isLoadingCampaigns ? 'spin 1s linear infinite' : 'none' }} />
                    </button>
                    <div style={{ position: 'relative' }}>
                        <Search style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', width: 11, height: 11, color: 'var(--text-muted)' }} />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search..."
                            className="cyber-input"
                            style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 5, paddingBottom: 5, width: 130, fontSize: 10 }}
                        />
                    </div>
                    <button
                        onClick={() => setOnlyActive(!onlyActive)}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '5px 10px', borderRadius: 8, fontSize: 10,
                            fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                            cursor: 'pointer', transition: 'all 0.15s',
                            background: onlyActive ? 'rgba(48,209,88,0.06)' : 'rgba(255,255,255,0.02)',
                            border: onlyActive ? '1px solid rgba(48,209,88,0.15)' : '1px solid rgba(255,255,255,0.04)',
                            color: onlyActive ? '#30D158' : 'var(--text-muted)',
                            boxShadow: onlyActive ? 'inset 1px 1px 3px rgba(48,209,88,0.05)' : 'inset 1px 1px 2px rgba(255,255,255,0.02)',
                        }}
                    >
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: onlyActive ? '#30D158' : '#555555', boxShadow: onlyActive ? '0 0 5px rgba(48,209,88,0.5)' : 'none' }} />
                        Active
                    </button>
                </div>
            </div>

            {/* 3-column browser */}
            <div style={{ display: 'flex', gap: 8, height: 200, minHeight: 0 }}>
                {/* Campaigns */}
                <div style={colStyle}>
                    <div style={colHead}>
                        <span className="cyber-label" style={{ color: '#666' }}>
                            Campaigns <ScrambleNumber value={filteredCampaigns.length} style={{ color: '#0668E1' }} />
                        </span>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto' }} className="custom-scrollbar">
                        {isLoadingCampaigns ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
                                {[1, 2, 3, 4, 5].map(i => <SkeletonListItem key={i} />)}
                            </div>
                        ) : filteredCampaigns.length === 0 ? emptyMsg('No campaigns') : (
                            filteredCampaigns.map(c => itemBtn(
                                c.id, selectedCampaign?.id === c.id, c.status === 'ACTIVE', c.name,
                                () => setSelectedCampaign(c)
                            ))
                        )}
                    </div>
                </div>

                {/* Ad Sets */}
                <div style={colStyle}>
                    <div style={colHead}>
                        <span className="cyber-label" style={{ color: '#666' }}>
                            Ad Sets <ScrambleNumber value={filteredAdSets.length} style={{ color: '#0668E1' }} />
                        </span>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto' }} className="custom-scrollbar">
                        {!selectedCampaign ? emptyMsg('Select campaign') :
                            isLoadingAdSets ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
                                    {[1, 2, 3, 4].map(i => <SkeletonListItem key={i} />)}
                                </div>
                            ) : filteredAdSets.length === 0 ? emptyMsg('No ad sets') : (
                                filteredAdSets.map(a => itemBtn(
                                    a.id, selectedAdSet?.id === a.id, a.status === 'ACTIVE', a.name,
                                    () => setSelectedAdSet(a)
                                ))
                            )}
                    </div>
                </div>

                {/* Ads */}
                <div style={colStyle}>
                    <div style={colHead}>
                        <span className="cyber-label" style={{ color: '#666' }}>
                            Ads <ScrambleNumber value={filteredAds.length} style={{ color: '#0668E1' }} />
                        </span>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto' }} className="custom-scrollbar">
                        {!selectedAdSet ? emptyMsg('Select ad set') :
                            isLoadingAds ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
                                    {[1, 2, 3, 4].map(i => <SkeletonListItem key={i} />)}
                                </div>
                            ) : filteredAds.length === 0 ? emptyMsg('No ads') : (
                                filteredAds.map(a => itemBtn(
                                    a.id, selectedAd?.id === a.id, a.status === 'ACTIVE', a.name,
                                    () => handleAdSelect(a),
                                    selectedAd?.id === a.id && isExtractingSettings,
                                    selectedAd?.id === a.id && !isExtractingSettings && extractedSettings !== null
                                ))
                            )}
                    </div>
                </div>
            </div>

            {!selectionOnly && (
                <>
                    {/* Create new campaign toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
                        <button
                            onClick={() => onCreateNewCampaignChange(!createNewCampaign)}
                            style={{
                                width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                                background: createNewCampaign ? '#0668E1' : 'rgba(0,0,0,0.4)',
                                border: createNewCampaign ? '1px solid rgba(6,104,225,0.6)' : '1px solid rgba(255,255,255,0.1)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s',
                                boxShadow: createNewCampaign ? '0 2px 8px rgba(6,104,225,0.3)' : 'inset 1px 1px 3px rgba(0,0,0,0.5)',
                            }}
                        >
                            {createNewCampaign && <Check style={{ width: 11, height: 11, color: '#fff' }} />}
                        </button>
                        <span
                            onClick={() => onCreateNewCampaignChange(!createNewCampaign)}
                            style={{ fontSize: 11, fontWeight: 600, color: '#888', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                            <Plus style={{ width: 13, height: 13 }} />
                            Create new campaign instead
                        </span>
                    </div>

                    {createNewCampaign && (
                        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }} className="animate-fade-in-up">
                            <div>
                                <label className="cyber-label" style={{ display: 'block', marginBottom: 8 }}>New Campaign Name</label>
                                <input
                                    type="text"
                                    value={newCampaignName}
                                    onChange={(e) => onNewCampaignNameChange(e.target.value)}
                                    placeholder="Enter campaign name..."
                                    className="cyber-input"
                                    style={{ width: '100%' }}
                                />
                            </div>
                            {onNewCampaignAdSetPatternChange && (
                                <AdSetPatternEditor
                                    value={newCampaignAdSetPattern ?? ''}
                                    onChange={onNewCampaignAdSetPatternChange}
                                    extraTokens={[{ label: 'Campaign', token: '{campaign}' }]}
                                />
                            )}
                        </div>
                    )}

                    {/* ── Create new Ad Set toggle ─────────────────── */}
                    {!createNewCampaign && selectedCampaign && (
                        <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                                <button
                                    onClick={() => onCreateNewAdSetChange(!createNewAdSet)}
                                    style={{
                                        width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                                        background: createNewAdSet ? '#0668E1' : 'rgba(0,0,0,0.4)',
                                        border: createNewAdSet ? '1px solid rgba(6,104,225,0.6)' : '1px solid rgba(255,255,255,0.1)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s',
                                        boxShadow: createNewAdSet ? '0 2px 8px rgba(6,104,225,0.3)' : 'inset 1px 1px 3px rgba(0,0,0,0.5)',
                                    }}
                                >
                                    {createNewAdSet && <Check style={{ width: 11, height: 11, color: '#fff' }} />}
                                </button>
                                <span
                                    onClick={() => onCreateNewAdSetChange(!createNewAdSet)}
                                    style={{ fontSize: 11, fontWeight: 600, color: '#888', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                                >
                                    <Plus style={{ width: 13, height: 13 }} />
                                    Create new ad set
                                </span>
                            </div>

                            {createNewAdSet && (
                                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }} className="animate-fade-in-up">

                                    {/* Ad Set Name Pattern */}
                                    <AdSetPatternEditor value={newAdSetName} onChange={onNewAdSetNameChange} />


                                    {/* Budget or Bid Amount — hidden for CBO campaigns (budget is on the campaign) */}
                                    {(() => {
                                        const isCbo = Boolean(selectedCampaign?.daily_budget && selectedCampaign.daily_budget !== '0');
                                        if (isCbo) {
                                            const dollars = (parseInt(selectedCampaign!.daily_budget!, 10) / 100).toFixed(2);
                                            return (
                                                <div style={{ fontSize: 11, color: '#666', lineHeight: 1.45 }}>
                                                    This campaign uses CBO — daily budget ${dollars} is shared at the campaign level.
                                                    Ad-set budget is not set. Schedule, geo exclusions, and placements are in Campaign Delivery below.
                                                </div>
                                            );
                                        }
                                        const isBidCap = selectedCampaign?.bid_strategy === 'LOWEST_COST_WITH_BID_CAP';
                                        const label = isBidCap ? 'Bid Amount per Ad Set' : 'Daily Budget per Ad Set';
                                        return (
                                            <div>
                                                <label className="cyber-label" style={{ display: 'block', marginBottom: 6 }}>{label}</label>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <span style={{ fontSize: 12, color: '#888', fontWeight: 600 }}>$</span>
                                                    <input
                                                        type="number"
                                                        min="1"
                                                        step="0.01"
                                                        value={isBidCap ? newAdSetBidAmount : newAdSetBudget}
                                                        onChange={(e) => isBidCap
                                                            ? onNewAdSetBidAmountChange(e.target.value)
                                                            : onNewAdSetBudgetChange(e.target.value)
                                                        }
                                                        placeholder={isBidCap ? '2' : '50'}
                                                        className="cyber-input"
                                                        style={{ width: 100 }}
                                                    />
                                                    <span style={{ fontSize: 11, color: '#666', fontWeight: 500 }}>USD</span>
                                                </div>
                                                <div style={{ fontSize: 10, color: '#555', marginTop: 6 }}>
                                                    Schedule, geo exclusions, and placements are in Campaign Delivery below.
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}
                        </>
                    )}
                </>
            )}
        </div>
    );
}
