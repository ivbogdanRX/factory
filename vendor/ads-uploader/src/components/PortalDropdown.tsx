import { ReactNode, useRef, useState, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface PortalDropdownProps {
    isOpen: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement>;
    children: ReactNode;
}

export function PortalDropdown({ isOpen, onClose, anchorRef, children }: PortalDropdownProps) {
    const [coords, setCoords] = useState<{ top: number, left: number, width: number }>({ top: 0, left: 0, width: 0 });
    const portalRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!isOpen || !anchorRef.current) return;
        
        const updateCoords = () => {
            if (!anchorRef.current) return;
            const rect = anchorRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 6,
                left: rect.left,
                width: rect.width
            });
        };

        updateCoords();
        
        const handleScroll = (e: Event) => {
            // Don't close if scrolling inside the dropdown itself
            if (portalRef.current?.contains(e.target as Node)) return;
            onClose();
        };

        window.addEventListener('scroll', handleScroll, true);
        window.addEventListener('resize', updateCoords);
        
        return () => {
            window.removeEventListener('scroll', handleScroll, true);
            window.removeEventListener('resize', updateCoords);
        };
    }, [isOpen, anchorRef]);

    useEffect(() => {
        if (!isOpen) return;
        
        const handleClickOutside = (e: MouseEvent) => {
            if (portalRef.current?.contains(e.target as Node)) return;
            if (anchorRef.current?.contains(e.target as Node)) return;
            onClose();
        };

        document.addEventListener('mousedown', handleClickOutside, true);
        return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }, [isOpen, onClose, anchorRef]);

    if (!isOpen) return null;

    const content = (
        <div ref={portalRef} style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            width: coords.width,
            zIndex: 99999,
        }}>
            {children}
        </div>
    );

    return createPortal(content, document.body);
}
