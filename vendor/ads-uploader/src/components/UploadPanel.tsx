import { useState, useEffect, useCallback, useRef } from 'react';
import { Check, AlertCircle, Loader2, ChevronDown, Sparkles, RotateCcw, LayoutGrid, List, X } from 'lucide-react';
import { adaptCopyForAudiences, type AdaptedCopy } from '../lib/creativeIntel';
import {
    getAdAccounts,
    getPages,
    getAdVideos,
    uploadBatchImagesToMetaAsAds,
    uploadBatchToMetaAsAds,
    uploadImageToMeta,
    uploadVideoToMeta,
    createAdFromVideo,
    createFlexAdFromVideos,
    createCampaign,
    createAdSet,
    deleteCampaign,
    deleteAdSet,
    getAdSets,
    getAdSetById,
    getCampaignFull,
    copyCampaignToAccount,
    getPixels,
    type AdAccount,
    type MetaUser,
    type Campaign,
    type AdSet,
    type Page,
    type CopiedAdSettings,
    type AdVideo,
    type CopyProgress,
    type FullCampaign,
} from '../lib/meta';
import { InlineAdBrowser } from './InlineAdBrowser';
import { AdSettingsForm, getDefaultAdSettings } from './AdSettingsForm';
import { PageSelector } from './PageSelector';
import { PortalDropdown } from './PortalDropdown';
import { SkeletonDropdownField } from './Skeletons';
import type { MediaFile } from './DropZone';
import {
    US_STATES,
    SPECIAL_AD_CATEGORIES,
    buildUsTargeting,
    zonedDateTimeToUtcIso,
    todayInTimeZone,
    type BudgetMode,
    type SpecialAdCategory,
} from '../lib/targeting';

// ── Ad Account custom dropdown ──────────────────────────────────
function AdAccountDropdown({ accounts, selected, onChange, isLoading }: {
    accounts: AdAccount[];
    selected: AdAccount | null;
    onChange: (a: AdAccount) => void;
    isLoading?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLButtonElement>(null);

    if (isLoading) {
        return (
            <div className="cyber-input" style={{ width: '100%', borderRadius: 8 }}>
                <SkeletonDropdownField />
            </div>
        );
    }

    return (
        <div style={{ position: 'relative' }}>
            <button
                ref={ref}
                type="button"
                onClick={() => setIsOpen(o => !o)}
                className="cyber-input"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '10px 14px', minHeight: 44 }}
            >
                <span style={{ fontSize: 13, fontWeight: 600, color: selected ? 'var(--text)' : '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selected ? `${selected.name} (${selected.account_id})` : 'Select an ad account...'}
                </span>
                <ChevronDown style={{ width: 14, height: 14, color: 'var(--text-muted)', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
            </button>
            <PortalDropdown isOpen={isOpen} onClose={() => setIsOpen(false)} anchorRef={ref}>
                <div
                    className="skeuo-raised animate-fade-in"
                    style={{ borderRadius: 14, padding: 6, overflow: 'hidden' }}
                >
                    <div className="custom-scrollbar scroll-fade" style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {accounts.map(a => {
                            const isSel = selected?.id === a.id;
                            return (
                                <button
                                    key={a.id}
                                    type="button"
                                    onClick={() => { onChange(a); setIsOpen(false); }}
                                    style={{
                                        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                        padding: '10px 12px', borderRadius: 10, fontSize: 13, cursor: 'pointer', textAlign: 'left',
                                        background: isSel ? 'rgba(6,104,225,0.12)' : 'transparent',
                                        color: isSel ? '#E5F0FF' : 'var(--text-muted)',
                                        border: 'none', transition: 'background 0.12s, color 0.12s', flexShrink: 0,
                                    }}
                                    onMouseEnter={e => { if (!isSel) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'var(--text)'; } }}
                                    onMouseLeave={e => { if (!isSel) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
                                >
                                    <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name} <span style={{ opacity: 0.5, fontWeight: 400 }}>({a.account_id})</span></span>
                                    {isSel && <Check style={{ width: 14, height: 14, color: '#0668E1', flexShrink: 0, marginLeft: 8 }} />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </PortalDropdown>
        </div>
    );
}

interface UploadPanelProps {
    metaUser: MetaUser | null;
    files: MediaFile[];
    selectedFileIds: Set<string>;
    onSelectionChange: (ids: Set<string>) => void;
}

interface FileUploadStatus {
    fileId: string;
    status: 'pending' | 'uploading' | 'success' | 'failed';
    progress: number;
    error?: string;
}

interface BrowserSelection {
    campaign: Campaign | null;
    adSet: AdSet | null;
    ad: { id: string; name: string; status: string } | null;
    settings: CopiedAdSettings | null;
}

type UploadMode = 'library' | 'campaign' | 'copy';

type CampaignObjective =
    | 'OUTCOME_TRAFFIC'
    | 'OUTCOME_SALES'
    | 'OUTCOME_LEADS'
    | 'OUTCOME_ENGAGEMENT'
    | 'OUTCOME_AWARENESS';

type PixelConversionEvent =
    | 'PURCHASE'
    | 'LEAD'
    | 'COMPLETE_REGISTRATION'
    | 'ADD_TO_CART'
    | 'INITIATED_CHECKOUT'
    | 'ADD_PAYMENT_INFO'
    | 'CONTENT_VIEW'
    | 'CONTACT'
    | 'SUBSCRIBE'
    | 'START_TRIAL'
    | 'SEARCH';

const CAMPAIGN_OBJECTIVES: Array<{ value: CampaignObjective; label: string }> = [
    { value: 'OUTCOME_TRAFFIC', label: 'Traffic' },
    { value: 'OUTCOME_SALES', label: 'Sales / Website Conversions' },
    { value: 'OUTCOME_LEADS', label: 'Website Leads' },
    { value: 'OUTCOME_ENGAGEMENT', label: 'Engagement' },
    { value: 'OUTCOME_AWARENESS', label: 'Awareness' },
];

const PIXEL_CONVERSION_EVENTS: Array<{ value: PixelConversionEvent; label: string }> = [
    { value: 'PURCHASE', label: 'Purchase' },
    { value: 'LEAD', label: 'Lead' },
    { value: 'COMPLETE_REGISTRATION', label: 'Complete Registration' },
    { value: 'ADD_TO_CART', label: 'Add to Cart' },
    { value: 'INITIATED_CHECKOUT', label: 'Initiate Checkout' },
    { value: 'ADD_PAYMENT_INFO', label: 'Add Payment Info' },
    { value: 'CONTENT_VIEW', label: 'View Content' },
    { value: 'CONTACT', label: 'Contact' },
    { value: 'SUBSCRIBE', label: 'Subscribe' },
    { value: 'START_TRIAL', label: 'Start Trial' },
    { value: 'SEARCH', label: 'Search' },
];

function objectiveUsesPixel(objective?: string): boolean {
    return objective === 'OUTCOME_SALES' || objective === 'OUTCOME_LEADS';
}

function defaultOptimizationGoal(objective?: string): string | undefined {
    switch (objective) {
        case 'OUTCOME_TRAFFIC': return 'LANDING_PAGE_VIEWS';
        case 'OUTCOME_ENGAGEMENT': return 'POST_ENGAGEMENT';
        case 'OUTCOME_AWARENESS': return 'REACH';
        case 'OUTCOME_SALES':
        case 'OUTCOME_LEADS':
            return 'OFFSITE_CONVERSIONS';
        default:
            return undefined;
    }
}

export function UploadPanel({ metaUser, files, selectedFileIds, onSelectionChange }: UploadPanelProps) {
    const selectedFiles = files.filter(f => selectedFileIds.has(f.id));
    const [uploadMode, setUploadMode] = useState<UploadMode>('library');
    const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
    const [selectedAccount, setSelectedAccount] = useState<AdAccount | null>(null);
    const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
    const [accountsError, setAccountsError] = useState<string | null>(null);
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPage, setSelectedPage] = useState<Page | null>(null);
    const [isLoadingPages, setIsLoadingPages] = useState(false);
    const [browserSelection, setBrowserSelection] = useState<BrowserSelection>({ campaign: null, adSet: null, ad: null, settings: null });
    const [createNewCampaign, setCreateNewCampaign] = useState(false);
    const [newCampaignName, setNewCampaignName] = useState('');
    const [newCampaignAdSetPattern, setNewCampaignAdSetPattern] = useState('{campaign} - Ad Set');
    const [newCampaignObjective, setNewCampaignObjective] = useState<CampaignObjective>('OUTCOME_SALES');
    const [budgetMode, setBudgetMode] = useState<BudgetMode>('ABO');
    const [campaignDailyBudget, setCampaignDailyBudget] = useState('50');
    const [specialAdCategory, setSpecialAdCategory] = useState<SpecialAdCategory>('');
    const [adSetStartDate, setAdSetStartDate] = useState('');
    const [adSetStartTime, setAdSetStartTime] = useState('09:00');
    const [adSetEndDate, setAdSetEndDate] = useState('');
    const [adSetEndTime, setAdSetEndTime] = useState('23:59');
    const [excludedStates, setExcludedStates] = useState<string[]>([]);
    const [createNewAdSet, setCreateNewAdSet] = useState(false);
    const [newAdSetName, setNewAdSetName] = useState('{filename}');
    const [newAdSetBudget, setNewAdSetBudget] = useState('50');
    const [newAdSetBidAmount, setNewAdSetBidAmount] = useState('2');
    const [splitAdSets, setSplitAdSets] = useState(false);
    const [adsPerAdSet, setAdsPerAdSet] = useState('5');
    const [pixelMap, setPixelMap] = useState<Record<string, string>>({}); // audience → pixel ID
    const [availablePixels, setAvailablePixels] = useState<{ id: string; name: string }[]>([]);
    const [selectedPixelId, setSelectedPixelId] = useState('');
    const [pixelConversionEvent, setPixelConversionEvent] = useState<PixelConversionEvent>('PURCHASE');
    const [pageMap, setPageMap] = useState<Record<string, string>>({}); // audience → page ID
    const [urlMap, setUrlMap] = useState<Record<string, string>>({}); // audience → website URL
    const [adSettings, setAdSettings] = useState<CopiedAdSettings>(getDefaultAdSettings());
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatuses, setUploadStatuses] = useState<FileUploadStatus[]>([]);
    const [isComplete, setIsComplete] = useState(false);
    const fileIdsKey = files.map(file => file.id).join('|');
    const previousFileIdsKey = useRef(fileIdsKey);
    const uploadAbortRef = useRef<AbortController | null>(null);
    const cancelledUploadIdsRef = useRef<Set<string>>(new Set());

    // Per-audience copy adaptation
    const [audienceCopyMap, setAudienceCopyMap] = useState<Map<string, AdaptedCopy>>(new Map());
    // Track which audiences the user chose to use original copy for
    const [useOriginalForAudience, setUseOriginalForAudience] = useState<Set<string>>(new Set());
    const [isAdaptingCopy, setIsAdaptingCopy] = useState(false);
    const [adaptProgress, setAdaptProgress] = useState('');

    // Video library state
    const [existingVideos, setExistingVideos] = useState<AdVideo[]>([]);
    const [isLoadingVideos, setIsLoadingVideos] = useState(false);
    const [showVideoLibrary, setShowVideoLibrary] = useState(false);
    const [videoLibraryLoaded, setVideoLibraryLoaded] = useState(false);
    const [videoLibraryView, setVideoLibraryView] = useState<'list' | 'grid'>('grid');
    const [selectedLibraryVideoIds, setSelectedLibraryVideoIds] = useState<Set<string>>(new Set());
    const selectedLibraryVideos = existingVideos.filter(v => selectedLibraryVideoIds.has(v.id));
    /** Bundle all selected videos into one Dynamic Creative / flex ad */
    const [flexAd, setFlexAd] = useState(false);

    // Copy campaign mode state
    const [destAccount, setDestAccount] = useState<AdAccount | null>(null);
    const [destPages, setDestPages] = useState<Page[]>([]);
    const [destSelectedPage, setDestSelectedPage] = useState<Page | null>(null);
    const [isLoadingDestPages, setIsLoadingDestPages] = useState(false);
    const [destPixels, setDestPixels] = useState<{ id: string; name: string }[]>([]);
    const [destSelectedPixel, setDestSelectedPixel] = useState<string>('');
    const [isCopying, setIsCopying] = useState(false);
    const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
    const [copyResult, setCopyResult] = useState<{
        success: boolean;
        stats: { adSets: number; ads: number; failed: number };
        error?: string;
    } | null>(null);
    const [sourceCampaignData, setSourceCampaignData] = useState<FullCampaign | null>(null);
    const [isLoadingCampaignData, setIsLoadingCampaignData] = useState(false);

    // Preview drawer resize state
    const [drawerHeight, setDrawerHeight] = useState(200);
    const isDraggingDrawer = useRef(false);
    const dragStartY = useRef(0);
    const dragStartHeight = useRef(0);

    // Preview table sort
    type PreviewSortKey = 'campaignId' | 'campaignName' | 'adSetId' | 'adSetName' | 'adName';
    const [previewSortKey, setPreviewSortKey] = useState<PreviewSortKey | null>(null);
    const [previewSortDir, setPreviewSortDir] = useState<'asc' | 'desc'>('asc');
    const handlePreviewSort = (key: PreviewSortKey) => {
        if (previewSortKey === key) setPreviewSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setPreviewSortKey(key); setPreviewSortDir('asc'); }
    };

    useEffect(() => {
        if (metaUser) {
            fetchAdAccounts();
            fetchPages();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [metaUser]);

    // Reset results only when the actual file selection changes. Depending on
    // isComplete here caused completion to clear itself immediately.
    useEffect(() => {
        if (previousFileIdsKey.current !== fileIdsKey) {
            previousFileIdsKey.current = fileIdsKey;
            setIsComplete(false);
            setUploadStatuses([]);
        }
    }, [fileIdsKey]);

    async function fetchAdAccounts() {
        if (!metaUser) return;
        setIsLoadingAccounts(true);
        setAccountsError(null);
        try {
            const accounts = await getAdAccounts(metaUser.accessToken);
            setAdAccounts(accounts);
            if (accounts.length > 0 && !selectedAccount) setSelectedAccount(accounts[0]);
            if (accounts.length === 0) {
                setAccountsError('No ad accounts assigned to this token.');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load ad accounts';
            setAdAccounts([]);
            setAccountsError(msg);
        }
        setIsLoadingAccounts(false);
    }

    async function fetchPages() {
        if (!metaUser) return;
        setIsLoadingPages(true);
        const pageList = await getPages(metaUser.accessToken);
        setPages(pageList);
        if (pageList.length > 0 && !selectedPage) setSelectedPage(pageList[0]);
        setIsLoadingPages(false);
    }

    async function fetchVideoLibrary() {
        if (!metaUser || !selectedAccount) return;
        setIsLoadingVideos(true);
        try {
            const videos = await getAdVideos(metaUser.accessToken, selectedAccount.id, 200);
            setExistingVideos(videos);
            setVideoLibraryLoaded(true);
            const validIds = new Set(videos.map(v => v.id));
            setSelectedLibraryVideoIds(prev => new Set([...prev].filter(id => validIds.has(id))));
        } finally {
            setIsLoadingVideos(false);
        }
    }

    // Default destination to the source account so same-account duplicates work
    // (previously dest excluded the source, which left Copy disabled with 1 account).
    useEffect(() => {
        if (uploadMode !== 'copy' || !selectedAccount) return;
        if (!destAccount) setDestAccount(selectedAccount);
    }, [uploadMode, selectedAccount, destAccount]);

    // Fetch pages & pixels for destination account when it changes (copy mode)
    useEffect(() => {
        if (!metaUser || !destAccount) { setDestPages([]); setDestPixels([]); return; }
        async function fetchDestResources() {
            setIsLoadingDestPages(true);
            const [pageList, pixelList] = await Promise.all([
                getPages(metaUser!.accessToken),
                getPixels(metaUser!.accessToken, destAccount!.id),
            ]);
            setDestPages(pageList);
            if (pageList.length > 0) setDestSelectedPage(pageList[0]);
            setDestPixels(pixelList);
            if (pixelList.length > 0) setDestSelectedPixel(pixelList[0].id);
            else setDestSelectedPixel('');
            setIsLoadingDestPages(false);
        }
        fetchDestResources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [metaUser, destAccount?.id]);

    // When source campaign is selected in copy mode, load full campaign tree
    useEffect(() => {
        if (uploadMode !== 'copy' || !metaUser || !browserSelection.campaign) {
            setSourceCampaignData(null);
            return;
        }
        async function loadCampaign() {
            setIsLoadingCampaignData(true);
            const data = await getCampaignFull(metaUser!.accessToken, browserSelection.campaign!.id);
            setSourceCampaignData(data);
            setIsLoadingCampaignData(false);
        }
        loadCampaign();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploadMode, browserSelection.campaign?.id, metaUser]);

    async function handleCopyCampaign() {
        if (!metaUser || !sourceCampaignData || !destAccount || !destSelectedPage) return;
        setIsCopying(true);
        setCopyResult(null);
        setCopyProgress({ phase: 'reading', message: 'Starting...', current: 0, total: 0 });

        const sameAccount = destAccount.id === selectedAccount?.id;
        const sourceForCopy = sameAccount
            ? {
                ...sourceCampaignData,
                campaign: {
                    ...sourceCampaignData.campaign,
                    name: `${sourceCampaignData.campaign.name} (Copy)`,
                },
            }
            : sourceCampaignData;

        const result = await copyCampaignToAccount(
            metaUser.accessToken,
            sourceForCopy,
            destAccount.id,
            destSelectedPage.id,
            destSelectedPixel || undefined,
            (progress) => setCopyProgress(progress),
            selectedAccount?.id,
        );

        setCopyResult({
            success: result.success,
            stats: result.stats,
            error: result.error,
        });
        setIsCopying(false);
    }

    const handleBrowserSelectionChange = useCallback((selection: BrowserSelection) => {
        setBrowserSelection(selection);
        if (selection.settings) setAdSettings(selection.settings);
    }, []);

    const setStatus = (fileId: string, status: FileUploadStatus['status'], progress: number, error?: string) =>
        setUploadStatuses(prev => prev.map(s => s.fileId === fileId ? { ...s, status, progress, error } : s));

    function cancelFileUpload(fileId: string) {
        cancelledUploadIdsRef.current.add(fileId);
        setUploadStatuses(prev => prev.map(s =>
            s.fileId === fileId && (s.status === 'pending' || s.status === 'uploading')
                ? { ...s, status: 'failed', progress: s.progress || 0, error: 'Cancelled' }
                : s,
        ));
        // Abort the in-flight Meta request so the wrong file stops transferring.
        uploadAbortRef.current?.abort();
    }

    const deliveryObjective = createNewCampaign
        ? newCampaignObjective
        : browserSelection.campaign?.objective;
    const isPixelConversionSetup = (createNewCampaign || createNewAdSet)
        && objectiveUsesPixel(deliveryObjective);

    function resolveAdSetDelivery(
        audience: string,
        sourceOptimizationGoal?: string,
        sourcePromotedObject?: Record<string, unknown>,
    ): { optimizationGoal?: string; promotedObject?: Record<string, unknown> } {
        if (!objectiveUsesPixel(deliveryObjective)) {
            return {
                optimizationGoal: sourceOptimizationGoal || defaultOptimizationGoal(deliveryObjective),
                promotedObject: sourcePromotedObject,
            };
        }

        const pixelId = (audience && pixelMap[audience]) || selectedPixelId;
        return {
            optimizationGoal: 'OFFSITE_CONVERSIONS',
            promotedObject: pixelId
                ? { pixel_id: pixelId, custom_event_type: pixelConversionEvent }
                : undefined,
        };
    }

    const accountTimeZone = selectedAccount?.timezone_name || 'America/Los_Angeles';

    // Default start date to "today" in the ad account timezone once an account is picked.
    useEffect(() => {
        if (!selectedAccount) return;
        setAdSetStartDate(prev => prev || todayInTimeZone(accountTimeZone));
    }, [selectedAccount, accountTimeZone]);

    function buildDeliveryTargeting(sourceTargeting?: Record<string, unknown>): Record<string, unknown> {
        return buildUsTargeting({
            excludedStateCodes: excludedStates,
            base: sourceTargeting,
        });
    }

    function resolveScheduleTimes(): { startTime?: string; endTime?: string; error?: string } {
        if (!adSetStartDate) return {};
        try {
            const startTime = zonedDateTimeToUtcIso(adSetStartDate, adSetStartTime || '00:00', accountTimeZone);
            let endTime: string | undefined;
            if (adSetEndDate) {
                endTime = zonedDateTimeToUtcIso(adSetEndDate, adSetEndTime || '23:59', accountTimeZone);
                if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
                    return { error: 'End date/time must be after the start date/time' };
                }
            }
            return { startTime, endTime };
        } catch (err) {
            return { error: err instanceof Error ? err.message : 'Invalid schedule' };
        }
    }

    function toggleExcludedState(code: string) {
        setExcludedStates(prev =>
            prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code],
        );
    }

    // ── Filename resolver utilities ────────────────────────────────
    /** Resolve taxonomy tokens in any string: {audience}, {hook}, {style}, {filename}, custom tags, etc. */
    function resolveTokens(template: string, file: MediaFile, index: number): string {
        const today = new Date();
        const ext = file.name.match(/\.[^/.]+$/)?.[0] || '';
        const nameSansExt = file.name.replace(/\.[^/.]+$/, '');
        const filename = nameSansExt.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
        let resolved = template
            .replace(/\{filename\}/g, filename)
            .replace(/\{ext\}/g, ext)
            .replace(/\{index\}/g, String(index + 1))
            .replace(/\{index_01\}/g, String(index + 1).padStart(2, '0'))
            .replace(/\{index_001\}/g, String(index + 1).padStart(3, '0'))
            .replace(/\{index_custom_(\d+)\}/g, (_, start) => String(Number(start) + index))
            .replace(/\{audience\}/g, file.audience || 'Unknown')
            .replace(/\{hook\}/g, file.hookAngle || 'Unknown')
            .replace(/\{style\}/g, file.creativeStyle || 'Unknown')
            .replace(/\{type\}/g, file.type === 'video' ? 'Video' : 'Image')
            .replace(/\{date\}/g, today.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).replace(' ', '_'))
            .replace(/\{short_date\}/g, today.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }).replace('/', '-'));
        // Resolve custom tag tokens
        if (file.customTags) {
            for (const [key, val] of Object.entries(file.customTags)) {
                const token = key.toLowerCase().replace(/\s+/g, '-');
                resolved = resolved.replace(new RegExp(`\\{${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), val || '');
            }
        }
        return resolved;
    }

    function resolveAdSetName(pattern: string, file: MediaFile, index: number): string {
        const resolvedPattern = (pattern || '{filename}').replace(/\}\{/g, '}_{');
        return resolveTokens(resolvedPattern, file, index);
    }

    /** Ad set name for the new-campaign flow: supports {campaign} plus all taxonomy tokens */
    function resolveNewCampaignAdSetName(file: MediaFile, index: number): string {
        const pattern = (newCampaignAdSetPattern.trim() || '{campaign} - Ad Set')
            .replace(/\{campaign\}/g, newCampaignName.trim());
        return resolveAdSetName(pattern, file, index);
    }

    /** Resolve per-file ad settings: use adapted copy if available for this file's audience,
     *  per-audience URL override, and {audience}/{hook}/{style} tokens in the websiteUrl */
    function getAdSettingsForFile(file: MediaFile): CopiedAdSettings {
        let settings = adSettings;
        // Apply audience-adapted copy if available
        if (file.audience && !useOriginalForAudience.has(file.audience)) {
            const adapted = audienceCopyMap.get(file.audience);
            if (adapted) {
                settings = {
                    ...settings,
                    headlines: adapted.headlines,
                    primaryTexts: adapted.primaryTexts,
                    description: adapted.description,
                };
            }
        }
        // Per-audience URL override (e.g. different RedTrack campaign links per audience)
        if (file.audience && urlMap[file.audience]) {
            settings = { ...settings, websiteUrl: urlMap[file.audience] };
        }
        // Resolve taxonomy tokens in the website URL (e.g. {audience} for RedTrack sub-IDs)
        else if (settings.websiteUrl && /\{(audience|hook|style|filename|type)/.test(settings.websiteUrl)) {
            settings = {
                ...settings,
                websiteUrl: resolveTokens(settings.websiteUrl, file, 0),
            };
        }
        return settings;
    }

    async function handleUpload() {
        // Deploy selected local creatives and/or selected Meta library videos.
        const files = selectedFiles;
        const libraryVideos = uploadMode === 'campaign' ? selectedLibraryVideos : [];
        if (!selectedAccount || !metaUser) return;
        if (uploadMode === 'library' && files.length === 0) {
            alert('Select at least one creative to upload');
            return;
        }
        if (uploadMode === 'campaign' && files.length === 0 && libraryVideos.length === 0) {
            alert('Select at least one local creative or library video for the campaign');
            return;
        }

        if (uploadMode === 'campaign') {
            if (createNewCampaign && (!newCampaignName.trim() || !selectedPage)) {
                alert('Please enter a campaign name and select a Facebook Page');
                return;
            }
            if (!createNewCampaign && createNewAdSet && (!newAdSetName.trim() || !browserSelection.campaign || !selectedPage)) {
                alert('Please enter an ad set name and select a campaign and Facebook Page');
                return;
            }
            if (!createNewCampaign && !createNewAdSet && (!browserSelection.adSet || !selectedPage)) {
                alert('Please select an ad set and a Facebook Page');
                return;
            }
            if (isPixelConversionSetup && !selectedPixelId) {
                alert('Please select a default Meta Pixel for this conversion campaign');
                return;
            }
            if ((createNewCampaign || createNewAdSet) && !adSetStartDate) {
                alert('Please set a start date for the ad set(s)');
                return;
            }
            if (createNewCampaign && budgetMode === 'CBO' && !(parseFloat(campaignDailyBudget) > 0)) {
                alert('Please enter a campaign daily budget for CBO');
                return;
            }
            if (createNewCampaign && budgetMode === 'ABO' && !(parseFloat(newAdSetBudget) > 0)) {
                alert('Please enter an ad set daily budget for ABO');
                return;
            }
        }

        const schedule = (createNewCampaign || createNewAdSet) ? resolveScheduleTimes() : {};
        if (schedule.error) {
            alert(schedule.error);
            return;
        }

        setIsUploading(true);
        setIsComplete(false);
        cancelledUploadIdsRef.current = new Set();
        uploadAbortRef.current = new AbortController();
        setUploadStatuses([
            ...files.map(f => ({ fileId: f.id, status: 'pending' as const, progress: 0 })),
            ...libraryVideos.map(v => ({ fileId: `lib:${v.id}`, status: 'pending' as const, progress: 0 })),
        ]);
        const uploadSignal = () => {
            // Recreate after a per-file cancel so remaining files can continue.
            if (!uploadAbortRef.current || uploadAbortRef.current.signal.aborted) {
                uploadAbortRef.current = new AbortController();
            }
            return uploadAbortRef.current.signal;
        };
        const wasCancelled = (fileId: string) => cancelledUploadIdsRef.current.has(fileId);

        // Fetch existing videos for skip-reupload (only for video files)
        const videoFiles = files.filter(f => f.type === 'video');
        const imageFiles = files.filter(f => f.type === 'image');
        let cachedVideos: AdVideo[] = existingVideos;
        if (videoFiles.length > 0 && selectedAccount && metaUser) {
            try {
                cachedVideos = await getAdVideos(metaUser.accessToken, selectedAccount.id, 200);
                setExistingVideos(cachedVideos);
                setVideoLibraryLoaded(true);
            } catch { /* use cached */ }
        }
        let successful = 0;
        let failed = 0;

        const deployLibraryVideos = async (adSetId: string, pageId: string) => {
            for (const v of libraryVideos) {
                const statusId = `lib:${v.id}`;
                if (wasCancelled(statusId)) { failed++; continue; }
                setStatus(statusId, 'uploading', 25);
                const result = await createAdFromVideo(
                    selectedAccount.id,
                    adSetId,
                    pageId,
                    metaUser.accessToken,
                    v.id,
                    v.title || `Video ${v.id}`,
                    adSettings,
                    v.picture ? { imageUrl: v.picture } : undefined,
                );
                if (wasCancelled(statusId)) { failed++; continue; }
                setStatus(statusId, result.success ? 'success' : 'failed', 100, result.error);
                if (result.success) successful++;
                else failed++;
            }
        };

        // ── Flex Ad path: all selected videos → one Dynamic Creative ad ──
        if (uploadMode === 'campaign' && flexAd && selectedPage) {
            const localVideos = files.filter(f => f.type === 'video');
            const localImages = files.filter(f => f.type === 'image');
            if (localImages.length > 0) {
                for (const img of localImages) {
                    setStatus(img.id, 'failed', 100, 'Flex ads currently support videos only — deselect images or turn off Flex Ad');
                    failed++;
                }
            }

            const flexVideoSlots = localVideos.length + libraryVideos.length;
            if (flexVideoSlots === 0) {
                alert('Select at least one video (local or library) for a flex ad');
                setIsUploading(false);
                return;
            }
            if (flexVideoSlots > 10) {
                alert('Flex ads support at most 10 videos. Deselect some and try again.');
                setIsUploading(false);
                return;
            }

            // Ensure we have a DCO-capable ad set (is_dynamic_creative=true)
            let flexAdSetId: string | null = null;
            let createdFlexCampaignId: string | null = null;
            let createdFlexAdSetId: string | null = null;

            if (createNewCampaign) {
                const srcCamp = browserSelection.campaign;
                const srcAdSet = browserSelection.adSet;
                const campaignBudgetCents = budgetMode === 'CBO'
                    ? Math.round(parseFloat(campaignDailyBudget) * 100)
                    : undefined;
                const cr = await createCampaign(metaUser.accessToken, selectedAccount.id, {
                    name: newCampaignName.trim(),
                    objective: newCampaignObjective,
                    special_ad_categories: specialAdCategory ? [specialAdCategory] : [],
                    status: 'ACTIVE',
                    dailyBudget: campaignBudgetCents,
                    bidStrategy: budgetMode === 'CBO'
                        ? (srcAdSet?.bid_strategy || srcCamp?.bid_strategy || 'LOWEST_COST_WITHOUT_CAP')
                        : undefined,
                });
                if (!cr.success || !cr.campaignId) {
                    alert(`Campaign creation failed: ${cr.error}`);
                    setIsUploading(false);
                    return;
                }
                createdFlexCampaignId = cr.campaignId;

                const rawBidStrategy = srcAdSet?.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
                const srcBidAmount = srcAdSet?.bid_amount != null && srcAdSet.bid_amount !== '' ? parseInt(srcAdSet.bid_amount) : undefined;
                const needsBidAmount = rawBidStrategy === 'LOWEST_COST_WITH_BID_CAP' || rawBidStrategy === 'COST_CAP';
                const clonedBidStrategy = needsBidAmount && srcBidAmount === undefined ? 'LOWEST_COST_WITHOUT_CAP' : rawBidStrategy;
                const clonedBidAmount = needsBidAmount && srcBidAmount !== undefined ? srcBidAmount : undefined;
                const clonedDailyBudget = budgetMode === 'CBO'
                    ? undefined
                    : Math.round(parseFloat(newAdSetBudget) * 100) || (srcAdSet?.daily_budget ? parseInt(srcAdSet.daily_budget) : 5000);
                const delivery = resolveAdSetDelivery('', srcAdSet?.optimization_goal, srcAdSet?.promoted_object);
                const adSetName = (newCampaignAdSetPattern.trim() || '{campaign} - Ad Set')
                    .replace(/\{campaign\}/g, newCampaignName.trim())
                    .replace(/\{audience\}/g, 'Flex')
                    .replace(/\{hook\}/g, 'Flex')
                    .replace(/\{style\}/g, 'Flex')
                    .replace(/\{filename\}/g, 'Flex');

                const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                    name: adSetName,
                    campaignId: createdFlexCampaignId,
                    dailyBudget: clonedDailyBudget,
                    bidAmount: clonedBidAmount,
                    bidStrategy: budgetMode === 'CBO' ? undefined : clonedBidStrategy,
                    bidConstraints: srcAdSet?.bid_constraints || undefined,
                    billingEvent: (srcAdSet?.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                    optimizationGoal: delivery.optimizationGoal,
                    targeting: buildDeliveryTargeting(srcAdSet?.targeting as Record<string, unknown> | undefined),
                    promotedObject: delivery.promotedObject,
                    isDynamicCreative: true,
                    status: 'ACTIVE',
                    startTime: schedule.startTime,
                    endTime: schedule.endTime,
                });
                if (!ar.success || !ar.adSetId) {
                    alert(`Ad set creation failed: ${ar.error}`);
                    await deleteCampaign(metaUser.accessToken, createdFlexCampaignId);
                    setIsUploading(false);
                    return;
                }
                flexAdSetId = ar.adSetId;
                createdFlexAdSetId = ar.adSetId;
            } else if (createNewAdSet && browserSelection.campaign) {
                const camp = browserSelection.campaign;
                const sourceAdSet = browserSelection.adSet;
                const bidStrategy = sourceAdSet?.bid_strategy || camp.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
                const isBidCap = bidStrategy === 'LOWEST_COST_WITH_BID_CAP';
                const isCostCap = bidStrategy === 'COST_CAP';
                const needsBidAmount = isBidCap || isCostCap;
                const isCboCampaign = Boolean(camp.daily_budget && camp.daily_budget !== '0');
                const hasDailyBudget = sourceAdSet?.daily_budget != null && sourceAdSet.daily_budget !== '';
                const dailyBudget = isCboCampaign
                    ? undefined
                    : hasDailyBudget
                        ? parseInt(sourceAdSet!.daily_budget!)
                        : Math.round(parseFloat(newAdSetBudget) * 100);
                const hasBidAmount = sourceAdSet?.bid_amount != null && sourceAdSet.bid_amount !== '';
                const bidAmount = hasBidAmount
                    ? parseInt(sourceAdSet!.bid_amount!)
                    : (needsBidAmount ? Math.round(parseFloat(newAdSetBidAmount) * 100) : undefined);
                const delivery = resolveAdSetDelivery('', sourceAdSet?.optimization_goal, sourceAdSet?.promoted_object);
                const adSetFinalName = newAdSetName
                    .replace(/\{audience\}/g, 'Flex')
                    .replace(/\{hook\}/g, 'Flex')
                    .replace(/\{style\}/g, 'Flex')
                    .replace(/\{filename\}/g, 'Flex')
                    .replace(/\{campaign\}/g, camp.name);

                const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                    name: adSetFinalName,
                    campaignId: camp.id,
                    dailyBudget,
                    bidAmount,
                    bidStrategy: isCboCampaign ? undefined : bidStrategy,
                    bidConstraints: sourceAdSet?.bid_constraints || undefined,
                    billingEvent: (sourceAdSet?.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                    optimizationGoal: delivery.optimizationGoal,
                    targeting: buildDeliveryTargeting(sourceAdSet?.targeting as Record<string, unknown> | undefined),
                    promotedObject: delivery.promotedObject,
                    isDynamicCreative: true,
                    status: 'ACTIVE',
                    startTime: schedule.startTime,
                    endTime: schedule.endTime,
                });
                if (!ar.success || !ar.adSetId) {
                    alert(`Ad set creation failed: ${ar.error}`);
                    setIsUploading(false);
                    return;
                }
                flexAdSetId = ar.adSetId;
                createdFlexAdSetId = ar.adSetId;
            } else {
                // Existing ad set — Flex/DCO creatives need a DCO ad set, so create a sibling.
                const sourceAdSet = browserSelection.adSet;
                if (!sourceAdSet || !browserSelection.campaign) {
                    alert('Select a campaign/ad set to create a flex ad');
                    setIsUploading(false);
                    return;
                }
                const template = await getAdSetById(metaUser.accessToken, sourceAdSet.id);
                const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                    name: `${sourceAdSet.name} · Flex`,
                    campaignId: browserSelection.campaign.id,
                    dailyBudget: template?.dailyBudget,
                    bidAmount: template?.bidAmount,
                    bidStrategy: template?.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
                    billingEvent: (template?.billingEvent || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                    optimizationGoal: template?.optimizationGoal,
                    targeting: template?.targeting || { geo_locations: { countries: ['US'] }, age_min: 18, age_max: 65 },
                    promotedObject: template?.promotedObject,
                    isDynamicCreative: true,
                    status: 'ACTIVE',
                });
                if (!ar.success || !ar.adSetId) {
                    alert(`Flex ad set creation failed: ${ar.error}`);
                    setIsUploading(false);
                    return;
                }
                flexAdSetId = ar.adSetId;
                createdFlexAdSetId = ar.adSetId;
            }

            // Upload local videos (reuse library matches), collect all video IDs
            const flexVideos: { videoId: string; name: string; thumbnailUrl?: string; statusId: string }[] = [];

            for (const file of localVideos) {
                if (wasCancelled(file.id)) { failed++; continue; }
                setStatus(file.id, 'uploading', 10);
                const nameSansExt = file.name.replace(/\.[^/.]+$/, '');
                const existingMatch = cachedVideos.find(ev => {
                    const evTitle = (ev.title || '').toLowerCase();
                    return evTitle === file.name.toLowerCase() || evTitle === nameSansExt.toLowerCase();
                });

                if (existingMatch) {
                    setStatus(file.id, 'uploading', 80);
                    flexVideos.push({
                        videoId: existingMatch.id,
                        name: file.name,
                        thumbnailUrl: existingMatch.picture,
                        statusId: file.id,
                    });
                    setStatus(file.id, 'uploading', 90);
                    continue;
                }

                const uploadResult = await uploadVideoToMeta(
                    selectedAccount.id,
                    metaUser.accessToken,
                    file.file,
                    file.name,
                    (pct) => setStatus(file.id, 'uploading', Math.min(85, pct)),
                    uploadSignal(),
                );
                if (wasCancelled(file.id) || uploadResult.error === 'Cancelled') {
                    setStatus(file.id, 'failed', 100, 'Cancelled');
                    failed++;
                    continue;
                }
                if (!uploadResult.success || !uploadResult.videoId) {
                    setStatus(file.id, 'failed', 100, uploadResult.error || 'Video upload failed');
                    failed++;
                    continue;
                }
                flexVideos.push({
                    videoId: uploadResult.videoId,
                    name: file.name,
                    statusId: file.id,
                });
                setStatus(file.id, 'uploading', 90);
            }

            for (const v of libraryVideos) {
                const statusId = `lib:${v.id}`;
                if (wasCancelled(statusId)) { failed++; continue; }
                setStatus(statusId, 'uploading', 50);
                flexVideos.push({
                    videoId: v.id,
                    name: v.title || `Video ${v.id}`,
                    thumbnailUrl: v.picture,
                    statusId,
                });
            }

            if (flexVideos.length === 0) {
                alert('No videos were ready for the flex ad');
                if (createdFlexAdSetId) await deleteAdSet(metaUser.accessToken, createdFlexAdSetId);
                if (createdFlexCampaignId) await deleteCampaign(metaUser.accessToken, createdFlexCampaignId);
                setIsUploading(false);
                setIsComplete(true);
                return;
            }

            const flexAdName = createNewCampaign
                ? (newCampaignName.trim() || 'Flex Ad')
                : (browserSelection.adSet?.name || browserSelection.campaign?.name || 'Flex Ad');

            const flexResult = await createFlexAdFromVideos(
                selectedAccount.id,
                flexAdSetId!,
                selectedPage.id,
                metaUser.accessToken,
                flexVideos.map(v => ({
                    videoId: v.videoId,
                    name: v.name,
                    thumbnailUrl: v.thumbnailUrl,
                })),
                adSettings,
                `${flexAdName} · Flex (${flexVideos.length})`,
            );

            if (flexResult.success) {
                successful += flexVideos.length;
                for (const v of flexVideos) setStatus(v.statusId, 'success', 100);
            } else {
                failed += flexVideos.length;
                for (const v of flexVideos) setStatus(v.statusId, 'failed', 100, flexResult.error);
                if (createdFlexAdSetId) await deleteAdSet(metaUser.accessToken, createdFlexAdSetId);
                if (createdFlexCampaignId) await deleteCampaign(metaUser.accessToken, createdFlexCampaignId);
            }

            setIsUploading(false);
            setIsComplete(true);
            console.log(`Flex ad complete: ${successful} assets, ${failed} failed`, flexResult);
            return;
        }

        if (uploadMode === 'campaign' && selectedPage) {
            let adSetIdToUse: string | null = null;

            if (createNewCampaign) {
                // The objective is explicit; compatible delivery settings can
                // still be cloned from a selected source ad set.
                const srcCamp = browserSelection.campaign;
                const srcAdSet = browserSelection.adSet;

                const campaignBudgetCents = budgetMode === 'CBO'
                    ? Math.round(parseFloat(campaignDailyBudget) * 100)
                    : undefined;
                const cr = await createCampaign(metaUser.accessToken, selectedAccount.id, {
                    name: newCampaignName.trim(),
                    objective: newCampaignObjective,
                    special_ad_categories: specialAdCategory ? [specialAdCategory] : [],
                    status: 'ACTIVE',
                    dailyBudget: campaignBudgetCents,
                    bidStrategy: budgetMode === 'CBO'
                        ? (srcAdSet?.bid_strategy || srcCamp?.bid_strategy || 'LOWEST_COST_WITHOUT_CAP')
                        : undefined,
                });
                if (!cr.success || !cr.campaignId) { alert(`Campaign creation failed: ${cr.error}`); setIsUploading(false); return; }
                const createdCampaignId = cr.campaignId;
                const createdAdSetIds: string[] = [];

                // Ad set settings cloned from the source ad set; safe defaults otherwise.
                // If the source strategy needs a bid but the source has none, fall back to no-cap.
                const rawBidStrategy = srcAdSet?.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
                const srcBidAmount = srcAdSet?.bid_amount != null && srcAdSet.bid_amount !== '' ? parseInt(srcAdSet.bid_amount) : undefined;
                const needsBidAmount = rawBidStrategy === 'LOWEST_COST_WITH_BID_CAP' || rawBidStrategy === 'COST_CAP';
                const clonedBidStrategy = needsBidAmount && srcBidAmount === undefined ? 'LOWEST_COST_WITHOUT_CAP' : rawBidStrategy;
                const clonedBidAmount = needsBidAmount && srcBidAmount !== undefined ? srcBidAmount : undefined;
                // ABO: budget on each ad set. CBO: omit ad-set budget (lives on campaign).
                const clonedDailyBudget = budgetMode === 'CBO'
                    ? undefined
                    : Math.round(parseFloat(newAdSetBudget) * 100) || (srcAdSet?.daily_budget ? parseInt(srcAdSet.daily_budget) : 5000);

                console.log('New campaign clone params:', {
                    objective: newCampaignObjective, bidStrategy: clonedBidStrategy, bidAmount: clonedBidAmount,
                    budgetMode, campaignBudgetCents, dailyBudget: clonedDailyBudget,
                    specialAdCategory, optimizationGoal: srcAdSet?.optimization_goal,
                });

                // Group files by their resolved ad set name pattern
                const adSetGroups = new Map<string, typeof files>();
                files.forEach((f, i) => {
                    const name = resolveNewCampaignAdSetName(f, i);
                    if (!adSetGroups.has(name)) adSetGroups.set(name, []);
                    adSetGroups.get(name)!.push(f);
                });

                for (const [groupName, groupFiles] of adSetGroups) {
                    // Per-audience overrides keyed by the group's audience tag (mirrors the new-ad-set path)
                    const groupAudience = groupFiles[0]?.audience || '';
                    const delivery = resolveAdSetDelivery(
                        groupAudience,
                        srcAdSet?.optimization_goal,
                        srcAdSet?.promoted_object,
                    );
                    const resolvedPixelId = (groupAudience && pixelMap[groupAudience]) || selectedPixelId;
                    const resolvedPageId = (groupAudience && pageMap[groupAudience])
                        ? pageMap[groupAudience]
                        : selectedPage.id;

                    // Split each group into chunks if enabled
                    const chunkSize = splitAdSets ? Math.max(1, parseInt(adsPerAdSet) || 5) : groupFiles.length;
                    const fileChunks: typeof files[] = [];
                    for (let c = 0; c < groupFiles.length; c += chunkSize) {
                        fileChunks.push(groupFiles.slice(c, c + chunkSize));
                    }

                    for (let ci = 0; ci < fileChunks.length; ci++) {
                        const chunk = fileChunks[ci];
                        const adSetName = fileChunks.length > 1 ? `${groupName} ${ci + 1}` : groupName;
                        const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                            name: adSetName,
                            campaignId: createdCampaignId,
                            dailyBudget: clonedDailyBudget,
                            bidAmount: clonedBidAmount,
                            bidStrategy: budgetMode === 'CBO' ? undefined : clonedBidStrategy,
                            bidConstraints: srcAdSet?.bid_constraints || undefined,
                            billingEvent: (srcAdSet?.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                            optimizationGoal: delivery.optimizationGoal,
                            targeting: buildDeliveryTargeting(srcAdSet?.targeting as Record<string, unknown> | undefined),
                            promotedObject: delivery.promotedObject,
                            isDynamicCreative: false,
                            status: 'ACTIVE',
                            startTime: schedule.startTime,
                            endTime: schedule.endTime,
                        });
                        if (!ar.success || !ar.adSetId) {
                            for (const f of chunk) { setStatus(f.id, 'failed', 100, ar.error || 'Ad set creation failed'); failed++; }
                            continue;
                        }
                        adSetIdToUse = ar.adSetId;
                        createdAdSetIds.push(ar.adSetId);
                        console.log(`Ad Set "${adSetName}": ${chunk.length} files → ${adSetIdToUse} (page ${resolvedPageId}${resolvedPixelId ? `, pixel ${resolvedPixelId}, event ${pixelConversionEvent}` : ''})`);

                        // Per-file upload so each file gets its resolved settings
                        // (per-audience URL override, {audience}/{hook}/{style} tokens, adapted copy)
                        for (const file of chunk) {
                            if (wasCancelled(file.id)) { failed++; continue; }
                            const fileAdSettings = getAdSettingsForFile(file);
                            if (file.type === 'image') {
                                await uploadBatchImagesToMetaAsAds(
                                    selectedAccount.id, adSetIdToUse, resolvedPageId, metaUser.accessToken,
                                    [{ file: file.file, name: file.name }],
                                    fileAdSettings,
                                    (_, pct) => setStatus(file.id, 'uploading', pct),
                                    (_, ok, err?) => { setStatus(file.id, ok ? 'success' : 'failed', 100, err); ok ? successful++ : failed++; },
                                    uploadSignal(),
                                );
                            } else {
                                await uploadBatchToMetaAsAds(
                                    selectedAccount.id, adSetIdToUse, resolvedPageId, metaUser.accessToken,
                                    [{ url: file.file, name: file.name }],
                                    fileAdSettings,
                                    (_, pct) => setStatus(file.id, 'uploading', pct),
                                    (_, ok, err?) => { setStatus(file.id, ok ? 'success' : 'failed', 100, err); ok ? successful++ : failed++; },
                                    cachedVideos,
                                    uploadSignal(),
                                );
                            }
                        }
                    }
                }

                // Library-only (or leftover) videos → create a default ad set if needed, then create ads.
                if (libraryVideos.length > 0) {
                    if (!adSetIdToUse) {
                        const delivery = resolveAdSetDelivery(
                            '',
                            srcAdSet?.optimization_goal,
                            srcAdSet?.promoted_object,
                        );
                        const adSetName = (newCampaignAdSetPattern.trim() || '{campaign} - Ad Set')
                            .replace(/\{campaign\}/g, newCampaignName.trim())
                            .replace(/\{audience\}/g, 'Library')
                            .replace(/\{hook\}/g, 'Library')
                            .replace(/\{style\}/g, 'Library')
                            .replace(/\{filename\}/g, 'Library');
                        const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                            name: adSetName,
                            campaignId: createdCampaignId,
                            dailyBudget: clonedDailyBudget,
                            bidAmount: clonedBidAmount,
                            bidStrategy: budgetMode === 'CBO' ? undefined : clonedBidStrategy,
                            bidConstraints: srcAdSet?.bid_constraints || undefined,
                            billingEvent: (srcAdSet?.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                            optimizationGoal: delivery.optimizationGoal,
                            targeting: buildDeliveryTargeting(srcAdSet?.targeting as Record<string, unknown> | undefined),
                            promotedObject: delivery.promotedObject,
                            isDynamicCreative: false,
                            status: 'ACTIVE',
                            startTime: schedule.startTime,
                            endTime: schedule.endTime,
                        });
                        if (ar.success && ar.adSetId) {
                            adSetIdToUse = ar.adSetId;
                            createdAdSetIds.push(ar.adSetId);
                        } else {
                            for (const v of libraryVideos) {
                                setStatus(`lib:${v.id}`, 'failed', 100, ar.error || 'Ad set creation failed');
                                failed++;
                            }
                        }
                    }
                    if (adSetIdToUse) {
                        await deployLibraryVideos(adSetIdToUse, selectedPage.id);
                    }
                }

                // No ads landed → delete empty ad sets + campaign so failed runs don't litter Ads Manager.
                if (successful === 0) {
                    for (const id of createdAdSetIds) {
                        await deleteAdSet(metaUser.accessToken, id);
                    }
                    const rolled = await deleteCampaign(metaUser.accessToken, createdCampaignId);
                    console.log(rolled.success
                        ? `Rolled back empty campaign ${createdCampaignId}`
                        : `Failed to roll back campaign ${createdCampaignId}: ${rolled.error}`);
                    if (rolled.success) {
                        setUploadStatuses(prev => prev.map(s =>
                            s.status === 'failed' && s.error && !s.error.includes('rolled back')
                                ? { ...s, error: `${s.error} (empty campaign rolled back)` }
                                : s,
                        ));
                    }
                }

            } else if (createNewAdSet && browserSelection.campaign) {
                // Per-file ad set: match existing by name first, create on miss
                const camp = browserSelection.campaign;
                const sourceAdSet = browserSelection.adSet;

                // Explicitly set bid_strategy — clone from source or campaign, default to no-cap
                const bidStrategy = sourceAdSet?.bid_strategy || camp.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
                const isBidCap = bidStrategy === 'LOWEST_COST_WITH_BID_CAP';
                const isCostCap = bidStrategy === 'COST_CAP';
                const needsBidAmount = isBidCap || isCostCap;

                // Budget: skip for CBO campaigns (campaign-level daily_budget). ABO uses source or UI.
                const isCboCampaign = Boolean(camp.daily_budget && camp.daily_budget !== '0');
                const hasDailyBudget = sourceAdSet?.daily_budget != null && sourceAdSet.daily_budget !== '';
                const dailyBudget = isCboCampaign
                    ? undefined
                    : hasDailyBudget
                        ? parseInt(sourceAdSet!.daily_budget!)
                        : Math.round(parseFloat(newAdSetBudget) * 100);

                // Bid: use source value, or UI value if strategy requires it
                const hasBidAmount = sourceAdSet?.bid_amount != null && sourceAdSet.bid_amount !== '';
                const bidAmount = hasBidAmount
                    ? parseInt(sourceAdSet!.bid_amount!)
                    : (needsBidAmount ? Math.round(parseFloat(newAdSetBidAmount) * 100) : undefined);

                console.log('Clone params:', {
                    bidStrategy, needsBidAmount, bidAmount, dailyBudget, isCboCampaign,
                    hasDailyBudget, hasBidAmount, sourceBidRaw: sourceAdSet?.bid_amount,
                    campBidStrategy: camp.bid_strategy, adSetBidStrategy: sourceAdSet?.bid_strategy,
                });

                // NOTE: Never use Dynamic Creative (DCO) ad sets when batch-uploading.
                // Meta API enforces a hard 1-ad-per-ad-set limit on DCO ad sets.
                // Instead, we use standard creatives so multiple ads can coexist.

                // Fetch existing ad sets to match against
                const existingAdSets = await getAdSets(metaUser.accessToken, camp.id);
                console.log('Found', existingAdSets.length, 'existing ad sets in campaign');

                // Group files by their resolved ad set name
                const adSetGroups = new Map<string, typeof files>();
                for (let i = 0; i < files.length; i++) {
                    const name = resolveAdSetName(newAdSetName, files[i], i);
                    if (!adSetGroups.has(name)) adSetGroups.set(name, []);
                    adSetGroups.get(name)!.push(files[i]);
                }

                console.log('Ad set groups:', [...adSetGroups.entries()].map(([name, f]) => `${name}: ${f.length} files`));

                const createdAdSetIds: string[] = [];
                // Track how many ads succeed per newly created ad set so we can roll back empties.
                const createdAdSetSuccessCounts = new Map<string, number>();

                for (const [adSetFinalName, groupFiles] of adSetGroups) {
                    const groupAudience = groupFiles[0]?.audience || '';
                    const delivery = resolveAdSetDelivery(
                        groupAudience,
                        sourceAdSet?.optimization_goal,
                        sourceAdSet?.promoted_object,
                    );
                    const desiredPixelId = (groupAudience && pixelMap[groupAudience]) || selectedPixelId;

                    // Try to match an existing ad set by name (case-insensitive contains)
                    const nameLower = adSetFinalName.toLowerCase();
                    const matchedAdSet = existingAdSets.find(a => {
                        if (!a.name.toLowerCase().includes(nameLower)) return false;
                        if (!isPixelConversionSetup) return true;
                        return a.optimization_goal === 'OFFSITE_CONVERSIONS'
                            && String(a.promoted_object?.pixel_id || '') === desiredPixelId
                            && a.promoted_object?.custom_event_type === pixelConversionEvent;
                    });

                    let justCreatedAdSetId: string | null = null;
                    if (matchedAdSet) {
                        console.log(`Matched "${adSetFinalName}" → existing ad set "${matchedAdSet.name}" (${matchedAdSet.id})`);
                        adSetIdToUse = matchedAdSet.id;
                    } else {
                        // Create one ad set per unique name
                        const adSetParams = {
                            name: adSetFinalName,
                            campaignId: camp.id,
                            dailyBudget,
                            bidAmount,
                            bidStrategy: isCboCampaign ? undefined : bidStrategy,
                            bidConstraints: sourceAdSet?.bid_constraints || undefined,
                            billingEvent: (sourceAdSet?.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                            optimizationGoal: delivery.optimizationGoal,
                            targeting: buildDeliveryTargeting(sourceAdSet?.targeting as Record<string, unknown> | undefined),
                            promotedObject: delivery.promotedObject,
                            isDynamicCreative: false,
                            status: 'ACTIVE' as const,
                            startTime: schedule.startTime,
                            endTime: schedule.endTime,
                        };
                        console.log('Creating ad set:', adSetFinalName, 'for', groupFiles.length, 'files');
                        const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, adSetParams);
                        if (!ar.success || !ar.adSetId) {
                            for (const f of groupFiles) { setStatus(f.id, 'failed', 100, ar.error || 'Ad set creation failed'); failed++; }
                            continue;
                        }
                        adSetIdToUse = ar.adSetId;
                        justCreatedAdSetId = ar.adSetId;
                        createdAdSetIds.push(ar.adSetId);
                        createdAdSetSuccessCounts.set(ar.adSetId, 0);
                    }

                    // Upload all files in this group into the ad set
                    // Resolve per-audience page (falls back to global selectedPage)
                    const groupAudienceForPage = groupFiles[0]?.audience || '';
                    const resolvedPageId = (groupAudienceForPage && pageMap[groupAudienceForPage])
                        ? pageMap[groupAudienceForPage]
                        : selectedPage.id;

                    for (const file of groupFiles) {
                        if (wasCancelled(file.id)) { failed++; continue; }
                        const fileAdSettings = getAdSettingsForFile(file);
                        const onDone = (ok: boolean, err?: string) => {
                            setStatus(file.id, ok ? 'success' : 'failed', 100, err);
                            if (ok) {
                                successful++;
                                if (justCreatedAdSetId) {
                                    createdAdSetSuccessCounts.set(
                                        justCreatedAdSetId,
                                        (createdAdSetSuccessCounts.get(justCreatedAdSetId) || 0) + 1,
                                    );
                                }
                            } else {
                                failed++;
                            }
                        };
                        if (file.type === 'image') {
                            await uploadBatchImagesToMetaAsAds(
                                selectedAccount.id, adSetIdToUse!, resolvedPageId, metaUser.accessToken,
                                [{ file: file.file, name: file.name }],
                                fileAdSettings,
                                (_, pct) => setStatus(file.id, 'uploading', pct),
                                (_, ok, err?) => onDone(ok, err),
                                uploadSignal(),
                            );
                        } else {
                            await uploadBatchToMetaAsAds(
                                selectedAccount.id, adSetIdToUse!, resolvedPageId, metaUser.accessToken,
                                [{ url: file.file, name: file.name }],
                                fileAdSettings,
                                (_, pct) => setStatus(file.id, 'uploading', pct),
                                (_, ok, err?) => onDone(ok, err),
                                cachedVideos,
                                uploadSignal(),
                            );
                        }
                    }
                }

                // Library videos → reuse last ad set, or create one from the pattern when local files weren't selected.
                if (libraryVideos.length > 0) {
                    if (!adSetIdToUse) {
                        const delivery = resolveAdSetDelivery(
                            '',
                            sourceAdSet?.optimization_goal,
                            sourceAdSet?.promoted_object,
                        );
                        const desiredPixelId = selectedPixelId;
                        const adSetFinalName = newAdSetName
                            .replace(/\{audience\}/g, 'Library')
                            .replace(/\{hook\}/g, 'Library')
                            .replace(/\{style\}/g, 'Library')
                            .replace(/\{filename\}/g, 'Library')
                            .replace(/\{campaign\}/g, camp.name);
                        const nameLower = adSetFinalName.toLowerCase();
                        const matchedAdSet = existingAdSets.find(a => {
                            if (!a.name.toLowerCase().includes(nameLower)) return false;
                            if (!isPixelConversionSetup) return true;
                            return a.optimization_goal === 'OFFSITE_CONVERSIONS'
                                && String(a.promoted_object?.pixel_id || '') === desiredPixelId
                                && a.promoted_object?.custom_event_type === pixelConversionEvent;
                        });
                        if (matchedAdSet) {
                            adSetIdToUse = matchedAdSet.id;
                        } else {
                            const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                                name: adSetFinalName,
                                campaignId: camp.id,
                                dailyBudget,
                                bidAmount,
                                bidStrategy: isCboCampaign ? undefined : bidStrategy,
                                bidConstraints: sourceAdSet?.bid_constraints || undefined,
                                billingEvent: (sourceAdSet?.billing_event || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                                optimizationGoal: delivery.optimizationGoal,
                                targeting: buildDeliveryTargeting(sourceAdSet?.targeting as Record<string, unknown> | undefined),
                                promotedObject: delivery.promotedObject,
                                isDynamicCreative: false,
                                status: 'ACTIVE',
                                startTime: schedule.startTime,
                                endTime: schedule.endTime,
                            });
                            if (ar.success && ar.adSetId) {
                                adSetIdToUse = ar.adSetId;
                                createdAdSetIds.push(ar.adSetId);
                                createdAdSetSuccessCounts.set(ar.adSetId, 0);
                            } else {
                                for (const v of libraryVideos) {
                                    setStatus(`lib:${v.id}`, 'failed', 100, ar.error || 'Ad set creation failed');
                                    failed++;
                                }
                            }
                        }
                    }
                    if (adSetIdToUse) {
                        const before = successful;
                        await deployLibraryVideos(adSetIdToUse, selectedPage.id);
                        if (createdAdSetSuccessCounts.has(adSetIdToUse)) {
                            createdAdSetSuccessCounts.set(
                                adSetIdToUse,
                                (createdAdSetSuccessCounts.get(adSetIdToUse) || 0) + (successful - before),
                            );
                        }
                    }
                }

                // Delete any newly created ad sets that ended up with zero successful ads.
                for (const id of createdAdSetIds) {
                    if ((createdAdSetSuccessCounts.get(id) || 0) === 0) {
                        const rolled = await deleteAdSet(metaUser.accessToken, id);
                        console.log(rolled.success
                            ? `Rolled back empty ad set ${id}`
                            : `Failed to roll back ad set ${id}: ${rolled.error}`);
                    }
                }

            } else {
                // Using an existing ad set — split into chunks if enabled
                const baseAdSetId = browserSelection.adSet?.id || null;
                if (!baseAdSetId) { alert('No ad set available'); setIsUploading(false); return; }

                if (splitAdSets && files.length > parseInt(adsPerAdSet)) {
                    // Need to create new ad sets as siblings using the source ad set as template
                    const chunkSize = Math.max(1, parseInt(adsPerAdSet) || 5);
                    const allFiles = [...files];
                    const fileChunks: typeof files[] = [];
                    for (let c = 0; c < allFiles.length; c += chunkSize) {
                        fileChunks.push(allFiles.slice(c, c + chunkSize));
                    }

                    // First chunk uses the selected ad set, rest get new ad sets
                    const sourceAdSet = browserSelection.adSet!;
                    const template = await getAdSetById(metaUser.accessToken, sourceAdSet.id);

                    for (let ci = 0; ci < fileChunks.length; ci++) {
                        const chunk = fileChunks[ci];
                        let chunkAdSetId: string;

                        if (ci === 0) {
                            chunkAdSetId = baseAdSetId;
                        } else {
                            // Create a sibling ad set based on the source
                            const newName = `${sourceAdSet.name} ${ci + 1}`;
                            const ar = await createAdSet(metaUser.accessToken, selectedAccount.id, {
                                name: newName,
                                campaignId: browserSelection.campaign?.id || template?.campaignId || '',
                                dailyBudget: template?.dailyBudget,
                                bidAmount: template?.bidAmount,
                                bidStrategy: template?.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
                                billingEvent: (template?.billingEvent || 'IMPRESSIONS') as 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY',
                                optimizationGoal: template?.optimizationGoal,
                                targeting: template?.targeting || { geo_locations: { countries: ['US'] }, age_min: 18, age_max: 65 },
                                promotedObject: template?.promotedObject,
                                isDynamicCreative: false,
                                status: 'ACTIVE',
                            });
                            if (!ar.success || !ar.adSetId) {
                                for (const f of chunk) { setStatus(f.id, 'failed', 100, ar.error || 'Ad set creation failed'); failed++; }
                                continue;
                            }
                            chunkAdSetId = ar.adSetId;
                            console.log(`Created sibling ad set "${newName}" → ${chunkAdSetId}`);
                        }

                        const chunkImages = chunk.filter(f => f.type === 'image' && !wasCancelled(f.id));
                        const chunkVideos = chunk.filter(f => f.type === 'video' && !wasCancelled(f.id));
                        if (chunkImages.length > 0) {
                            const r = await uploadBatchImagesToMetaAsAds(
                                selectedAccount.id, chunkAdSetId, selectedPage.id, metaUser.accessToken,
                                chunkImages.map(f => ({ file: f.file, name: f.name })),
                                adSettings,
                                (i, pct) => setStatus(chunkImages[i].id, 'uploading', pct),
                                (i, ok, err?) => { setStatus(chunkImages[i].id, ok ? 'success' : 'failed', 100, err); ok ? successful++ : failed++; },
                                uploadSignal(),
                            );
                            successful += r.successful; failed += r.failed;
                        }
                        if (chunkVideos.length > 0) {
                            const r = await uploadBatchToMetaAsAds(
                                selectedAccount.id, chunkAdSetId, selectedPage.id, metaUser.accessToken,
                                chunkVideos.map(f => ({ url: f.file, name: f.name })),
                                adSettings,
                                (i, pct) => setStatus(chunkVideos[i].id, 'uploading', pct),
                                (i, ok, err?) => { setStatus(chunkVideos[i].id, ok ? 'success' : 'failed', 100, err); ok ? successful++ : failed++; },
                                cachedVideos,
                                uploadSignal(),
                            );
                            successful += r.successful; failed += r.failed;
                        }
                    }
                } else {
                    // No splitting — upload all to the selected ad set
                    adSetIdToUse = baseAdSetId;
                    const activeImages = imageFiles.filter(f => !wasCancelled(f.id));
                    const activeVideos = videoFiles.filter(f => !wasCancelled(f.id));
                    if (activeImages.length > 0) {
                        const r = await uploadBatchImagesToMetaAsAds(
                            selectedAccount.id, adSetIdToUse, selectedPage.id, metaUser.accessToken,
                            activeImages.map(f => ({ file: f.file, name: f.name })),
                            adSettings,
                            (i, pct) => setStatus(activeImages[i].id, 'uploading', pct),
                            (i, ok, err?) => { setStatus(activeImages[i].id, ok ? 'success' : 'failed', 100, err); ok ? successful++ : failed++; },
                            uploadSignal(),
                        );
                        successful += r.successful; failed += r.failed;
                    }
                    if (activeVideos.length > 0) {
                        const r = await uploadBatchToMetaAsAds(
                            selectedAccount.id, adSetIdToUse, selectedPage.id, metaUser.accessToken,
                            activeVideos.map(f => ({ url: f.file, name: f.name })),
                            adSettings,
                            (i, pct) => setStatus(activeVideos[i].id, 'uploading', pct),
                            (i, ok, err?) => { setStatus(activeVideos[i].id, ok ? 'success' : 'failed', 100, err); ok ? successful++ : failed++; },
                            cachedVideos,
                            uploadSignal(),
                        );
                        successful += r.successful; failed += r.failed;
                    }
                }

                if (libraryVideos.length > 0) {
                    await deployLibraryVideos(baseAdSetId, selectedPage.id);
                }
            }
        } else {
            // Media library upload (local files only)
            let uploadedVideo = false;
            for (const mf of files) {
                if (wasCancelled(mf.id)) { failed++; continue; }
                setStatus(mf.id, 'uploading', 5);
                if (mf.type === 'image') {
                    const r = await uploadImageToMeta(
                        selectedAccount.id, metaUser.accessToken, mf.file,
                        (pct) => setStatus(mf.id, 'uploading', pct),
                        uploadSignal(),
                    );
                    if (wasCancelled(mf.id) || r.error === 'Cancelled') {
                        setStatus(mf.id, 'failed', 100, 'Cancelled');
                        failed++;
                        continue;
                    }
                    setStatus(mf.id, r.success ? 'success' : 'failed', 100, r.error);
                    r.success ? successful++ : failed++;
                } else {
                    const r = await uploadVideoToMeta(
                        selectedAccount.id, metaUser.accessToken,
                        mf.file, mf.name, (pct) => setStatus(mf.id, 'uploading', pct),
                        uploadSignal(),
                    );
                    if (wasCancelled(mf.id) || r.error === 'Cancelled') {
                        setStatus(mf.id, 'failed', 100, 'Cancelled');
                        failed++;
                        continue;
                    }
                    setStatus(mf.id, r.success ? 'success' : 'failed', 100, r.error);
                    r.success ? successful++ : failed++;
                    if (r.success) uploadedVideo = true;
                }
            }
            if (uploadedVideo) await fetchVideoLibrary();
        }

        uploadAbortRef.current = null;
        setIsUploading(false);
        setIsComplete(true);
        console.log(`Upload complete: ${successful} ok, ${failed} failed`);
    }

    const deployCreativeCount = selectedFiles.length + (uploadMode === 'campaign' ? selectedLibraryVideos.length : 0);
    const flexVideoCount = selectedFiles.filter(f => f.type === 'video').length + selectedLibraryVideos.length;

    const canUpload = (() => {
        if (!metaUser || !selectedAccount) return false;
        if (uploadMode === 'copy') {
            return !!sourceCampaignData && !!destAccount && !!destSelectedPage && !isCopying;
        }
        if (uploadMode === 'library') return selectedFiles.length > 0;
        if (deployCreativeCount === 0) return false;
        if (flexAd && (flexVideoCount === 0 || flexVideoCount > 10)) return false;
        if (!selectedPage) return false;
        if (isPixelConversionSetup && !selectedPixelId) return false;
        if ((createNewCampaign || createNewAdSet) && !adSetStartDate) return false;
        if (createNewCampaign) {
            if (!newCampaignName.trim()) return false;
            const budget = parseFloat(budgetMode === 'CBO' ? campaignDailyBudget : newAdSetBudget);
            return budget > 0;
        }
        if (createNewAdSet) {
            // Any pattern is valid (e.g. "{filename}"), just needs a campaign
            return newAdSetName.length > 0 && !!browserSelection.campaign;
        }
        return !!browserSelection.adSet;
    })();

    function toggleCreativeSelection(fileId: string) {
        const next = new Set(selectedFileIds);
        if (next.has(fileId)) next.delete(fileId);
        else next.add(fileId);
        onSelectionChange(next);
    }

    function selectAllCreatives() {
        onSelectionChange(new Set(files.map(f => f.id)));
    }

    function selectNoneCreatives() {
        onSelectionChange(new Set());
    }

    function toggleLibraryVideoSelection(videoId: string) {
        setSelectedLibraryVideoIds(prev => {
            const next = new Set(prev);
            if (next.has(videoId)) next.delete(videoId);
            else next.add(videoId);
            return next;
        });
    }

    function selectAllLibraryVideos() {
        setSelectedLibraryVideoIds(new Set(existingVideos.map(v => v.id)));
    }

    function selectNoneLibraryVideos() {
        setSelectedLibraryVideoIds(new Set());
    }

    // ── Preview rows ──────────────────────────────────────────────
    interface PreviewRow {
        campaignId: string;
        campaignName: string;
        adSetId: string;
        adSetName: string;
        adName: string;
    }

    const previewRows: PreviewRow[] = (() => {
        if (uploadMode !== 'campaign' || deployCreativeCount === 0) return [];
        const libraryPreviewNames = selectedLibraryVideos.map(v => v.title || `Video ${v.id}`);
        const flexVideoCount = selectedFiles.filter(f => f.type === 'video').length + selectedLibraryVideos.length;

        if (flexAd && flexVideoCount > 0) {
            const adSetName = createNewCampaign
                ? ((newCampaignAdSetPattern.trim() || '{campaign} - Ad Set')
                    .replace(/\{campaign\}/g, newCampaignName.trim() || 'Campaign')
                    .replace(/\{audience\}/g, 'Flex')
                    .replace(/\{hook\}/g, 'Flex')
                    .replace(/\{style\}/g, 'Flex')
                    .replace(/\{filename\}/g, 'Flex'))
                : createNewAdSet
                    ? newAdSetName
                        .replace(/\{audience\}/g, 'Flex')
                        .replace(/\{hook\}/g, 'Flex')
                        .replace(/\{style\}/g, 'Flex')
                        .replace(/\{filename\}/g, 'Flex')
                        .replace(/\{campaign\}/g, browserSelection.campaign?.name || 'Campaign')
                    : (browserSelection.adSet ? `${browserSelection.adSet.name} · Flex` : '(flex ad set)');
            const campaignName = createNewCampaign
                ? (newCampaignName.trim() || '(new campaign)')
                : (browserSelection.campaign?.name || '(campaign)');
            return [{
                campaignId: createNewCampaign ? '(new)' : (browserSelection.campaign?.id || ''),
                campaignName,
                adSetId: '(new)',
                adSetName,
                adName: `Flex Ad (${Math.min(flexVideoCount, 10)} videos)`,
            }];
        }

        if (createNewCampaign) {
            if (!newCampaignName.trim()) return [];
            const fromFiles = selectedFiles.map((f, i) => ({
                campaignId: '(new)',
                campaignName: newCampaignName.trim(),
                adSetId: '(new)',
                adSetName: resolveNewCampaignAdSetName(f, i),
                adName: f.name,
            }));
            const fallbackAdSet = (newCampaignAdSetPattern.trim() || '{campaign} - Ad Set')
                .replace(/\{campaign\}/g, newCampaignName.trim())
                .replace(/\{audience\}/g, 'Library')
                .replace(/\{hook\}/g, 'Library')
                .replace(/\{style\}/g, 'Library')
                .replace(/\{filename\}/g, 'Library');
            const fromLibrary = libraryPreviewNames.map(name => ({
                campaignId: '(new)',
                campaignName: newCampaignName.trim(),
                adSetId: '(new)',
                adSetName: fromFiles[0]?.adSetName || fallbackAdSet,
                adName: name,
            }));
            return [...fromFiles, ...fromLibrary];
        }
        if (!browserSelection.campaign) return [];
        const camp = browserSelection.campaign;
        if (createNewAdSet && browserSelection.campaign) {
            const fromFiles = selectedFiles.map((f, i) => ({
                campaignId: camp.id,
                campaignName: camp.name,
                adSetId: '(new)',
                adSetName: resolveAdSetName(newAdSetName, f, i),
                adName: f.name,
            }));
            const fallbackAdSet = newAdSetName
                .replace(/\{audience\}/g, 'Library')
                .replace(/\{hook\}/g, 'Library')
                .replace(/\{style\}/g, 'Library')
                .replace(/\{filename\}/g, 'Library')
                .replace(/\{campaign\}/g, camp.name);
            const fromLibrary = libraryPreviewNames.map(name => ({
                campaignId: camp.id,
                campaignName: camp.name,
                adSetId: '(new)',
                adSetName: fromFiles[0]?.adSetName || fallbackAdSet,
                adName: name,
            }));
            return [...fromFiles, ...fromLibrary];
        }
        if (!browserSelection.adSet) return [];
        const adSet = browserSelection.adSet;
        return [
            ...selectedFiles.map(f => ({
                campaignId: camp.id,
                campaignName: camp.name,
                adSetId: adSet.id,
                adSetName: adSet.name,
                adName: f.name,
            })),
            ...libraryPreviewNames.map(name => ({
                campaignId: camp.id,
                campaignName: camp.name,
                adSetId: adSet.id,
                adSetName: adSet.name,
                adName: name,
            })),
        ];
    })();

    const successCount = uploadStatuses.filter(s => s.status === 'success').length;
    const failedCount = uploadStatuses.filter(s => s.status === 'failed').length;

    const section = (label: string, children: React.ReactNode) => (
        <div style={{ marginBottom: 16 }}>
            <label className="cyber-label" style={{ display: 'block', marginBottom: 8 }}>{label}</label>
            {children}
        </div>
    );
    const showPreviewDrawer = previewRows.length > 0 && !isUploading && !isComplete;

    const sortedPreviewRows = previewSortKey
        ? [...previewRows].sort((a, b) => {
            const cmp = (a[previewSortKey] ?? '').localeCompare(b[previewSortKey] ?? '');
            return previewSortDir === 'asc' ? cmp : -cmp;
          })
        : previewRows;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            {/* Scrollable config area */}
            <div className="custom-scrollbar scroll-fade" style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingTop: 16, paddingRight: 24, marginRight: -24 }}>
            {/* Meta account removed — connection is managed globally in header */}

            {!metaUser && (
                <div style={{
                    padding: '28px 16px', marginBottom: 16, borderRadius: 14, textAlign: 'center',
                    background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
                }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#ccc', marginBottom: 6 }}>
                        Connect Meta to deploy
                    </div>
                    <div style={{ fontSize: 11, color: '#666', lineHeight: 1.45 }}>
                        Use the connection control in the Uploader header. You can keep adding media on the left while you set up.
                    </div>
                </div>
            )}

            {metaUser && (
                <>
                    {/* Mode toggle */}
                    {section('Upload Destination', (
                        <div className="skeuo-inset" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 16, width: '100%' }}>
                            {(['library', 'campaign', 'copy'] as UploadMode[]).map(mode => (
                                <button
                                    key={mode}
                                    onClick={() => {
                                        setUploadMode(mode);
                                        if (mode === 'campaign') {
                                            setShowVideoLibrary(true);
                                            if (!videoLibraryLoaded && !isLoadingVideos && selectedAccount) {
                                                fetchVideoLibrary();
                                            }
                                        }
                                    }}
                                    className={uploadMode === mode ? 'skeuo-raised' : ''}
                                    style={{
                                        flex: 1,
                                        padding: '10px 14px', fontSize: 12, fontWeight: 700,
                                        borderRadius: 12, border: 'none', cursor: 'pointer',
                                        background: uploadMode === mode ? undefined : 'transparent',
                                        color: uploadMode === mode ? '#FFFFFF' : '#888',
                                        transition: 'all 0.2s',
                                    }}
                                >
                                    {mode === 'library' ? 'Media Library' : mode === 'campaign' ? 'Create Ads' : 'Copy Campaign'}
                                </button>
                            ))}
                        </div>
                    ))}

                    {/* Ad Account */}
                    {section('Ad Account', (
                        adAccounts.length === 0 && !isLoadingAccounts ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ fontSize: 13, color: 'var(--red)', lineHeight: 1.45 }}>
                                    {accountsError || 'No ad accounts found.'}
                                </div>
                                {accountsError?.toLowerCase().includes('too many calls') && (
                                    <div style={{ fontSize: 11, color: '#888', lineHeight: 1.45 }}>
                                        Meta rate-limited this ad account after recent API traffic. Wait a few minutes, then retry — the account itself is fine.
                                    </div>
                                )}
                                <button
                                    type="button"
                                    onClick={() => fetchAdAccounts()}
                                    className="cyber-input"
                                    style={{
                                        width: 'fit-content', cursor: 'pointer',
                                        fontSize: 11, fontWeight: 600, padding: '6px 12px',
                                    }}
                                >
                                    Retry loading accounts
                                </button>
                            </div>
                        ) : (
                            <AdAccountDropdown
                                accounts={adAccounts}
                                selected={selectedAccount}
                                onChange={(a) => {
                                    setSelectedAccount(a);
                                    setExistingVideos([]);
                                    setVideoLibraryLoaded(false);
                                    setShowVideoLibrary(false);
                                    setSelectedLibraryVideoIds(new Set());
                                    setAvailablePixels([]);
                                    setSelectedPixelId('');
                                    setPixelMap({});
                                }}
                                isLoading={isLoadingAccounts}
                            />
                        )
                    ))}

                    {/* Video Library */}
                    {selectedAccount && (
                        <div style={{ marginBottom: 16 }}>
                            <button
                                onClick={() => {
                                    const next = !showVideoLibrary;
                                    setShowVideoLibrary(next);
                                    if (next && !videoLibraryLoaded && !isLoadingVideos) fetchVideoLibrary();
                                }}
                                style={{
                                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '10px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
                                    background: 'rgba(255,255,255,0.03)', color: '#888', fontSize: 12, fontWeight: 600,
                                    transition: 'all 0.15s',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#aaa'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.color = '#888'; }}
                            >
                                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 14 }}>📼</span>
                                    Video Library
                                    {videoLibraryLoaded && (
                                        <span style={{ fontSize: 10, color: '#555', fontWeight: 400 }}>
                                            {uploadMode === 'campaign' && selectedLibraryVideoIds.size > 0
                                                ? `(${selectedLibraryVideoIds.size}/${existingVideos.length})`
                                                : `(${existingVideos.length})`}
                                        </span>
                                    )}
                                </span>
                                <ChevronDown style={{ width: 14, height: 14, transform: showVideoLibrary ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                            </button>
                            {showVideoLibrary && (
                                <div className="animate-fade-in" style={{
                                    marginTop: 8, borderRadius: 12, overflow: 'hidden',
                                    border: '1px solid rgba(255,255,255,0.06)',
                                    background: 'rgba(0,0,0,0.2)',
                                }}>
                                    {isLoadingVideos ? (
                                        <div style={{ padding: 20, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                            <Loader2 className="animate-spin" style={{ width: 14, height: 14, color: '#555' }} />
                                            <span style={{ fontSize: 11, color: '#555' }}>Loading videos...</span>
                                        </div>
                                    ) : existingVideos.length === 0 ? (
                                        <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: '#555' }}>
                                            No videos in this ad account
                                        </div>
                                    ) : (
                                        <>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', gap: 8 }}>
                                                <span style={{ fontSize: 9, color: '#555', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                                    {uploadMode === 'campaign'
                                                        ? `${selectedLibraryVideoIds.size} of ${existingVideos.length} selected`
                                                        : `${existingVideos.length} video${existingVideos.length !== 1 ? 's' : ''} in library`}
                                                </span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    {uploadMode === 'campaign' && (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={selectAllLibraryVideos}
                                                                style={{
                                                                    fontSize: 9, fontWeight: 700, border: 'none', cursor: 'pointer',
                                                                    background: 'transparent', padding: '2px 4px',
                                                                    color: selectedLibraryVideoIds.size === existingVideos.length ? '#0668E1' : '#666',
                                                                }}
                                                            >
                                                                All
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={selectNoneLibraryVideos}
                                                                style={{
                                                                    fontSize: 9, fontWeight: 700, border: 'none', cursor: 'pointer',
                                                                    background: 'transparent', padding: '2px 4px',
                                                                    color: selectedLibraryVideoIds.size === 0 ? '#0668E1' : '#666',
                                                                }}
                                                            >
                                                                None
                                                            </button>
                                                        </>
                                                    )}
                                                    <button
                                                        onClick={() => setVideoLibraryView('grid')}
                                                        title="Grid view"
                                                        style={{
                                                            padding: 4, borderRadius: 4, border: 'none', cursor: 'pointer',
                                                            background: videoLibraryView === 'grid' ? 'rgba(6,104,225,0.15)' : 'transparent',
                                                            color: videoLibraryView === 'grid' ? '#0668E1' : '#555',
                                                            transition: 'all 0.15s', display: 'flex', alignItems: 'center',
                                                        }}
                                                    >
                                                        <LayoutGrid style={{ width: 12, height: 12 }} />
                                                    </button>
                                                    <button
                                                        onClick={() => setVideoLibraryView('list')}
                                                        title="List view"
                                                        style={{
                                                            padding: 4, borderRadius: 4, border: 'none', cursor: 'pointer',
                                                            background: videoLibraryView === 'list' ? 'rgba(6,104,225,0.15)' : 'transparent',
                                                            color: videoLibraryView === 'list' ? '#0668E1' : '#555',
                                                            transition: 'all 0.15s', display: 'flex', alignItems: 'center',
                                                        }}
                                                    >
                                                        <List style={{ width: 12, height: 12 }} />
                                                    </button>
                                                    <button
                                                        onClick={fetchVideoLibrary}
                                                        title="Refresh"
                                                        style={{ padding: 4, borderRadius: 4, border: 'none', background: 'transparent', color: '#555', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                                                    >
                                                        <RotateCcw style={{ width: 10, height: 10 }} />
                                                    </button>
                                                </div>
                                            </div>
                                            {uploadMode === 'campaign' && (
                                                <div style={{ padding: '6px 12px', fontSize: 10, color: '#666', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                                    Click videos to include them in the campaign
                                                </div>
                                            )}
                                            <div className="custom-scrollbar" style={{ maxHeight: 320, overflowY: 'auto', padding: videoLibraryView === 'grid' ? 8 : 0 }}>
                                                {videoLibraryView === 'grid' ? (
                                                    /* ── Grid View ── */
                                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                                                        {existingVideos.map(v => {
                                                            const thumb = v.picture;
                                                            const isSelected = selectedLibraryVideoIds.has(v.id);
                                                            const selectable = uploadMode === 'campaign';
                                                            const duration = v.length ? `${Math.floor(v.length / 60)}:${String(Math.floor(v.length % 60)).padStart(2, '0')}` : null;
                                                            return (
                                                                <div
                                                                    key={v.id}
                                                                    onClick={() => selectable && toggleLibraryVideoSelection(v.id)}
                                                                    style={{
                                                                        position: 'relative', borderRadius: 8, overflow: 'hidden',
                                                                        aspectRatio: '9/16',
                                                                        background: '#0A0A0A',
                                                                        border: isSelected
                                                                            ? '2px solid #0668E1'
                                                                            : '1px solid rgba(255,255,255,0.06)',
                                                                        cursor: selectable ? 'pointer' : 'default',
                                                                        boxShadow: isSelected ? '0 0 0 1px rgba(6,104,225,0.35)' : undefined,
                                                                    }}
                                                                    title={v.title || '(untitled)'}
                                                                >
                                                                    {thumb ? (
                                                                        <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                                                    ) : (
                                                                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: 22 }}>🎬</div>
                                                                    )}
                                                                    {selectable && (
                                                                        <div style={{
                                                                            position: 'absolute', top: 6, left: 6,
                                                                            width: 18, height: 18, borderRadius: 5,
                                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                                            background: isSelected ? '#0668E1' : 'rgba(0,0,0,0.55)',
                                                                            border: isSelected ? 'none' : '1px solid rgba(255,255,255,0.25)',
                                                                        }}>
                                                                            {isSelected && <Check style={{ width: 11, height: 11, color: '#fff' }} />}
                                                                        </div>
                                                                    )}
                                                                    <div style={{
                                                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                                                        background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
                                                                        padding: '16px 6px 5px',
                                                                    }}>
                                                                        <div style={{
                                                                            fontSize: 9, fontWeight: 600, color: isSelected ? '#E5F0FF' : '#ddd',
                                                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                                            lineHeight: '1.3',
                                                                        }}>
                                                                            {v.title || '(untitled)'}
                                                                        </div>
                                                                        {duration && (
                                                                            <div style={{ fontSize: 8, color: '#888', marginTop: 1 }}>{duration}</div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    /* ── List View ── */
                                                    existingVideos.map(v => {
                                                        const thumb = v.picture;
                                                        const isSelected = selectedLibraryVideoIds.has(v.id);
                                                        const selectable = uploadMode === 'campaign';
                                                        const duration = v.length ? `${Math.floor(v.length / 60)}:${String(Math.floor(v.length % 60)).padStart(2, '0')}` : null;
                                                        return (
                                                            <div
                                                                key={v.id}
                                                                onClick={() => selectable && toggleLibraryVideoSelection(v.id)}
                                                                style={{
                                                                    display: 'flex', alignItems: 'center', gap: 10,
                                                                    padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.025)',
                                                                    background: isSelected ? 'rgba(6,104,225,0.12)' : 'transparent',
                                                                    cursor: selectable ? 'pointer' : 'default',
                                                                }}
                                                            >
                                                                {selectable && (
                                                                    <div style={{
                                                                        width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                                        background: isSelected ? '#0668E1' : 'rgba(255,255,255,0.04)',
                                                                        border: isSelected ? 'none' : '1px solid rgba(255,255,255,0.15)',
                                                                    }}>
                                                                        {isSelected && <Check style={{ width: 12, height: 12, color: '#fff' }} />}
                                                                    </div>
                                                                )}
                                                                <div style={{
                                                                    width: 40, height: 40, borderRadius: 6, overflow: 'hidden',
                                                                    background: '#111', flexShrink: 0,
                                                                    border: isSelected ? '1px solid rgba(6,104,225,0.5)' : '1px solid rgba(255,255,255,0.06)',
                                                                }}>
                                                                    {thumb ? (
                                                                        <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                                                    ) : (
                                                                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: 16 }}>🎬</div>
                                                                    )}
                                                                </div>
                                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                                    <div style={{
                                                                        fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                                        color: isSelected ? '#E5F0FF' : '#ccc',
                                                                    }} title={v.title}>
                                                                        {v.title || '(untitled)'}
                                                                    </div>
                                                                    <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                                                                        {duration && <span style={{ fontSize: 9, color: '#555' }}>{duration}</span>}
                                                                        <span style={{ fontSize: 9, color: '#444', fontFamily: 'var(--font-mono)' }}>{v.id}</span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Copy Campaign mode */}
                    {uploadMode === 'copy' && selectedAccount && (
                        <>
                            {/* Source: uses existing ad account as source */}
                            <div style={{ marginBottom: 16 }}>
                                <label className="cyber-label" style={{ display: 'block', marginBottom: 8, color: '#555' }}>Source Account</label>
                                <div style={{ fontSize: 12, color: '#ccc', padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                    {selectedAccount.name}
                                </div>
                            </div>

                            <div style={{ marginBottom: 20 }}>
                                <InlineAdBrowser
                                    metaUser={metaUser}
                                    adAccount={selectedAccount}
                                    onSelectionChange={handleBrowserSelectionChange}
                                    selectionOnly
                                    createNewCampaign={false}
                                    onCreateNewCampaignChange={() => {}}
                                    newCampaignName=""
                                    onNewCampaignNameChange={() => {}}
                                    createNewAdSet={false}
                                    onCreateNewAdSetChange={() => {}}
                                    newAdSetName=""
                                    onNewAdSetNameChange={() => {}}
                                    newAdSetBudget=""
                                    onNewAdSetBudgetChange={() => {}}
                                    newAdSetBidAmount=""
                                    onNewAdSetBidAmountChange={() => {}}
                                />
                            </div>

                            {/* Campaign tree summary */}
                            {isLoadingCampaignData && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderRadius: 10, background: 'rgba(6,104,225,0.05)', border: '1px solid rgba(6,104,225,0.15)', marginBottom: 16 }}>
                                    <Loader2 className="animate-spin" style={{ width: 14, height: 14, color: '#0668E1' }} />
                                    <span style={{ fontSize: 11, color: '#888' }}>Loading campaign structure...</span>
                                </div>
                            )}
                            {sourceCampaignData && !isLoadingCampaignData && (
                                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(48,209,88,0.04)', border: '1px solid rgba(48,209,88,0.15)', marginBottom: 16 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#30D158', marginBottom: 6 }}>
                                        ✓ Campaign loaded
                                    </div>
                                    <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888' }}>
                                        <span>{sourceCampaignData.adSets.length} ad set{sourceCampaignData.adSets.length !== 1 ? 's' : ''}</span>
                                        <span>{sourceCampaignData.adSets.reduce((s, a) => s + a.ads.length, 0)} ad{sourceCampaignData.adSets.reduce((s, a) => s + a.ads.length, 0) !== 1 ? 's' : ''}</span>
                                    </div>
                                </div>
                            )}

                            {/* Destination — same account allowed (duplicate in place) */}
                            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 16, marginBottom: 16 }}>
                                <label className="cyber-label" style={{ display: 'block', marginBottom: 8, color: '#E5F0FF' }}>
                                    Destination Account
                                </label>
                                {adAccounts.length === 0 ? (
                                    <div style={{ fontSize: 13, color: 'var(--red)' }}>No ad accounts found.</div>
                                ) : (
                                    <AdAccountDropdown
                                        accounts={adAccounts}
                                        selected={destAccount}
                                        onChange={(a) => { setDestAccount(a); setDestSelectedPage(null); }}
                                        isLoading={isLoadingAccounts}
                                    />
                                )}
                                {destAccount && selectedAccount && destAccount.id === selectedAccount.id && (
                                    <div style={{ fontSize: 10, color: '#666', marginTop: 6, lineHeight: 1.4 }}>
                                        Same as source — creates a duplicate named “… (Copy)” in this account.
                                    </div>
                                )}
                            </div>

                            {/* Destination Page */}
                            {destAccount && (
                                <div style={{ marginBottom: 16 }}>
                                    <label className="cyber-label" style={{ display: 'block', marginBottom: 8 }}>Destination Page</label>
                                    {isLoadingDestPages ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8 }}>
                                            <Loader2 className="animate-spin" style={{ width: 14, height: 14, color: '#0668E1' }} />
                                            <span style={{ fontSize: 11, color: '#888' }}>Loading pages...</span>
                                        </div>
                                    ) : (
                                        <PageSelector pages={destPages} selectedPage={destSelectedPage} onChange={setDestSelectedPage} isLoading={false} />
                                    )}
                                </div>
                            )}

                            {/* Destination Pixel */}
                            {destAccount && destPixels.length > 0 && (
                                <div style={{ marginBottom: 16 }}>
                                    <label className="cyber-label" style={{ display: 'block', marginBottom: 8 }}>Destination Pixel</label>
                                    <select
                                        value={destSelectedPixel}
                                        onChange={(e) => setDestSelectedPixel(e.target.value)}
                                        className="cyber-input"
                                        style={{ width: '100%', fontSize: 12, cursor: 'pointer' }}
                                    >
                                        <option value="">No pixel</option>
                                        {destPixels.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* Copy progress */}
                            {isCopying && copyProgress && (
                                <div style={{ padding: 16, borderRadius: 12, background: 'rgba(6,104,225,0.05)', border: '1px solid rgba(6,104,225,0.15)', marginBottom: 16 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                        <Loader2 className="animate-spin" style={{ width: 14, height: 14, color: '#0668E1' }} />
                                        <span style={{ fontSize: 11, color: '#E5F0FF', fontWeight: 600 }}>{copyProgress.message}</span>
                                    </div>
                                    {copyProgress.total > 0 && (
                                        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                                            <div style={{
                                                height: '100%', borderRadius: 2,
                                                background: 'linear-gradient(90deg, #0668E1, #30D158)',
                                                width: `${(copyProgress.current / copyProgress.total) * 100}%`,
                                                transition: 'width 0.3s ease',
                                            }} />
                                        </div>
                                    )}
                                    <div style={{ fontSize: 10, color: '#555', marginTop: 6 }}>
                                        {copyProgress.current} / {copyProgress.total} ads
                                    </div>
                                </div>
                            )}

                            {/* Copy result */}
                            {copyResult && !isCopying && (
                                <div style={{
                                    padding: 16, borderRadius: 12, marginBottom: 16,
                                    background: copyResult.success ? 'rgba(48,209,88,0.06)' : 'rgba(255,69,58,0.06)',
                                    border: `1px solid ${copyResult.success ? 'rgba(48,209,88,0.2)' : 'rgba(255,69,58,0.2)'}`,
                                }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: copyResult.success ? '#30D158' : '#FF453A' }}>
                                        {copyResult.success ? '✓ Campaign copied successfully' : '✗ Copy completed with errors'}
                                    </div>
                                    <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888' }}>
                                        <span>{copyResult.stats.adSets} ad sets</span>
                                        <span>{copyResult.stats.ads} ads</span>
                                        {copyResult.stats.failed > 0 && <span style={{ color: '#FF9F0A' }}>{copyResult.stats.failed} failed</span>}
                                    </div>
                                    {copyResult.error && (
                                        <div style={{ fontSize: 11, color: '#FF8A80', marginTop: 8, lineHeight: 1.45 }}>
                                            {copyResult.error}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {/* Campaign mode extras */}
                    {uploadMode === 'campaign' && selectedAccount && (
                        <>
                            <div style={{ marginBottom: 20 }}>
                                <InlineAdBrowser
                                    metaUser={metaUser}
                                    adAccount={selectedAccount}
                                    onSelectionChange={handleBrowserSelectionChange}
                                    createNewCampaign={createNewCampaign}
                                    onCreateNewCampaignChange={setCreateNewCampaign}
                                    newCampaignName={newCampaignName}
                                    onNewCampaignNameChange={setNewCampaignName}
                                    newCampaignAdSetPattern={newCampaignAdSetPattern}
                                    onNewCampaignAdSetPatternChange={setNewCampaignAdSetPattern}
                                    createNewAdSet={createNewAdSet}
                                    onCreateNewAdSetChange={setCreateNewAdSet}
                                    newAdSetName={newAdSetName}
                                    onNewAdSetNameChange={setNewAdSetName}
                                    newAdSetBudget={newAdSetBudget}
                                    onNewAdSetBudgetChange={setNewAdSetBudget}
                                    newAdSetBidAmount={newAdSetBidAmount}
                                    onNewAdSetBidAmountChange={setNewAdSetBidAmount}
                                    onPixelsLoaded={(pixels) => {
                                        setAvailablePixels(pixels);
                                        setSelectedPixelId(current =>
                                            pixels.some(pixel => pixel.id === current) ? current : '',
                                        );
                                    }}
                                />
                            </div>

                            {(createNewCampaign || createNewAdSet) && section('Campaign Delivery', (
                                <div
                                    className="skeuo-inset"
                                    style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}
                                >
                                    <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: isPixelConversionSetup
                                            ? 'repeat(3, minmax(0, 1fr))'
                                            : 'minmax(0, 1fr)',
                                        gap: 10,
                                    }}>
                                        <div>
                                            <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                                {createNewCampaign ? 'Objective' : 'Objective (Campaign)'}
                                            </label>
                                            <select
                                                value={deliveryObjective || ''}
                                                disabled={!createNewCampaign}
                                                onChange={(event) => setNewCampaignObjective(event.target.value as CampaignObjective)}
                                                className="cyber-input"
                                                style={{
                                                    width: '100%',
                                                    cursor: createNewCampaign ? 'pointer' : 'default',
                                                    opacity: createNewCampaign ? 1 : 0.7,
                                                }}
                                            >
                                                {deliveryObjective && !CAMPAIGN_OBJECTIVES.some(item => item.value === deliveryObjective) && (
                                                    <option value={deliveryObjective}>{deliveryObjective}</option>
                                                )}
                                                {CAMPAIGN_OBJECTIVES.map(objective => (
                                                    <option key={objective.value} value={objective.value}>
                                                        {objective.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>

                                        {isPixelConversionSetup && (
                                            <>
                                                <div>
                                                    <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                                        Meta Pixel
                                                    </label>
                                                    <select
                                                        value={selectedPixelId}
                                                        onChange={(event) => setSelectedPixelId(event.target.value)}
                                                        className="cyber-input"
                                                        style={{ width: '100%', cursor: 'pointer' }}
                                                    >
                                                        <option value="">
                                                            {availablePixels.length > 0 ? 'Select pixel…' : 'No pixels found'}
                                                        </option>
                                                        {availablePixels.map(pixel => (
                                                            <option key={pixel.id} value={pixel.id}>
                                                                {pixel.name} ({pixel.id})
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>

                                                <div>
                                                    <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                                        Pixel Goal
                                                    </label>
                                                    <select
                                                        value={pixelConversionEvent}
                                                        onChange={(event) => setPixelConversionEvent(event.target.value as PixelConversionEvent)}
                                                        className="cyber-input"
                                                        style={{ width: '100%', cursor: 'pointer' }}
                                                    >
                                                        {PIXEL_CONVERSION_EVENTS.map(event => (
                                                            <option key={event.value} value={event.value}>
                                                                {event.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                            </>
                                        )}
                                    </div>

                                    {/* Budget + Special Ad Category (new campaign) */}
                                    {createNewCampaign && (
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                                            gap: 10,
                                        }}>
                                            <div>
                                                <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                                    Budget type
                                                </label>
                                                <select
                                                    value={budgetMode}
                                                    onChange={(e) => setBudgetMode(e.target.value as BudgetMode)}
                                                    className="cyber-input"
                                                    style={{ width: '100%', cursor: 'pointer' }}
                                                >
                                                    <option value="ABO">ABO — Ad set budget</option>
                                                    <option value="CBO">CBO — Campaign daily budget</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                                    Special ad category
                                                </label>
                                                <select
                                                    value={specialAdCategory}
                                                    onChange={(e) => setSpecialAdCategory(e.target.value as SpecialAdCategory)}
                                                    className="cyber-input"
                                                    style={{ width: '100%', cursor: 'pointer' }}
                                                >
                                                    {SPECIAL_AD_CATEGORIES.map(cat => (
                                                        <option key={cat.value || 'none'} value={cat.value}>
                                                            {cat.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                                    {budgetMode === 'CBO' ? 'Campaign daily budget' : 'Ad set daily budget'}
                                                </label>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <span style={{ fontSize: 12, color: '#888', fontWeight: 600 }}>$</span>
                                                    <input
                                                        type="number"
                                                        min="1"
                                                        step="0.01"
                                                        value={budgetMode === 'CBO' ? campaignDailyBudget : newAdSetBudget}
                                                        onChange={(e) => budgetMode === 'CBO'
                                                            ? setCampaignDailyBudget(e.target.value)
                                                            : setNewAdSetBudget(e.target.value)}
                                                        className="cyber-input"
                                                        style={{ width: 120 }}
                                                    />
                                                    <span style={{ fontSize: 11, color: '#666' }}>USD / day</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Schedule — both new campaign and new ad set */}
                                    <div>
                                        <label className="cyber-label" style={{ display: 'block', marginBottom: 7 }}>
                                            Schedule
                                        </label>
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                                            gap: 10,
                                        }}>
                                            <div>
                                                <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Start date</div>
                                                <input
                                                    type="date"
                                                    value={adSetStartDate}
                                                    onChange={(e) => setAdSetStartDate(e.target.value)}
                                                    className="cyber-input"
                                                    style={{ width: '100%' }}
                                                />
                                            </div>
                                            <div>
                                                <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Start time</div>
                                                <input
                                                    type="time"
                                                    value={adSetStartTime}
                                                    onChange={(e) => setAdSetStartTime(e.target.value)}
                                                    className="cyber-input"
                                                    style={{ width: '100%' }}
                                                />
                                            </div>
                                            <div>
                                                <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>End date (optional)</div>
                                                <input
                                                    type="date"
                                                    value={adSetEndDate}
                                                    onChange={(e) => setAdSetEndDate(e.target.value)}
                                                    className="cyber-input"
                                                    style={{ width: '100%' }}
                                                />
                                            </div>
                                            <div>
                                                <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>End time</div>
                                                <input
                                                    type="time"
                                                    value={adSetEndTime}
                                                    onChange={(e) => setAdSetEndTime(e.target.value)}
                                                    disabled={!adSetEndDate}
                                                    className="cyber-input"
                                                    style={{ width: '100%', opacity: adSetEndDate ? 1 : 0.5 }}
                                                />
                                            </div>
                                        </div>
                                        <div style={{ fontSize: 10, color: '#666', marginTop: 6, lineHeight: 1.4 }}>
                                            Times use the ad account timezone: {accountTimeZone.replace(/_/g, ' ')}
                                            {adSetEndDate ? '' : ' · Leave end date empty for no end date'}
                                        </div>
                                    </div>

                                    {/* Exclude US states */}
                                    <div>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                                            <label className="cyber-label" style={{ margin: 0 }}>
                                                Exclude US states
                                            </label>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <button
                                                    type="button"
                                                    onClick={() => setExcludedStates(US_STATES.map(s => s.code))}
                                                    style={{
                                                        background: 'none', border: 'none', padding: 0,
                                                        fontSize: 10, color: '#6DB3F8', cursor: 'pointer', fontWeight: 600,
                                                    }}
                                                >
                                                    Exclude all
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setExcludedStates([])}
                                                    style={{
                                                        background: 'none', border: 'none', padding: 0,
                                                        fontSize: 10, color: '#888', cursor: 'pointer', fontWeight: 600,
                                                    }}
                                                >
                                                    Clear
                                                </button>
                                            </div>
                                        </div>
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                                            gap: 4,
                                            maxHeight: 160,
                                            overflowY: 'auto',
                                            padding: 8,
                                            borderRadius: 8,
                                            background: 'rgba(0,0,0,0.25)',
                                            border: '1px solid rgba(255,255,255,0.06)',
                                        }}>
                                            {US_STATES.map(state => {
                                                const checked = excludedStates.includes(state.code);
                                                return (
                                                    <label
                                                        key={state.code}
                                                        style={{
                                                            display: 'flex', alignItems: 'center', gap: 6,
                                                            fontSize: 11, color: checked ? '#E5F0FF' : '#888',
                                                            cursor: 'pointer', padding: '2px 4px',
                                                        }}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={checked}
                                                            onChange={() => toggleExcludedState(state.code)}
                                                            style={{ accentColor: '#0668E1' }}
                                                        />
                                                        {state.code}
                                                    </label>
                                                );
                                            })}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#666', marginTop: 6, lineHeight: 1.4 }}>
                                            {excludedStates.length > 0
                                                ? `Includes the other ${50 - excludedStates.length} US states (sent as inclusions — SAC-safe)`
                                                : 'Targeting is all of US · no state exclusions'}
                                            {' · '}placements: Facebook + Instagram only
                                        </div>
                                    </div>

                                    <div style={{ fontSize: 10, color: isPixelConversionSetup ? '#6DB3F8' : '#666', lineHeight: 1.5 }}>
                                        {isPixelConversionSetup
                                            ? `Ad sets will optimize for OFFSITE_CONVERSIONS using ${pixelConversionEvent}.`
                                            : 'This objective does not require a Meta Pixel.'}
                                    </div>
                                </div>
                            ))}

                            {/* Per-audience pixel mapping */}
                            {isPixelConversionSetup && availablePixels.length > 0 && (() => {
                                const audiences = [...new Set(selectedFiles.map(f => f.audience).filter(Boolean))] as string[];
                                if (audiences.length === 0) return null;
                                return section('Pixel Mapping', (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>
                                            Optional audience overrides. Leave blank to use the default pixel selected above.
                                        </div>
                                        {audiences.map(audience => (
                                            <div key={audience} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <span style={{
                                                    minWidth: 100, fontSize: 12, fontWeight: 600,
                                                    color: '#E5F0FF', whiteSpace: 'nowrap', overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                }}>{audience}</span>
                                                <select
                                                    value={pixelMap[audience] || ''}
                                                    onChange={(e) => setPixelMap(prev => ({
                                                        ...prev,
                                                        [audience]: e.target.value,
                                                    }))}
                                                    className="cyber-input"
                                                    style={{ flex: 1, fontSize: 11, cursor: 'pointer', padding: '6px 10px' }}
                                                >
                                                    <option value="">Default pixel</option>
                                                    {availablePixels.map(p => (
                                                        <option key={p.id} value={p.id}>
                                                            {p.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        ))}
                                        {/* Bulk-set all */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4,
                                            paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                            <span style={{ minWidth: 100, fontSize: 10, color: '#555', fontWeight: 700,
                                                textTransform: 'uppercase', letterSpacing: '0.06em' }}>Set all →</span>
                                            <select
                                                value=""
                                                onChange={(e) => {
                                                    const pixelId = e.target.value === '__default__' ? '' : e.target.value;
                                                    const bulk: Record<string, string> = {};
                                                    for (const a of audiences) bulk[a] = pixelId;
                                                    setPixelMap(bulk);
                                                }}
                                                className="cyber-input"
                                                style={{ flex: 1, fontSize: 11, cursor: 'pointer', padding: '6px 10px' }}
                                            >
                                                <option value="" disabled>Set all pixels…</option>
                                                <option value="__default__">Default pixel (all)</option>
                                                {availablePixels.map(p => (
                                                    <option key={p.id} value={p.id}>
                                                        {p.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                ));
                            })()}
                            {/* Per-audience URL mapping */}
                            {(createNewAdSet || createNewCampaign) && (() => {
                                const audiences = [...new Set(selectedFiles.map(f => f.audience).filter(Boolean))] as string[];
                                if (audiences.length < 2) return null;
                                return section('Link per Audience', (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>
                                            Set a unique URL per audience. Leave empty to use the global Website URL.
                                        </div>
                                        {audiences.map(audience => (
                                            <div key={audience} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <span style={{
                                                    minWidth: 100, fontSize: 12, fontWeight: 600,
                                                    color: '#E5F0FF', whiteSpace: 'nowrap', overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                }}>{audience}</span>
                                                <input
                                                    type="text"
                                                    value={urlMap[audience] || ''}
                                                    onChange={(e) => setUrlMap(prev => ({
                                                        ...prev,
                                                        [audience]: e.target.value,
                                                    }))}
                                                    placeholder="https://track.domain.com/click?campaign=..."
                                                    className="cyber-input"
                                                    style={{ flex: 1, fontSize: 11, padding: '6px 10px' }}
                                                />
                                            </div>
                                        ))}
                                        {/* Bulk-paste */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4,
                                            paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                            <span style={{ minWidth: 100, fontSize: 10, color: '#555', fontWeight: 700,
                                                textTransform: 'uppercase', letterSpacing: '0.06em' }}>Set all →</span>
                                            <input
                                                type="text"
                                                placeholder="Paste URL for all audiences"
                                                className="cyber-input"
                                                style={{ flex: 1, fontSize: 11, padding: '6px 10px' }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        const url = (e.target as HTMLInputElement).value;
                                                        const bulk: Record<string, string> = {};
                                                        for (const a of audiences) bulk[a] = url;
                                                        setUrlMap(bulk);
                                                        (e.target as HTMLInputElement).value = '';
                                                    }
                                                }}
                                                onBlur={(e) => {
                                                    const url = e.target.value;
                                                    if (url) {
                                                        const bulk: Record<string, string> = {};
                                                        for (const a of audiences) bulk[a] = url;
                                                        setUrlMap(bulk);
                                                        e.target.value = '';
                                                    }
                                                }}
                                            />
                                        </div>
                                    </div>
                                ));
                            })()}
                            {/* Facebook Page — per-audience when creating new ad sets */}
                            {(() => {
                                const audiences = (createNewAdSet || createNewCampaign)
                                    ? [...new Set(selectedFiles.map(f => f.audience).filter(Boolean))] as string[]
                                    : [];

                                // Per-audience page mapping
                                if (audiences.length > 1 && pages.length > 0) {
                                    return section('Page per Audience', (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                            <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>
                                                Assign a Facebook Page to each audience. Default uses the page selected above.
                                            </div>
                                            {/* Default page selector */}
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 8,
                                                borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                                                <span style={{ minWidth: 100, fontSize: 10, color: '#555', fontWeight: 700,
                                                    textTransform: 'uppercase', letterSpacing: '0.06em' }}>Default</span>
                                                <div style={{ flex: 1 }}>
                                                    <PageSelector pages={pages} selectedPage={selectedPage} onChange={setSelectedPage} isLoading={isLoadingPages} />
                                                </div>
                                            </div>
                                            {audiences.map(audience => {
                                                const mappedPageId = pageMap[audience] || '';
                                                return (
                                                    <div key={audience} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                        <span style={{
                                                            minWidth: 100, fontSize: 12, fontWeight: 600,
                                                            color: '#E5F0FF', whiteSpace: 'nowrap', overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                        }}>{audience}</span>
                                                        <select
                                                            value={mappedPageId}
                                                            onChange={(e) => setPageMap(prev => ({
                                                                ...prev,
                                                                [audience]: e.target.value,
                                                            }))}
                                                            className="cyber-input"
                                                            style={{ flex: 1, fontSize: 11, cursor: 'pointer', padding: '6px 10px' }}
                                                        >
                                                            <option value="">Default page{selectedPage ? ` (${selectedPage.name})` : ''}</option>
                                                            {pages.map(p => (
                                                                <option key={p.id} value={p.id}>
                                                                    {p.name}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                );
                                            })}
                                            {/* Bulk-set all */}
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4,
                                                paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                                <span style={{ minWidth: 100, fontSize: 10, color: '#555', fontWeight: 700,
                                                    textTransform: 'uppercase', letterSpacing: '0.06em' }}>Set all →</span>
                                                <select
                                                    value=""
                                                    onChange={(e) => {
                                                        const pageId = e.target.value;
                                                        const bulk: Record<string, string> = {};
                                                        for (const a of audiences) bulk[a] = pageId;
                                                        setPageMap(bulk);
                                                    }}
                                                    className="cyber-input"
                                                    style={{ flex: 1, fontSize: 11, cursor: 'pointer', padding: '6px 10px' }}
                                                >
                                                    <option value="">Choose page...</option>
                                                    <option value="">Default page (all)</option>
                                                    {pages.map(p => (
                                                        <option key={p.id} value={p.id}>
                                                            {p.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>
                                    ));
                                }

                                // Single page selector (default / no audiences)
                                return section('Facebook Page', (
                                    pages.length === 0 && !isLoadingPages ? (
                                        <div style={{ fontSize: 13, color: 'var(--red)' }}>No Facebook Pages found.</div>
                                    ) : (
                                        <PageSelector pages={pages} selectedPage={selectedPage} onChange={setSelectedPage} isLoading={isLoadingPages} />
                                    )
                                ));
                            })()}

                            {/* Split into Ad Sets */}
                            {selectedFiles.length > 1 && (
                                <div style={{
                                    borderTop: '1px solid var(--border-soft)', paddingTop: 16, marginBottom: 16,
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: splitAdSets ? 12 : 0 }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={splitAdSets}
                                                onChange={(e) => setSplitAdSets(e.target.checked)}
                                                style={{ accentColor: '#0668E1', width: 14, height: 14 }}
                                            />
                                            <span style={{ fontSize: 12, fontWeight: 600, color: splitAdSets ? '#E5F0FF' : '#888' }}>
                                                Split into multiple ad sets
                                            </span>
                                        </label>
                                    </div>
                                    {splitAdSets && (
                                        <div className="animate-fade-in" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <span style={{ fontSize: 11, color: '#888' }}>Ads per ad set</span>
                                            <input
                                                type="number"
                                                min="1"
                                                max="50"
                                                value={adsPerAdSet}
                                                onChange={(e) => setAdsPerAdSet(e.target.value)}
                                                className="cyber-input"
                                                style={{ width: 60, textAlign: 'center', fontSize: 13, fontWeight: 700, padding: '6px 8px' }}
                                            />
                                            <span style={{ fontSize: 10, color: '#555', fontStyle: 'italic' }}>
                                                → {Math.ceil(selectedFiles.length / Math.max(1, parseInt(adsPerAdSet) || 1))} ad set{Math.ceil(selectedFiles.length / Math.max(1, parseInt(adsPerAdSet) || 1)) !== 1 ? 's' : ''} for {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Ad format: Standard (default) or optional Flex Ad */}
                            <div style={{
                                borderTop: '1px solid var(--border-soft)', paddingTop: 16, marginBottom: 16,
                            }}>
                                <label className="cyber-label" style={{ display: 'block', marginBottom: 8 }}>Ad Format</label>
                                <div className="skeuo-inset" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 12 }}>
                                    <button
                                        type="button"
                                        onClick={() => setFlexAd(false)}
                                        className={!flexAd ? 'skeuo-raised' : ''}
                                        style={{
                                            flex: 1, padding: '8px 10px', fontSize: 11, fontWeight: 700,
                                            borderRadius: 8, border: 'none', cursor: 'pointer',
                                            background: !flexAd ? undefined : 'transparent',
                                            color: !flexAd ? '#FFFFFF' : '#888',
                                        }}
                                    >
                                        Standard
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setFlexAd(true)}
                                        className={flexAd ? 'skeuo-raised' : ''}
                                        style={{
                                            flex: 1, padding: '8px 10px', fontSize: 11, fontWeight: 700,
                                            borderRadius: 8, border: 'none', cursor: 'pointer',
                                            background: flexAd ? undefined : 'transparent',
                                            color: flexAd ? '#FFFFFF' : '#888',
                                        }}
                                    >
                                        Flex Ad
                                    </button>
                                </div>
                                <div style={{ fontSize: 10, color: '#666', marginTop: 8, lineHeight: 1.4 }}>
                                    {flexAd
                                        ? 'Optional: all selected videos go into one ad (up to 10). Meta optimizes which creative shows.'
                                        : 'Default: one ad per selected video.'}
                                </div>
                                {flexAd && flexVideoCount > 10 && (
                                    <div style={{ fontSize: 10, color: '#FF9F0A', marginTop: 4 }}>
                                        {flexVideoCount} videos selected — max 10 for flex ads
                                    </div>
                                )}
                            </div>

                            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 20, marginBottom: 20 }}>
                                <label className="cyber-label" style={{ display: 'block', marginBottom: 16 }}>Ad Configuration</label>
                                <AdSettingsForm settings={adSettings} onChange={setAdSettings} compact={true} />

                                {/* Adapt Copy per Audience */}
                                {(() => {
                                    const uniqueAudiences = [...new Set(selectedFiles.map(f => f.audience).filter(Boolean))] as string[];
                                    const sourceAudience = browserSelection.ad?.name?.split('_')[0] || uniqueAudiences[0] || 'Unknown';
                                    const targetAudiences = uniqueAudiences.filter(a => a.toLowerCase() !== sourceAudience.toLowerCase());
                                    if (targetAudiences.length === 0 || adSettings.headlines.every(h => !h)) return null;

                                    return (
                                        <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: 'rgba(6,104,225,0.04)', border: '1px solid rgba(6,104,225,0.12)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: audienceCopyMap.size > 0 ? 12 : 0 }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, color: '#6DB3F8', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <Sparkles style={{ width: 12, height: 12 }} />
                                                    Adapt copy for {targetAudiences.length} audience{targetAudiences.length > 1 ? 's' : ''}
                                                </div>
                                                <button
                                                    onClick={async () => {
                                                        setIsAdaptingCopy(true);
                                                        setAdaptProgress(`Adapting 0/${targetAudiences.length}`);
                                                        try {
                                                            const results = await adaptCopyForAudiences(
                                                                sourceAudience, targetAudiences,
                                                                adSettings.headlines.filter(h => h),
                                                                adSettings.primaryTexts.filter(t => t),
                                                                adSettings.description,
                                                                (done, total) => setAdaptProgress(`Adapting ${done}/${total}`),
                                                            );
                                                            setAudienceCopyMap(results);
                                                            setUseOriginalForAudience(new Set());
                                                        } catch (err) {
                                                            console.error('Copy adaptation failed:', err);
                                                        }
                                                        setIsAdaptingCopy(false);
                                                        setAdaptProgress('');
                                                    }}
                                                    disabled={isAdaptingCopy}
                                                    style={{
                                                        padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                                                        background: isAdaptingCopy ? 'rgba(6,104,225,0.1)' : 'rgba(6,104,225,0.15)',
                                                        border: '1px solid rgba(6,104,225,0.25)', color: '#6DB3F8',
                                                        cursor: isAdaptingCopy ? 'not-allowed' : 'pointer',
                                                        display: 'flex', alignItems: 'center', gap: 5,
                                                    }}
                                                >
                                                    {isAdaptingCopy ? (
                                                        <><Loader2 style={{ width: 10, height: 10, animation: 'spin 1s linear infinite' }} /> {adaptProgress}</>
                                                    ) : audienceCopyMap.size > 0 ? (
                                                        <><RotateCcw style={{ width: 10, height: 10 }} /> Re-generate</>
                                                    ) : (
                                                        <><Sparkles style={{ width: 10, height: 10 }} /> Generate</>
                                                    )}
                                                </button>
                                            </div>

                                            {/* Source audience label */}
                                            {audienceCopyMap.size > 0 && (
                                                <div style={{ marginBottom: 8 }}>
                                                    <div style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Source: {sourceAudience}</div>
                                                </div>
                                            )}

                                            {/* Per-audience adapted copy cards */}
                                            {[...audienceCopyMap.entries()].map(([audience, adapted]) => {
                                                const isOriginal = useOriginalForAudience.has(audience);
                                                return (
                                                    <div key={audience} style={{
                                                        marginBottom: 8, padding: 10, borderRadius: 8,
                                                        background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-soft)',
                                                    }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                                            <span style={{
                                                                fontSize: 10, fontWeight: 700, color: '#0668E1',
                                                                padding: '1px 6px', borderRadius: 4,
                                                                background: 'rgba(6,104,225,0.1)', border: '1px solid rgba(6,104,225,0.2)',
                                                            }}>{audience}</span>
                                                            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#888', cursor: 'pointer' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={isOriginal}
                                                                    onChange={() => {
                                                                        setUseOriginalForAudience(prev => {
                                                                            const next = new Set(prev);
                                                                            if (next.has(audience)) next.delete(audience); else next.add(audience);
                                                                            return next;
                                                                        });
                                                                    }}
                                                                    style={{ accentColor: '#0668E1' }}
                                                                />
                                                                Use original
                                                            </label>
                                                        </div>
                                                        {!isOriginal && (
                                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                                {adapted.headlines.map((h, i) => (
                                                                    <div key={`h-${i}`}>
                                                                        <div style={{ fontSize: 8, color: '#555', textTransform: 'uppercase', marginBottom: 2 }}>Headline {i + 1}</div>
                                                                        <input
                                                                            value={h}
                                                                            onChange={(e) => {
                                                                                const updated = { ...adapted, headlines: [...adapted.headlines] };
                                                                                updated.headlines[i] = e.target.value;
                                                                                setAudienceCopyMap(prev => new Map(prev).set(audience, updated));
                                                                            }}
                                                                            style={{
                                                                                width: '100%', padding: '4px 8px', borderRadius: 6,
                                                                                background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-soft)',
                                                                                color: '#ddd', fontSize: 11, fontFamily: 'inherit', outline: 'none',
                                                                            }}
                                                                        />
                                                                    </div>
                                                                ))}
                                                                {adapted.primaryTexts.map((t, i) => (
                                                                    <div key={`t-${i}`}>
                                                                        <div style={{ fontSize: 8, color: '#555', textTransform: 'uppercase', marginBottom: 2 }}>Primary Text {i + 1}</div>
                                                                        <textarea
                                                                            value={t}
                                                                            onChange={(e) => {
                                                                                const updated = { ...adapted, primaryTexts: [...adapted.primaryTexts] };
                                                                                updated.primaryTexts[i] = e.target.value;
                                                                                setAudienceCopyMap(prev => new Map(prev).set(audience, updated));
                                                                            }}
                                                                            rows={3}
                                                                            style={{
                                                                                width: '100%', padding: '4px 8px', borderRadius: 6, resize: 'vertical',
                                                                                background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-soft)',
                                                                                color: '#ddd', fontSize: 11, fontFamily: 'inherit', outline: 'none',
                                                                            }}
                                                                        />
                                                                    </div>
                                                                ))}
                                                                {adapted.description && (
                                                                    <div>
                                                                        <div style={{ fontSize: 8, color: '#555', textTransform: 'uppercase', marginBottom: 2 }}>Description</div>
                                                                        <input
                                                                            value={adapted.description}
                                                                            onChange={(e) => {
                                                                                setAudienceCopyMap(prev => new Map(prev).set(audience, { ...adapted, description: e.target.value }));
                                                                            }}
                                                                            style={{
                                                                                width: '100%', padding: '4px 8px', borderRadius: 6,
                                                                                background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-soft)',
                                                                                color: '#ddd', fontSize: 11, fontFamily: 'inherit', outline: 'none',
                                                                            }}
                                                                        />
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}
                            </div>
                </>
            )}
                </>
            )}
            {/* Creative selection for deploy */}
            {uploadMode !== 'copy' && !isUploading && (
                <div style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <label className="cyber-label" style={{ margin: 0 }}>
                            Creatives · {selectedFiles.length}/{files.length}
                        </label>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button
                                type="button"
                                onClick={selectAllCreatives}
                                style={{
                                    fontSize: 10, fontWeight: 600, color: selectedFiles.length === files.length ? '#0668E1' : '#666',
                                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px',
                                }}
                            >
                                All
                            </button>
                            <button
                                type="button"
                                onClick={selectNoneCreatives}
                                style={{
                                    fontSize: 10, fontWeight: 600, color: selectedFiles.length === 0 ? '#0668E1' : '#666',
                                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px',
                                }}
                            >
                                None
                            </button>
                        </div>
                    </div>
                    <div
                        className="custom-scrollbar"
                        style={{
                            display: 'flex', flexDirection: 'column', gap: 6,
                            maxHeight: 240, overflowY: 'auto',
                            padding: 8, borderRadius: 12,
                            border: '1px solid rgba(255,255,255,0.06)',
                            background: 'rgba(0,0,0,0.2)',
                        }}
                    >
                        {files.length === 0 ? (
                            <div style={{ padding: '18px 10px', textAlign: 'center', fontSize: 11, color: '#555' }}>
                                Drop media on the left — it will show up here
                            </div>
                        ) : files.map(f => {
                            const isSelected = selectedFileIds.has(f.id);
                            return (
                                <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => toggleCreativeSelection(f.id)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 10,
                                        padding: '8px 10px', borderRadius: 10, width: '100%',
                                        textAlign: 'left', cursor: 'pointer',
                                        background: isSelected ? 'rgba(6,104,225,0.12)' : 'transparent',
                                        border: isSelected ? '1px solid rgba(6,104,225,0.45)' : '1px solid transparent',
                                        transition: 'all 0.15s',
                                    }}
                                >
                                    <div style={{
                                        width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: isSelected ? '#0668E1' : 'rgba(255,255,255,0.04)',
                                        border: isSelected ? 'none' : '1px solid rgba(255,255,255,0.15)',
                                    }}>
                                        {isSelected && <Check style={{ width: 12, height: 12, color: '#fff' }} />}
                                    </div>
                                    {f.thumbnail ? (
                                        <img
                                            src={f.thumbnail}
                                            alt=""
                                            style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                                        />
                                    ) : (
                                        <div style={{
                                            width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                                            background: 'rgba(255,255,255,0.04)',
                                        }} />
                                    )}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{
                                            fontSize: 12, fontWeight: 600, color: isSelected ? '#E5F0FF' : '#999',
                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                        }}>
                                            {f.name}
                                        </div>
                                        <div style={{ fontSize: 9, color: '#555', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                            {f.type}
                                            {f.audience ? ` · ${f.audience}` : ''}
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    {files.length > 0 && selectedFiles.length === 0 && selectedLibraryVideos.length === 0 && (
                        <div style={{ fontSize: 11, color: '#FF9F0A', marginTop: 8 }}>
                            Select local creatives here or videos from the Video Library
                        </div>
                    )}
                    {selectedFiles.length === 0 && selectedLibraryVideos.length > 0 && (
                        <div style={{ fontSize: 11, color: '#666', marginTop: 8 }}>
                            Using {selectedLibraryVideos.length} library video{selectedLibraryVideos.length !== 1 ? 's' : ''} for this campaign
                        </div>
                    )}
                </div>
            )}

            {/* File list status */}
            {uploadStatuses.length > 0 && (isUploading || isComplete) && (
                <div style={{ marginBottom: 20 }}>
                    {isComplete && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: uploadStatuses.some(s => s.status === 'failed') ? 'var(--red)' : 'var(--emerald)' }}>
                                {successCount} successful · {failedCount} failed
                            </div>
                        </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {selectedFiles.map(f => {
                            const st = uploadStatuses.find(s => s.fileId === f.id);
                            if (!st) return null;
                            return (
                                <div key={f.id} className="skeuo-raised" style={{
                                    display: 'flex', alignItems: 'center', gap: 12,
                                    borderRadius: 14, padding: '10px 14px',
                                }}>
                                    {f.thumbnail ? (
                                        <img src={f.thumbnail} alt={f.name} style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0, opacity: st.status === 'success' ? 0.7 : 1 }} />
                                    ) : (
                                        <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(0,0,0,0.4)', flexShrink: 0 }} />
                                    )}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 12, fontWeight: 600, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                                        {st.status !== 'pending' && (
                                            <>
                                                <div className="progress-track" style={{ marginTop: 8 }}>
                                                    <div
                                                        className="progress-fill"
                                                        style={{
                                                            width: `${st.progress}%`,
                                                            background: st.status === 'failed' ? 'var(--red)' : st.status === 'success' ? 'var(--emerald)' : 'var(--accent)',
                                                            boxShadow: `0 0 10px ${st.status === 'failed' ? 'var(--red)' : st.status === 'success' ? 'var(--emerald)' : 'var(--accent)'}`,
                                                        }}
                                                    />
                                                </div>
                                                {st.status === 'failed' && st.error && (
                                                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={st.error}>
                                                        {st.error}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        {st.status === 'success' && <Check style={{ width: 16, height: 16, color: 'var(--emerald)' }} />}
                                        {st.status === 'failed' && <AlertCircle style={{ width: 16, height: 16, color: 'var(--red)' }} />}
                                        {(st.status === 'uploading' || st.status === 'pending') && (
                                            <>
                                                {st.status === 'uploading' && (
                                                    <Loader2 className="animate-spin" style={{ width: 16, height: 16, color: 'var(--accent)' }} />
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => cancelFileUpload(f.id)}
                                                    title="Cancel upload"
                                                    style={{
                                                        width: 22, height: 22, borderRadius: 6, border: 'none',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        background: 'rgba(255,255,255,0.06)', color: '#999', cursor: 'pointer',
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,69,58,0.15)'; e.currentTarget.style.color = '#FF453A'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#999'; }}
                                                >
                                                    <X style={{ width: 12, height: 12 }} />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        {selectedLibraryVideos.map(v => {
                            const st = uploadStatuses.find(s => s.fileId === `lib:${v.id}`);
                            if (!st) return null;
                            return (
                                <div key={`lib:${v.id}`} className="skeuo-raised" style={{
                                    display: 'flex', alignItems: 'center', gap: 12,
                                    borderRadius: 14, padding: '10px 14px',
                                }}>
                                    {v.picture ? (
                                        <img src={v.picture} alt={v.title} style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0, opacity: st.status === 'success' ? 0.7 : 1 }} />
                                    ) : (
                                        <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(0,0,0,0.4)', flexShrink: 0 }} />
                                    )}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 12, fontWeight: 600, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {v.title || `Video ${v.id}`}
                                        </div>
                                        <div style={{ fontSize: 9, color: '#555', marginTop: 2 }}>Library video</div>
                                        {st.status !== 'pending' && (
                                            <>
                                                <div className="progress-track" style={{ marginTop: 8 }}>
                                                    <div
                                                        className="progress-fill"
                                                        style={{
                                                            width: `${st.progress}%`,
                                                            background: st.status === 'failed' ? 'var(--red)' : st.status === 'success' ? 'var(--emerald)' : 'var(--accent)',
                                                            boxShadow: `0 0 10px ${st.status === 'failed' ? 'var(--red)' : st.status === 'success' ? 'var(--emerald)' : 'var(--accent)'}`,
                                                        }}
                                                    />
                                                </div>
                                                {st.status === 'failed' && st.error && (
                                                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={st.error}>
                                                        {st.error}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        {st.status === 'success' && <Check style={{ width: 16, height: 16, color: 'var(--emerald)' }} />}
                                        {st.status === 'failed' && <AlertCircle style={{ width: 16, height: 16, color: 'var(--red)' }} />}
                                        {(st.status === 'uploading' || st.status === 'pending') && (
                                            <>
                                                {st.status === 'uploading' && (
                                                    <Loader2 className="animate-spin" style={{ width: 16, height: 16, color: 'var(--accent)' }} />
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => cancelFileUpload(`lib:${v.id}`)}
                                                    title="Cancel upload"
                                                    style={{
                                                        width: 22, height: 22, borderRadius: 6, border: 'none',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        background: 'rgba(255,255,255,0.06)', color: '#999', cursor: 'pointer',
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,69,58,0.15)'; e.currentTarget.style.color = '#FF453A'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#999'; }}
                                                >
                                                    <X style={{ width: 12, height: 12 }} />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}



            {/* Footer button */}
            <div style={{ marginTop: 20, paddingBottom: 56 }}>
                {!isComplete ? (
                    <button
                        onClick={uploadMode === 'copy' ? handleCopyCampaign : handleUpload}
                        disabled={uploadMode === 'copy' ? (isCopying || !canUpload) : (isUploading || !canUpload)}
                        className="skeuo-primary"
                        style={{ 
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, 
                            padding: '16px', fontSize: 15, borderRadius: 16, height: 52 
                        }}
                    >
                        {isUploading || isCopying ? (
                            <>
                                <Loader2 className="animate-spin" style={{ width: 18, height: 18 }} />
                                {isCopying ? 'Copying...' : 'Uploading...'}
                            </>
                        ) : (
                            <>
                                {uploadMode === 'copy'
                                    ? 'Copy Campaign'
                                    : uploadMode === 'campaign'
                                        ? (flexAd ? 'Create Flex Ad' : 'Create Ads')
                                        : 'Upload to Library'}
                                {uploadMode === 'campaign' && flexAd
                                    ? (deployCreativeCount > 0 && (
                                        <span style={{ opacity: 0.8 }}>
                                            ({selectedFiles.filter(f => f.type === 'video').length + selectedLibraryVideos.length} videos → 1 ad)
                                        </span>
                                    ))
                                    : uploadMode !== 'copy' && deployCreativeCount > 0 && (
                                        <span style={{ opacity: 0.8 }}>({deployCreativeCount})</span>
                                    )}
                            </>
                        )}
                    </button>
                ) : (
                    <button
                        onClick={() => setIsComplete(false)}
                        className="skeuo-primary"
                        style={{ 
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: '16px', fontSize: 15, borderRadius: 16, height: 52 
                        }}
                    >
                        Close
                    </button>
                )}
            </div>
            </div>

            {/* Floating Glass Preview Island */}
            {showPreviewDrawer && (
                <div
                    style={{
                        flexShrink: 0,
                        borderTop: '1px solid rgba(0,0,0,0.6)',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
                        display: 'flex',
                        flexDirection: 'column',
                        height: drawerHeight,
                        minHeight: 120,
                        maxHeight: '60vh',
                        position: 'relative',
                    }}
                    className="animate-fade-in-up"
                >
                    {/* Drag handle */}
                    <div
                        style={{
                            height: 28, cursor: 'ns-resize',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0, userSelect: 'none',
                        }}
                        onMouseDown={(e) => {
                            isDraggingDrawer.current = true;
                            dragStartY.current = e.clientY;
                            dragStartHeight.current = drawerHeight;
                            const onMove = (ev: MouseEvent) => {
                                if (!isDraggingDrawer.current) return;
                                const delta = dragStartY.current - ev.clientY;
                                const newH = Math.max(120, Math.min(window.innerHeight * 0.6, dragStartHeight.current + delta));
                                setDrawerHeight(newH);
                            };
                            const onUp = () => {
                                isDraggingDrawer.current = false;
                                document.removeEventListener('mousemove', onMove);
                                document.removeEventListener('mouseup', onUp);
                            };
                            document.addEventListener('mousemove', onMove);
                            document.addEventListener('mouseup', onUp);
                        }}
                    >
                        <div style={{
                            width: 40, height: 5, borderRadius: 3,
                            background: '#0D0D0D',
                            border: '1px solid rgba(255,255,255,0.02)',
                            borderTopColor: 'rgba(0,0,0,0.8)',
                            boxShadow: 'inset 1px 1px 3px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.04)',
                        }} />
                    </div>

                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '0 16px 10px', flexShrink: 0 }}>
                        <span className="cyber-label">Preview</span>
                        <span style={{ fontSize: 11, color: '#666' }}>
                            {previewRows.length} ad{previewRows.length !== 1 ? 's' : ''} in{' '}
                            {new Set(previewRows.map(r => r.adSetName)).size} ad set{new Set(previewRows.map(r => r.adSetName)).size !== 1 ? 's' : ''}
                        </span>
                    </div>

                    {/* Table Wrapper */}
                    <div style={{ flex: 1, minHeight: 0, padding: '0 10px 10px' }}>
                        <div
                            className="skeuo-inset"
                            style={{ borderRadius: 14, overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}
                        >
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1.4fr 1fr 1.4fr 1.4fr',
                                padding: '8px 14px',
                                borderBottom: '1px solid rgba(255,255,255,0.04)',
                                background: 'rgba(0,0,0,0.25)',
                                gap: 12, flexShrink: 0,
                            }}>
                                {([
                                    { label: 'Campaign ID',   key: 'campaignId'   },
                                    { label: 'Campaign Name', key: 'campaignName' },
                                    { label: 'Ad Set ID',     key: 'adSetId'      },
                                    { label: 'Ad Set Name',   key: 'adSetName'    },
                                    { label: 'Ad Name',       key: 'adName'       },
                                ] as { label: string; key: PreviewSortKey }[]).map(({ label, key }) => {
                                    const active = previewSortKey === key;
                                    return (
                                        <button
                                            key={key}
                                            onClick={() => handlePreviewSort(key)}
                                            style={{
                                                all: 'unset', cursor: 'pointer',
                                                fontSize: 9, fontWeight: 700,
                                                color: active ? '#aaa' : '#555',
                                                letterSpacing: '0.08em', textTransform: 'uppercase',
                                                display: 'flex', alignItems: 'center', gap: 3,
                                                transition: 'color 0.15s', userSelect: 'none',
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.color = active ? '#ccc' : '#888')}
                                            onMouseLeave={e => (e.currentTarget.style.color = active ? '#aaa' : '#555')}
                                        >
                                            {label}
                                            {active && <span style={{ fontSize: 8 }}>{previewSortDir === 'asc' ? '▲' : '▼'}</span>}
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="custom-scrollbar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                                {sortedPreviewRows.map((row, i) => (
                                    <div
                                        key={i}
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: '1fr 1.4fr 1fr 1.4fr 1.4fr',
                                            padding: '9px 14px',
                                            borderBottom: i < previewRows.length - 1 ? '1px solid rgba(255,255,255,0.025)' : 'none',
                                            gap: 12,
                                            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                        }}
                                    >
                                        {[row.campaignId, row.campaignName, row.adSetId, row.adSetName, row.adName].map((val, ci) => (
                                            <span
                                                key={ci}
                                                title={val}
                                                style={{
                                                    fontSize: 11,
                                                    color: val === '(new)' ? '#0668E1' : val === '(route)' ? '#30D158' : val.startsWith('(new)') ? '#0668E1' : 'var(--text-muted)',
                                                    fontWeight: val === '(new)' || val === '(route)' ? 600 : 400,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    fontFamily: ci === 0 || ci === 2 ? 'var(--font-mono)' : 'inherit',
                                                }}
                                            >{val}</span>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}
