import React from 'react';

export function SkeletonBlock({ height, width = '100%', borderRadius = 8, style }: { height: number; width?: number | string; borderRadius?: number; style?: React.CSSProperties }) {
    return (
        <div 
            className="skeleton-shimmer"
            style={{ height, width, borderRadius, flexShrink: 0, ...style }}
        />
    );
}

export function SkeletonListItem() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', width: '100%' }}>
            <SkeletonBlock width={14} height={14} borderRadius={4} />
            <SkeletonBlock height={14} width="70%" borderRadius={4} />
        </div>
    );
}

export function SkeletonDropdownField() {
    return (
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', minHeight: 44 }}>
            <SkeletonBlock height={16} width="50%" borderRadius={4} />
            <SkeletonBlock width={14} height={14} borderRadius={4} />
        </div>
    );
}
