import { createRoot, type Root } from 'react-dom/client';
import UnifiedPopup from '../components/UnifiedPopup';
import type { AppConfig, PromptTemplate } from '../lib/types';
import styleText from '../index.css?inline';

let root: Root | null = null;
let shadowContainer: HTMLElement | null = null;

export const isContentPopupOpen = (): boolean => {
    return root !== null && shadowContainer !== null && shadowContainer.style.display !== 'none';
};

export const isContentPopupMounted = (): boolean => {
    return root !== null && shadowContainer !== null;
};

export const closeContentPopup = (): void => {
    // Just hide the popup, don't unmount - keeps streaming running
    if (shadowContainer) {
        shadowContainer.style.display = 'none';
    }
    // Restore focus to the page so hotkeys work again
    setTimeout(() => {
        document.documentElement.focus();
    }, 0);
};

export const forceCloseContentPopup = (): void => {
    // Actually destroy the popup (for when we need fresh context)
    if (root) {
        root.unmount();
        root = null;
    }
    if (shadowContainer) {
        shadowContainer.remove();
        shadowContainer = null;
    }
    setTimeout(() => {
        document.documentElement.focus();
    }, 0);
};

export const openContentPopup = (
    config: AppConfig,
    selection: string,
    image: string | null,
    instruction: string = '',
    pendingAutoPrompt: PromptTemplate | null = null
) => {
    // If popup is already mounted and we have no new context, just show it
    const hasNewContext = !!(selection || image || pendingAutoPrompt);
    if (isContentPopupMounted() && !hasNewContext) {
        if (shadowContainer) {
            shadowContainer.style.display = '';
        }
        return;
    }

    // If we have new context, force close old popup and create fresh one
    if (isContentPopupMounted() && hasNewContext) {
        forceCloseContentPopup();
    }

    // Create container
    shadowContainer = document.createElement('div');
    shadowContainer.id = 'ai-ask-content-popup-host';
    shadowContainer.style.position = 'absolute';
    shadowContainer.style.zIndex = '2147483647';
    shadowContainer.style.left = '0';
    shadowContainer.style.top = '0';
    shadowContainer.style.all = 'initial';

    // Stop keyboard events from propagating to the parent page
    // Use bubble phase (false) so React handlers can process events first
    // Then stop propagation to prevent parent page from intercepting
    const stopKeyboardPropagation = (e: Event) => {
        e.stopPropagation();
    };
    shadowContainer.addEventListener('keydown', stopKeyboardPropagation, false);
    shadowContainer.addEventListener('keyup', stopKeyboardPropagation, false);
    shadowContainer.addEventListener('keypress', stopKeyboardPropagation, false);

    document.body.appendChild(shadowContainer);

    const shadow = shadowContainer.attachShadow({ mode: 'open' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = styleText;
    shadow.appendChild(style);

    // Calculate initial position
    const { x: initialX, y: initialY } = calculatePopupPosition(config);

    const mountPoint = document.createElement('div');
    shadow.appendChild(mountPoint);
    root = createRoot(mountPoint);

    const handleClose = () => {
        closeContentPopup();
    };

    root.render(
        <UnifiedPopup
            mode="content"
            initialConfig={config}
            initialSelection={selection}
            initialImage={image}
            initialInstruction={instruction}
            pendingAutoPrompt={pendingAutoPrompt}
            onClose={handleClose}
            initialX={initialX}
            initialY={initialY}
        />
    );
};

/**
 * Calculate popup position based on selection and viewport
 */
function calculatePopupPosition(config: AppConfig): { x: number; y: number } {
    const width = config.popupSize?.width || 450;
    const height = config.popupSize?.height || 600;

    let x = (window.innerWidth - width) / 2;
    let y = (window.innerHeight - height) / 2;

    const selectionRange = window.getSelection()?.rangeCount
        ? window.getSelection()?.getRangeAt(0)
        : null;

    if (selectionRange && selectionRange.getBoundingClientRect) {
        const rect = selectionRange.getBoundingClientRect();

        if (rect.width > 0 || rect.height > 0) {
            // Try placing below
            x = rect.left;
            y = rect.bottom + 10;

            // Adjust X to keep in viewport
            if (x + width > window.innerWidth) {
                x = window.innerWidth - width - 20;
            }
            if (x < 0) x = 20;

            // Check Y - Try Below
            if (y + height > window.innerHeight) {
                // Try placement above
                const yAbove = rect.top - height - 10;
                if (yAbove > 0) {
                    y = yAbove;
                } else {
                    // Try placement to the Right
                    const xRight = rect.right + 10;
                    if (xRight + width <= window.innerWidth - 10) {
                        x = xRight;
                        y = rect.top;
                        const padding = 10;
                        if (y + height > window.innerHeight - padding) {
                            y = window.innerHeight - height - padding;
                        }
                        if (y < padding) {
                            y = padding;
                        }
                    } else {
                        // Fallback to center
                        x = (window.innerWidth - width) / 2;
                        y = (window.innerHeight - height) / 2;
                    }
                }
            }
        }
    }

    return { x, y };
}
