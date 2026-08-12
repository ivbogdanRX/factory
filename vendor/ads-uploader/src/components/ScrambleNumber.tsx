import { useState, useEffect } from 'react';

const DIGITS = '0123456789';
const SCRAMBLE_DURATION = 400;
const SCRAMBLE_INTERVAL = 35;

interface ScrambleNumberProps {
    value: number;
    style?: React.CSSProperties;
}

/**
 * Displays a number that scrambles through random digits
 * on mount and whenever the value changes.
 */
export function ScrambleNumber({ value, style }: ScrambleNumberProps) {
    const [display, setDisplay] = useState(String(value));

    useEffect(() => {
        const targetStr = String(value);

        const timer = setInterval(() => {
            let scrambled = '';
            for (let i = 0; i < targetStr.length; i++) {
                scrambled += DIGITS[Math.floor(Math.random() * 10)];
            }
            setDisplay(scrambled);
        }, SCRAMBLE_INTERVAL);

        const timeout = setTimeout(() => {
            clearInterval(timer);
            setDisplay(targetStr);
        }, SCRAMBLE_DURATION);

        return () => { clearInterval(timer); clearTimeout(timeout); };
    }, [value]);

    return <span style={{ fontFamily: 'monospace', ...style }}>{display}</span>;
}
