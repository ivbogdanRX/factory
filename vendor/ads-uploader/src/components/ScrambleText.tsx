import { useState, useEffect, forwardRef, useImperativeHandle } from 'react';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SCRAMBLE_DURATION = 450;
const SCRAMBLE_INTERVAL = 30;

export interface ScrambleTextHandle {
    scramble: () => void;
}

interface ScrambleTextProps {
    text: string;
    style?: React.CSSProperties;
    /** If provided, re-scramble at a random interval between [min, max] ms. E.g. [30000, 60000] */
    repeatInterval?: [number, number];
}

/**
 * Scrambles through random alphanumeric characters on mount,
 * then settles on the final text. Optionally repeats.
 * Exposes a `scramble()` method via ref for on-demand triggering.
 */
export const ScrambleText = forwardRef<ScrambleTextHandle, ScrambleTextProps>(
    ({ text, style, repeatInterval }, ref) => {
    const [display, setDisplay] = useState(text);
    const [trigger, setTrigger] = useState(0);

    useImperativeHandle(ref, () => ({
        scramble: () => setTrigger(t => t + 1),
    }));

    // Run scramble animation
    useEffect(() => {
        const timer = setInterval(() => {
            let s = '';
            for (let i = 0; i < text.length; i++) {
                s += text[i] === ' ' ? ' ' : CHARS[Math.floor(Math.random() * CHARS.length)];
            }
            setDisplay(s);
        }, SCRAMBLE_INTERVAL);

        const timeout = setTimeout(() => {
            clearInterval(timer);
            setDisplay(text);
        }, SCRAMBLE_DURATION);

        return () => { clearInterval(timer); clearTimeout(timeout); };
    }, [text, trigger]);

    // Repeat timer
    useEffect(() => {
        if (!repeatInterval) return;
        const [min, max] = repeatInterval;
        const schedule = () => {
            const delay = min + Math.random() * (max - min);
            return setTimeout(() => {
                setTrigger(t => t + 1);
            }, delay);
        };
        const id = schedule();
        return () => clearTimeout(id);
    }, [repeatInterval, trigger]);

    return <span style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', ...style }}>{display}</span>;
});
