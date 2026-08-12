import { useMemo } from 'react';

/**
 * 3×3 dot grid with a sequential wave animation.
 * Each dot lights up in sequence with a staggered delay, creating a ripple/wave effect.
 */
export function DotGridLoader({ size = 24, color = '#0668E1' }: { size?: number; color?: string }) {
    const dotSize = Math.round(size / 5);
    const gap = Math.round(size / 8);

    // Wave order: center column top-to-bottom, then outer columns
    const delays = useMemo(() => [
        0, 1, 2,    // row 0: left, center, right
        3, 4, 5,    // row 1
        6, 7, 8,    // row 2
    ].map(i => {
        // Column wave: center col first, then left+right
        const row = Math.floor(i / 3);
        const col = i % 3;
        const colDelay = col === 1 ? 0 : col === 0 ? 1 : 2;
        return (row + colDelay) * 100; // 100ms stagger
    }), []);

    return (
        <div
            style={{
                display: 'inline-grid',
                gridTemplateColumns: `repeat(3, ${dotSize}px)`,
                gap,
            }}
        >
            {delays.map((delay, i) => (
                <div
                    key={i}
                    style={{
                        width: dotSize,
                        height: dotSize,
                        borderRadius: '50%',
                        background: color,
                        opacity: 0.15,
                        animation: `dot-wave 1.2s ${delay}ms ease-in-out infinite`,
                    }}
                />
            ))}
        </div>
    );
}
