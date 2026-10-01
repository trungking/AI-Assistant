import { createRoot, type Root } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { captureScreenshot } from './captureScreenshot';

let cropRoot: Root | null = null;
let cropContainer: HTMLElement | null = null;
let cancelActiveCrop: (() => void) | null = null;

// This entry is injected into tabs and does not use React Fast Refresh.
// eslint-disable-next-line react-refresh/only-export-components
export const cancelCropMode = () => cancelActiveCrop?.();

export const startCropMode = (onComplete: (imageDataUrl: string) => void, onCancel: () => void) => {
    cancelCropMode();
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
    // Focusable so keyboard events land in the top document even when focus was
    // inside an iframe or a page input before crop mode started.
    cropContainer.tabIndex = -1;
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
        outline: 'none',
        pointerEvents: 'auto'
    });
    document.body.appendChild(cropContainer);
    cropContainer.focus({ preventScroll: true });

    const mountPoint = document.createElement('div');
    Object.assign(mountPoint.style, {
        width: '100%',
        height: '100%'
    });
    cropContainer.appendChild(mountPoint);
    cropRoot = createRoot(mountPoint);

    let finished = false;

    const handleComplete = (dataUrl: string) => {
        if (finished) return;
        finished = true;
        cleanup();
        onComplete(dataUrl);
    };

    const handleCancel = () => {
        if (finished) return;
        finished = true;
        cleanup();
        onCancel();
    };

    // Escape handling lives here (not only in the component) so it is active
    // immediately, before React mounts and while the screenshot is still being
    // captured. Capture phase + stopImmediatePropagation so pages that swallow
    // keydown for their own shortcuts/modals cannot eat the cancel key.
    const handleEscape = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' && e.key !== 'Esc') return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleCancel();
    };
    window.addEventListener('keydown', handleEscape, true);
    document.addEventListener('keydown', handleEscape, true);

    const cleanup = () => {
        cancelActiveCrop = null;
        window.removeEventListener('keydown', handleEscape, true);
        document.removeEventListener('keydown', handleEscape, true);

        const rootToUnmount = cropRoot;
        cropRoot = null;
        if (cropContainer) {
            cropContainer.remove();
            cropContainer = null;
        }
        // Deferred: cancel can be triggered from inside a React event handler
        // (Cancel button / right-click), and unmounting a root synchronously
        // while React is rendering is not allowed.
        if (rootToUnmount) {
            setTimeout(() => rootToUnmount.unmount(), 0);
        }
    };

    cancelActiveCrop = handleCancel;

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
    const [captureError, setCaptureError] = useState<string | null>(null);

    // Capture screenshot on mount
    useEffect(() => {
        let disposed = false;
        const captureScreen = async () => {
            try {
                const dataUrl = await captureScreenshot();
                if (!disposed) setScreenshot(dataUrl);
            } catch (err) {
                if (!disposed) setCaptureError(err instanceof Error ? err.message : String(err));
            }
        };
        captureScreen();
        return () => { disposed = true; };
    }, [onCancel]);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape' || e.key === 'Esc') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
        }
    }, [onCancel]);

    useEffect(() => {
        // Capture phase: page handlers must not be able to stop the cancel key.
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [handleKeyDown]);

    // Right-click cancels too, matching common screenshot tools and giving a
    // mouse-only way out if the page fights over the keyboard.
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return; // let right/middle click through to cancel
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

            // Use the actual bitmap scale (Retina and browser zoom can differ).
            const scaleX = img.naturalWidth / window.innerWidth;
            const scaleY = img.naturalHeight / window.innerHeight;
            canvas.width = Math.round(width * scaleX);
            canvas.height = Math.round(height * scaleY);

            ctx.drawImage(
                img,
                x * scaleX,
                y * scaleY,
                width * scaleX,
                height * scaleY,
                0,
                0,
                canvas.width,
                canvas.height
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

    const instructionsText = 'Click and drag to select an area • ESC or right-click to cancel';

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

    const instructionsBar = <div style={instructionsStyle}>{instructionsText}</div>;

    if (!screenshot) {
        return (
            <div
                style={{ ...overlayStyle, backgroundColor: captureError ? 'rgba(0, 0, 0, 0.3)' : 'transparent' }}
                onContextMenu={handleContextMenu}
            >
                {captureError && (
                    <div style={{ ...instructionsStyle, pointerEvents: 'auto', whiteSpace: 'normal', maxWidth: 500 }} role="alert">
                        {captureError}
                        <button type="button" onClick={onCancel} style={{ display: 'block', marginTop: 12 }}>Close</button>
                    </div>
                )}
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
                onContextMenu={handleContextMenu}
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
            {instructionsBar}
        </>
    );
};

export default CropOverlay;
