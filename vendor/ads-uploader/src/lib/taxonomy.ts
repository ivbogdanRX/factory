import { getActiveProfileId, taxonomyStorageKey } from './profiles';

function storageKey(): string | null {
    const profileId = getActiveProfileId();
    if (!profileId) return null;
    return taxonomyStorageKey(profileId);
}

export interface CustomField {
    key: string;       // e.g. "Funnel Stage"
    values: string[];  // e.g. ["TOF", "MOF", "BOF"]
}

export interface Taxonomy {
    audiences: string[];
    hooks: string[];
    styles: string[];
    customFields: CustomField[];  // max 4
    /** Optional human-readable definitions for each taxonomy value (key → description).
     *  Used by the AI classifier to understand what each label means. */
    definitions: Record<string, string>;
}

export const DEFAULT_DEFINITIONS: Record<string, string> = {
    // ── Hook definitions ──
    'Stat-Hook':        'Opens with a specific statistic, number, or data point to grab attention (e.g. "83% of nurses don\'t know...")',
    'Testimonial':      'Features a real or implied personal experience / customer story as the primary hook (e.g. "I used to struggle with...")',
    'Before-After':     'Shows a clear transformation — before state vs. after state, either visually or narratively',
    'Problem-Agitate':  'Leads with a pain point, then amplifies the emotional weight of that problem before offering relief',
    'Breaking-News':    'Styled as urgent news or a timely announcement (e.g. "JUST ANNOUNCED:", "New policy change...")',
    'Question':         'Opens with a direct question to the viewer (e.g. "Did you know...?", "Are you a nurse over 50?")',
    'Shock-Value':      'Uses a surprising, provocative, or unexpected statement/visual to stop the scroll',
    'Story':            'Opens with a narrative arc — character, setting, conflict — draws viewer into a mini-story',
    // ── Style definitions ──
    'UGC':              'User-generated content style — casual, handheld, selfie-style, shot on phone, feels authentic/unpolished',
    'Animation':        'Fully animated (2D or 3D motion graphics, explainer-style animation)',
    'Claymation':       'Stop-motion clay/plasticine animation style',
    'Paper-Cutout':     'Paper craft or cut-out animation style, flat layered paper look',
    'Cartoon':          'Illustrated cartoon style — hand-drawn or digitally drawn characters',
    'Street-Interview': 'Man-on-the-street interview format — interviewer asks random people questions in public',
    'Talking-Head':     'Single person speaking directly to camera, usually stationary, studio or home setting',
    'Voiceover':        'Primary content is a voiceover narration over B-roll footage, stock clips, or text/graphics',
    'Slideshow':        'Sequence of static images or text cards with transitions',
    'Live-Action':      'Professional live-action footage — scripted scenes, multiple angles, produced feel',
    'Knitted':          'Knitted/crocheted/yarn craft visual style',
    'AI-Generated':     'Visually AI-generated — has the distinctive look of AI image/video generation (Sora, Midjourney, etc.)',
};

const MAX_CUSTOM_FIELDS = 4;

const DEFAULTS: Taxonomy = {
    audiences: [
        'Nurse', 'Teacher', 'Veteran', 'Homeowner', 'Retiree',
        'First-Responder', 'Parent', 'Small-Biz-Owner',
    ],
    hooks: [
        'Stat-Hook', 'Testimonial', 'Before-After', 'Problem-Agitate',
        'Breaking-News', 'Question', 'Shock-Value', 'Story',
    ],
    styles: [
        'UGC', 'Animation', 'Claymation', 'Paper-Cutout', 'Cartoon',
        'Street-Interview', 'Talking-Head', 'Voiceover', 'Slideshow',
        'Live-Action', 'Knitted', 'AI-Generated',
    ],
    customFields: [],
    definitions: { ...DEFAULT_DEFINITIONS },
};

function emptyTaxonomy(): Taxonomy {
    return {
        audiences: [...DEFAULTS.audiences],
        hooks: [...DEFAULTS.hooks],
        styles: [...DEFAULTS.styles],
        customFields: [],
        definitions: { ...DEFAULT_DEFINITIONS },
    };
}

function load(): Taxonomy {
    try {
        const key = storageKey();
        if (!key) return emptyTaxonomy();
        const raw = localStorage.getItem(key);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                audiences: parsed.audiences?.length ? parsed.audiences : DEFAULTS.audiences,
                hooks: parsed.hooks?.length ? parsed.hooks : DEFAULTS.hooks,
                styles: parsed.styles?.length ? parsed.styles : DEFAULTS.styles,
                customFields: parsed.customFields || [],
                definitions: { ...DEFAULT_DEFINITIONS, ...(parsed.definitions || {}) },
            };
        }
    } catch { /* ignore */ }
    return emptyTaxonomy();
}

function save(t: Taxonomy) {
    const key = storageKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(t));
    window.dispatchEvent(new Event('taxonomy-updated'));
}

export function getTaxonomy(): Taxonomy {
    return load();
}

export type TaxonomyField = 'audiences' | 'hooks' | 'styles';

export function addToTaxonomy(field: TaxonomyField, value: string): Taxonomy {
    const t = load();
    const normalized = value.trim().replace(/\s+/g, '-');
    if (normalized && !t[field].includes(normalized)) {
        t[field] = [...t[field], normalized].sort((a, b) => a.localeCompare(b));
        save(t);
    }
    return t;
}

export function removeFromTaxonomy(field: TaxonomyField, value: string): Taxonomy {
    const t = load();
    t[field] = t[field].filter(v => v !== value);
    save(t);
    return t;
}

export function updateInTaxonomy(field: TaxonomyField, oldVal: string, newVal: string): Taxonomy {
    const t = load();
    const normalized = newVal.trim().replace(/\s+/g, '-');
    if (!normalized || oldVal === normalized) return t;
    
    // Remove old and add new, then sort
    t[field] = t[field].filter(v => v !== oldVal);
    if (!t[field].includes(normalized)) {
        t[field].push(normalized);
    }
    t[field] = t[field].sort((a, b) => a.localeCompare(b));
    save(t);
    return t;
}

// ── Custom Field CRUD ────────────────────────────────────────────────

/** Converts a custom field key to a placeholder token: "Funnel Stage" → "{funnel-stage}" */
export function customFieldToken(key: string): string {
    return `{${key.toLowerCase().replace(/\s+/g, '-')}}`;
}

export function addCustomField(key: string): Taxonomy {
    const t = load();
    const normalized = key.trim();
    if (!normalized) return t;
    if (t.customFields.length >= MAX_CUSTOM_FIELDS) return t;
    if (t.customFields.some(cf => cf.key.toLowerCase() === normalized.toLowerCase())) return t;
    t.customFields.push({ key: normalized, values: [] });
    save(t);
    return t;
}

export function removeCustomField(key: string): Taxonomy {
    const t = load();
    t.customFields = t.customFields.filter(cf => cf.key !== key);
    save(t);
    return t;
}

export function renameCustomField(oldKey: string, newKey: string): Taxonomy {
    const t = load();
    const normalized = newKey.trim();
    if (!normalized || oldKey === normalized) return t;
    const field = t.customFields.find(cf => cf.key === oldKey);
    if (field) {
        field.key = normalized;
        save(t);
    }
    return t;
}

export function addCustomFieldValue(fieldKey: string, value: string): Taxonomy {
    const t = load();
    const normalized = value.trim().replace(/\s+/g, '-');
    if (!normalized) return t;
    const field = t.customFields.find(cf => cf.key === fieldKey);
    if (field && !field.values.includes(normalized)) {
        field.values = [...field.values, normalized].sort((a, b) => a.localeCompare(b));
        save(t);
    }
    return t;
}

export function removeCustomFieldValue(fieldKey: string, value: string): Taxonomy {
    const t = load();
    const field = t.customFields.find(cf => cf.key === fieldKey);
    if (field) {
        field.values = field.values.filter(v => v !== value);
        save(t);
    }
    return t;
}

export function updateCustomFieldValue(fieldKey: string, oldVal: string, newVal: string): Taxonomy {
    const t = load();
    const normalized = newVal.trim().replace(/\s+/g, '-');
    if (!normalized || oldVal === normalized) return t;
    const field = t.customFields.find(cf => cf.key === fieldKey);
    if (field) {
        field.values = field.values.filter(v => v !== oldVal);
        if (!field.values.includes(normalized)) {
            field.values.push(normalized);
        }
        field.values = field.values.sort((a, b) => a.localeCompare(b));
        save(t);
    }
    return t;
}

export { MAX_CUSTOM_FIELDS };
