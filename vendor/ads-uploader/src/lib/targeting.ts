/**
 * US state region keys (Meta Ads geo) + helpers for ad-set targeting / schedule.
 */

export interface UsState {
    code: string;
    name: string;
    /** Meta Ads geo region key */
    key: string;
}

/** All 50 US states with Meta region keys. */
export const US_STATES: UsState[] = [
    { code: 'AL', name: 'Alabama', key: '3843' },
    { code: 'AK', name: 'Alaska', key: '3844' },
    { code: 'AZ', name: 'Arizona', key: '3845' },
    { code: 'AR', name: 'Arkansas', key: '3846' },
    { code: 'CA', name: 'California', key: '3847' },
    { code: 'CO', name: 'Colorado', key: '3848' },
    { code: 'CT', name: 'Connecticut', key: '3849' },
    { code: 'DE', name: 'Delaware', key: '3850' },
    { code: 'FL', name: 'Florida', key: '3851' },
    { code: 'GA', name: 'Georgia', key: '3852' },
    { code: 'HI', name: 'Hawaii', key: '3853' },
    { code: 'ID', name: 'Idaho', key: '3854' },
    { code: 'IL', name: 'Illinois', key: '3855' },
    { code: 'IN', name: 'Indiana', key: '3856' },
    { code: 'IA', name: 'Iowa', key: '3857' },
    { code: 'KS', name: 'Kansas', key: '3858' },
    { code: 'KY', name: 'Kentucky', key: '3859' },
    { code: 'LA', name: 'Louisiana', key: '3860' },
    { code: 'ME', name: 'Maine', key: '3861' },
    { code: 'MD', name: 'Maryland', key: '3862' },
    { code: 'MA', name: 'Massachusetts', key: '3863' },
    { code: 'MI', name: 'Michigan', key: '3864' },
    { code: 'MN', name: 'Minnesota', key: '3865' },
    { code: 'MS', name: 'Mississippi', key: '3866' },
    { code: 'MO', name: 'Missouri', key: '3867' },
    { code: 'MT', name: 'Montana', key: '3868' },
    { code: 'NE', name: 'Nebraska', key: '3869' },
    { code: 'NV', name: 'Nevada', key: '3870' },
    { code: 'NH', name: 'New Hampshire', key: '3871' },
    { code: 'NJ', name: 'New Jersey', key: '3872' },
    { code: 'NM', name: 'New Mexico', key: '3873' },
    { code: 'NY', name: 'New York', key: '3874' },
    { code: 'NC', name: 'North Carolina', key: '3875' },
    { code: 'ND', name: 'North Dakota', key: '3876' },
    { code: 'OH', name: 'Ohio', key: '3877' },
    { code: 'OK', name: 'Oklahoma', key: '3878' },
    { code: 'OR', name: 'Oregon', key: '3879' },
    { code: 'PA', name: 'Pennsylvania', key: '3880' },
    { code: 'RI', name: 'Rhode Island', key: '3881' },
    { code: 'SC', name: 'South Carolina', key: '3882' },
    { code: 'SD', name: 'South Dakota', key: '3883' },
    { code: 'TN', name: 'Tennessee', key: '3884' },
    { code: 'TX', name: 'Texas', key: '3885' },
    { code: 'UT', name: 'Utah', key: '3886' },
    { code: 'VT', name: 'Vermont', key: '3887' },
    { code: 'VA', name: 'Virginia', key: '3888' },
    { code: 'WA', name: 'Washington', key: '3889' },
    { code: 'WV', name: 'West Virginia', key: '3890' },
    { code: 'WI', name: 'Wisconsin', key: '3891' },
    { code: 'WY', name: 'Wyoming', key: '3892' },
];

export type SpecialAdCategory =
    | ''
    | 'HOUSING'
    | 'EMPLOYMENT'
    | 'FINANCIAL_PRODUCTS_SERVICES'
    | 'ISSUES_ELECTIONS_POLITICS';

export const SPECIAL_AD_CATEGORIES: Array<{ value: SpecialAdCategory; label: string }> = [
    { value: '', label: 'None' },
    { value: 'HOUSING', label: 'Housing' },
    { value: 'EMPLOYMENT', label: 'Employment' },
    { value: 'FINANCIAL_PRODUCTS_SERVICES', label: 'Financial products & services' },
    { value: 'ISSUES_ELECTIONS_POLITICS', label: 'Issues, elections, or politics' },
];

export type BudgetMode = 'ABO' | 'CBO';

/** Facebook + Instagram only (no Audience Network / Messenger). */
export const DEFAULT_PUBLISHER_PLATFORMS = ['facebook', 'instagram'] as const;

/** Meta requires position arrays whenever publisher_platforms is set. */
export const DEFAULT_FACEBOOK_POSITIONS = [
    'feed',
    'right_hand_column',
    'marketplace',
    'story',
    'search',
    'instream_video',
    'facebook_reels',
] as const;

export const DEFAULT_INSTAGRAM_POSITIONS = [
    'stream',
    'story',
    'explore',
    'reels',
    'profile_feed',
    'ig_search',
] as const;

/**
 * Build ad-set targeting: all of US, optional state "exclusions", FB+IG placements.
 *
 * Special Ad Categories forbid `excluded_geo_locations`, so when states are
 * unchecked we include the remaining states as positive `geo_locations.regions`
 * instead of country=US + exclusions.
 */
export function buildUsTargeting(options: {
    excludedStateCodes?: string[];
    ageMin?: number;
    ageMax?: number;
    base?: Record<string, unknown>;
}): Record<string, unknown> {
    const excludedCodes = new Set(options.excludedStateCodes || []);
    const includedStates = US_STATES.filter(s => !excludedCodes.has(s.code));
    if (excludedCodes.size > 0 && includedStates.length === 0) {
        throw new Error('Cannot exclude every US state — leave at least one included');
    }

    // Full US (no state picks) → country targeting. Any "exclusions" → include
    // the remaining states explicitly (SAC-safe; no excluded_geo_locations).
    const geoLocations = excludedCodes.size === 0
        ? { countries: ['US'] }
        : { regions: includedStates.map(s => ({ key: s.key })) };

    const base = options.base ? { ...options.base } : {};
    const targeting: Record<string, unknown> = {
        ...base,
        geo_locations: geoLocations,
        age_min: options.ageMin ?? (typeof base.age_min === 'number' ? base.age_min : 18),
        age_max: options.ageMax ?? (typeof base.age_max === 'number' ? base.age_max : 65),
        publisher_platforms: [...DEFAULT_PUBLISHER_PLATFORMS],
        facebook_positions: [...DEFAULT_FACEBOOK_POSITIONS],
        instagram_positions: [...DEFAULT_INSTAGRAM_POSITIONS],
    };

    // Never send exclusions — SAC rejects them, and inclusion covers the same intent.
    delete targeting.excluded_geo_locations;

    // Drop AN / Messenger if cloned from a source ad set.
    delete targeting.device_platforms;
    delete targeting.messenger_positions;
    delete targeting.audience_network_positions;

    return targeting;
}

/**
 * Convert a local date+time in an IANA timezone to an ISO-8601 UTC string for Meta.
 * `date` = YYYY-MM-DD, `time` = HH:mm
 */
export function zonedDateTimeToUtcIso(
    date: string,
    time: string,
    timeZone: string,
): string {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    if (![year, month, day, hour, minute].every(n => Number.isFinite(n))) {
        throw new Error(`Invalid date/time: ${date} ${time}`);
    }

    // Guess UTC as if the wall clock were UTC, then correct by the zone offset.
    let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    for (let i = 0; i < 3; i++) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(new Date(utcMs));

        const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
        let h = get('hour');
        if (h === 24) h = 0; // some locales emit 24:00
        const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second') || 0);
        const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
        utcMs += desired - asUtc;
    }

    return new Date(utcMs).toISOString();
}

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTimeZone(timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
}
