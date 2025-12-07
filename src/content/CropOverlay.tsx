import { createRoot, type Root } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';

let cropRoot: Root | null = null;
let cropContainer: HTMLElement | null = null;

export const startCropMode = (onComplete: (imageDataUrl: string) => void, onCancel: () => void) => {
    // Remove existing
    if (cropRoot) {
        cropRoot.unmount();
        cropRoot = null;
    }
    if (cropContainer) {
        cropContainer.remove();
        cropContainer = null;
    }

    // Create container - use direct DOM styles, no shadow DOM to avoid complexity
    cropContainer = document.createElement('div');
    cropContainer.id = 'ai-ask-crop-overlay-host';
    Object.assign(cropContainer.style, {
        position: 'fixed',
        zIndex: '2147483647',
        left: '0',
        top: '0',
        width: '100vw',
        height: '100vh',
        margin: '0',
        padding: '0',
        border: 'none',
        pointerEvents: 'auto'
    });
    document.body.appendChild(cropContainer);

    const mountPoint = document.createElement('div');
    Object.assign(mountPoint.style, {
        width: '100%',
        height: '100%'
    });
    cropContainer.appendChild(mountPoint);
    cropRoot = createRoot(mountPoint);

    const handleComplete = (dataUrl: string) => {
        cleanup();
        onComplete(dataUrl);
    };

    const handleCancel = () => {
        cleanup();
        onCancel();
    };

    const cleanup = () => {
        if (cropRoot) {
            cropRoot.unmount();
            cropRoot = null;
        }
        if (cropContainer) {
            cropContainer.remove();
            cropContainer = null;
        }
    };

    cropRoot.render(
        <CropOverlay onComplete={handleComplete} onCancel={handleCancel} />
    );
};

interface CropOverlayProps {
    onComplete: (imageDataUrl: string) => void;
    onCancel: () => void;
}

const CropOverlay = ({ onComplete, onCancel }: CropOverlayProps) => {
    const [isSelecting, setIsSelecting] = useState(false);
    const [startPos, setStartPos] = useState({ x: 0, y: 0 });
    const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });
    const [screenshot, setScreenshot] = useState<string | null>(null);

    // Capture screenshot on mount
    useEffect(() => {
        const captureScreen = async () => {
            try {
                // Request screenshot from background script
                const response = await chrome.runtime.sendMessage({ action: 'capture_screenshot' });
                if (response?.dataUrl) {
                    setScreenshot(response.dataUrl);
                } else {
                    console.error('Failed to capture screenshot:', response?.error);
                    onCancel();
                }
            } catch (err) {
                console.error('Failed to capture screenshot:', err);
                onCancel();
            }
        };
        captureScreen();
    }, [onCancel]);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        }
    }, [onCancel]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsSelecting(true);
        setStartPos({ x: e.clientX, y: e.clientY });
        setCurrentPos({ x: e.clientX, y: e.clientY });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (isSelecting) {
            setCurrentPos({ x: e.clientX, y: e.clientY });
        }
    };

    const handleMouseUp = async () => {
        if (!isSelecting) return;
        setIsSelecting(false);

        const x = Math.min(startPos.x, currentPos.x);
        const y = Math.min(startPos.y, currentPos.y);
        const width = Math.abs(currentPos.x - startPos.x);
        const height = Math.abs(currentPos.y - startPos.y);

        // Minimum size check
        if (width < 10 || height < 10) {
            return; // Too small, ignore
        }

        if (!screenshot) {
            onCancel();
            return;
        }

        // Crop the image
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                onCancel();
                return;
            }

            // Account for device pixel ratio
            const dpr = window.devicePixelRatio || 1;
            canvas.width = width * dpr;
            canvas.height = height * dpr;

            ctx.drawImage(
                img,
                x * dpr,
                y * dpr,
                width * dpr,
                height * dpr,
                0,
                0,
                width * dpr,
                height * dpr
            );

            const croppedDataUrl = canvas.toDataURL('image/png');
            onComplete(croppedDataUrl);
        };
        img.onerror = () => {
            console.error('Failed to load screenshot for cropping');
            onCancel();
        };
        img.src = screenshot;
    };

    // Calculate selection rectangle
    const selectionRect = {
        left: Math.min(startPos.x, currentPos.x),
        top: Math.min(startPos.y, currentPos.y),
        width: Math.abs(currentPos.x - startPos.x),
        height: Math.abs(currentPos.y - startPos.y)
    };

    // Common styles
    const overlayStyle: React.CSSProperties = {
        position: 'fixed',
        inset: 0,
        cursor: 'crosshair',
        zIndex: 999999,
        backgroundColor: 'rgba(0, 0, 0, 0.3)'
    };

    const instructionsStyle: React.CSSProperties = {
        position: 'fixed',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0, 0, 0, 0.85)',
        color: 'white',
        padding: '12px 24px',
        borderRadius: 8,
        fontSize: 14,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        zIndex: 1000002,
        pointerEvents: 'none',
        whiteSpace: 'nowrap'
    };

    const sizeIndicatorStyle: React.CSSProperties = {
        position: 'fixed',
        background: 'rgba(0, 0, 0, 0.85)',
        color: 'white',
        padding: '4px 8px',
        borderRadius: 4,
        fontSize: 12,
        fontFamily: 'monospace',
        pointerEvents: 'none',
        zIndex: 1000002,
        left: selectionRect.left + selectionRect.width + 10,
        top: selectionRect.top
    };

    const selectionBorderStyle: React.CSSProperties = {
        position: 'fixed',
        border: '2px dashed #3b82f6',
        boxShadow: '0 0 0 1px rgba(59, 130, 246, 0.5), 0 0 10px rgba(59, 130, 246, 0.3)',
        backgroundColor: 'transparent',
        pointerEvents: 'none',
        zIndex: 1000001,
        left: selectionRect.left,
        top: selectionRect.top,
        width: selectionRect.width,
        height: selectionRect.height
    };

    const darkOverlayBase: React.CSSProperties = {
        position: 'fixed',
        background: 'rgba(0, 0, 0, 0.5)',
        pointerEvents: 'none',
        zIndex: 1000000
    };

    if (!screenshot) {
        return (
            <div style={{ ...overlayStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={instructionsStyle}>
                    Click and drag to select an area • Press ESC to cancel
                </div>
            </div>
        );
    }

    return (
        <>
            {/* Screenshot background */}
            <div
                style={{
                    ...overlayStyle,
                    backgroundImage: `url(${screenshot})`,
                    backgroundSize: '100vw 100vh',
                    backgroundPosition: 'top left',
                    backgroundRepeat: 'no-repeat',
                    backgroundColor: 'transparent'
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
            />

            {/* Dark overlay with cutout - shows selected area clearly */}
            {isSelecting && selectionRect.width > 0 && selectionRect.height > 0 && (
                <>
                    {/* Top */}
                    <div style={{
                        ...darkOverlayBase,
                        top: 0,
                        left: 0,
                        right: 0,
                        height: selectionRect.top
                    }} />
                    {/* Bottom */}
                    <div style={{
                        ...darkOverlayBase,
                        top: selectionRect.top + selectionRect.height,
                        left: 0,
                        right: 0,
                        bottom: 0
                    }} />
                    {/* Left */}
                    <div style={{
                        ...darkOverlayBase,
                        top: selectionRect.top,
                        left: 0,
                        width: selectionRect.left,
                        height: selectionRect.height
                    }} />
                    {/* Right */}
                    <div style={{
                        ...darkOverlayBase,
                        top: selectionRect.top,
                        left: selectionRect.left + selectionRect.width,
                        right: 0,
                        height: selectionRect.height
                    }} />
                </>
            )}

            {/* Selection border */}
            {isSelecting && selectionRect.width > 0 && selectionRect.height > 0 && (
                <div style={selectionBorderStyle} />
            )}

            {/* Size indicator */}
            {isSelecting && selectionRect.width > 0 && selectionRect.height > 0 && (
                <div style={sizeIndicatorStyle}>
                    {selectionRect.width} × {selectionRect.height}
                </div>
            )}

            {/* Instructions */}
            <div style={instructionsStyle}>
                Click and drag to select an area • Press ESC to cancel
            </div>
        </>
    );
};

export default CropOverlay;

