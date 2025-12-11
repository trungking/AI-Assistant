import { createRoot, type Root } from 'react-dom/client';
import ChatInterface from '../components/ChatInterface';
import type { AppConfig, PromptTemplate } from '../lib/types';
import styleText from '../index.css?inline';
import { setStorage } from '../lib/storage';
import { useTheme } from '../lib/theme';
import { useState, useRef, useEffect } from 'react';

let root: Root | null = null;
let shadowContainer: HTMLElement | null = null;

export const isContentPopupOpen = (): boolean => {
    return root !== null && shadowContainer !== null;
};

export const closeContentPopup = (): void => {
    if (root) {
        root.unmount();
        root = null;
    }
    if (shadowContainer) {
        shadowContainer.remove();
        shadowContainer = null;
    }
    // Restore focus to the page so hotkeys work again
    // Use setTimeout to ensure the DOM cleanup is complete first
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
    // Remove existing if any
    if (root) {
        root.unmount();
        root = null;
    }
    if (shadowContainer) {
        shadowContainer.remove();
        shadowContainer = null;
    }

    // Create container
    shadowContainer = document.createElement('div');
    shadowContainer.id = 'ai-ask-content-popup-host';
    shadowContainer.style.position = 'absolute';
    shadowContainer.style.zIndex = '2147483647'; // Max z-index
    shadowContainer.style.left = '0';
    shadowContainer.style.top = '0';
    // Reset inheritance
    shadowContainer.style.all = 'initial';
    document.body.appendChild(shadowContainer);

    const shadow = shadowContainer.attachShadow({ mode: 'open' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = styleText;
    shadow.appendChild(style);

    // Initial Position calculation (Center Default)
    const width = config.popupSize?.width || 450;
    const height = config.popupSize?.height || 600;

    let initialX = (window.innerWidth - width) / 2;
    let initialY = (window.innerHeight - height) / 2;

    const selectionRange = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;

    // Only attempt positioning if we have a valid selection range
    if (selectionRange && selectionRange.getBoundingClientRect) {
        const rect = selectionRange.getBoundingClientRect();

        // Validate rect (sometimes it's all 0 if element is hidden/detached)
        if (rect.width > 0 || rect.height > 0) {
            // Try placing below
            let x = rect.left;
            let y = rect.bottom + 10;

            // Adjust X to keep in viewport
            if (x + width > window.innerWidth) {
                x = window.innerWidth - width - 20;
            }
            if (x < 0) x = 20; // Padding from left

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
                        // Align top with selection top, but clamp to viewport
                        y = rect.top;
                        const padding = 10;
                        if (y + height > window.innerHeight - padding) {
                            y = window.innerHeight - height - padding;
                        }
                        if (y < padding) {
                            y = padding;
                        }
                    } else {
                        // Fits neither below nor above nor right -> Fallback to Center
                        // Reset to center values calculated initially
                        x = (window.innerWidth - width) / 2;
                        y = (window.innerHeight - height) / 2;
                    }
                }
            }

            initialX = x;
            initialY = y;
        }
    }

    const mountPoint = document.createElement('div');
    shadow.appendChild(mountPoint);
    root = createRoot(mountPoint);

    const handleClose = () => {
        if (root) {
            root.unmount();
            root = null;
        }
        if (shadowContainer) {
            shadowContainer.remove();
            shadowContainer = null;
        }
        // Restore focus to the page so hotkeys work again
        // Use setTimeout to ensure the DOM cleanup is complete first
        setTimeout(() => {
            document.documentElement.focus();
        }, 0);
    };

    root.render(
        <AppWrapper
            config={config}
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

import { useAppConfig, useChatState } from '../lib/hooks';

const AppWrapper = ({ config: initialConfig, initialSelection, initialImage, initialInstruction, pendingAutoPrompt, onClose, initialX, initialY }: any) => {
    const [pos, setPos] = useState({ x: initialX, y: initialY });
    const [size, setSize] = useState(initialConfig.popupSize || { width: 450, height: 600 });
    const isDragging = useRef(false);
    const dragOffset = useRef({ x: 0, y: 0 });

    const { config, updateConfig } = useAppConfig(initialConfig);

    // Determine if this is a fresh context (explicitly passed props)
    const hasExplicitContext = !!(initialSelection || initialImage || pendingAutoPrompt);

    const { state, updateState, hydrated } = useChatState({
        initialText: initialSelection,
        initialImage: initialImage,
        initialInstruction: initialInstruction,
        isFreshContext: hasExplicitContext
    });

    // Theme logic
    const isDark = useTheme(config.theme);

    const handleMouseDown = (e: React.MouseEvent) => {
        // Only trigger drag on the header
        if ((e.target as HTMLElement).closest('.draggable-header')) {
            isDragging.current = true;
            dragOffset.current = {
                x: e.clientX - pos.x,
                y: e.clientY - pos.y
            };
            e.preventDefault();
        }
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (isDragging.current) {
            setPos({
                x: e.clientX - dragOffset.current.x,
                y: e.clientY - dragOffset.current.y
            });
        }
    };

    const handleMouseUp = () => {
        isDragging.current = false;
    };

    useEffect(() => {
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    // Reference for resize observer
    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver(() => {
            // Noop for now, persistence handled by mouseup
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    const handleMouseUpContainer = () => {
        if (containerRef.current) {
            const w = containerRef.current.offsetWidth;
            const h = containerRef.current.offsetHeight;
            if (w !== config.popupSize?.width || h !== config.popupSize?.height) {
                const newConfig = { ...config, popupSize: { width: w, height: h } };
                // Update persistent config (uses hook's updateConfig which handles storage)
                updateConfig(newConfig);
                setSize({ width: w, height: h });
            }
        }
    };

    if (!hydrated) return null;

    return (
        <div
            className={`font-sans text-base ${isDark ? 'dark' : ''}`}
            style={{ all: 'initial' }}
        >
            {/* Backdrop */}
            <div
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 9999,
                    backgroundColor: 'transparent'
                }}
                onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Dispatch a click on document.body to restore focus context
                    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    onClose();
                }}
            />

            <div
                ref={containerRef}
                style={{
                    position: 'fixed',
                    left: pos.x,
                    top: pos.y,
                    width: size.width,
                    height: size.height,
                    maxWidth: '90vw',
                    maxHeight: '90vh',
                    zIndex: 10000
                }}
                className="bg-transparent shadow-2xl rounded-xl resize overflow-hidden flex flex-col font-sans animate-popup-in"
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUpContainer}
            >
                {/* Backdrop/Shadow container ensuring styles apply */}
                <div className="w-full h-full flex flex-col active:shadow-none transition-shadow bg-white dark:bg-slate-900 rounded-xl overflow-hidden border-2 border-slate-300 dark:border-slate-500 shadow-sm">
                    <ChatInterface
                        config={config}
                        initialText={state.selectedText}
                        initialImage={state.selectedImage}
                        initialInstruction={state.instruction}
                        initialMessages={state.messages}
                        pendingAutoPrompt={pendingAutoPrompt}
                        onConfigUpdate={(newCfg: AppConfig) => {
                            updateConfig(newCfg);
                            setStorage(newCfg);
                        }}
                        onStateChange={updateState}
                        hideSettings={true}
                    />
                </div>
            </div>
        </div>
    );
};
