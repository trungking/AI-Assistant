import type { AppConfig } from '../lib/types';
import { getStorage, isConfigStorageChange } from '../lib/storage';
import { openContentPopup, closeContentPopup, isContentPopupOpen, forceCloseContentPopup } from './ContentPopup';
import { startCropMode, cancelCropMode } from './CropOverlay';

/**
 * Extract text from a DOM node, preserving emoji alt text from img elements.
 * This handles sites like Twitter that render emojis as <img> tags.
 */
const extractTextFromNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent || '';
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;

        // Handle img elements - use alt text (often contains emoji)
        if (element.tagName === 'IMG') {
            return (element as HTMLImageElement).alt || '';
        }

        // Skip hidden elements
        if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') {
            return '';
        }

        // Recursively process child nodes
        let text = '';
        for (const child of Array.from(node.childNodes)) {
            text += extractTextFromNode(child);
        }

        // Add line breaks for block elements
        const blockTags = ['DIV', 'P', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
        if (blockTags.includes(element.tagName)) {
            text += '\n';
        }

        return text;
    }

    return '';
};

/**
 * Extract text from the current selection, preserving emojis rendered as images.
 */
const extractTextFromSelection = (): string => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return '';
    }

    // First try the simple approach
    const simpleText = selection.toString();

    // Check if we might be missing emojis by looking at the selection contents
    try {
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();

        // Check if there are any img elements in the selection
        const hasImages = fragment.querySelectorAll('img').length > 0;

        if (hasImages) {
            // Extract text with alt text from images
            let extractedText = '';
            for (const child of Array.from(fragment.childNodes)) {
                extractedText += extractTextFromNode(child);
            }
            // Clean up extra whitespace while preserving intentional line breaks
            return extractedText
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }
    } catch (e) {
        // Fall back to simple text if DOM manipulation fails
        console.warn('[AI Assistant] Failed to extract rich text:', e);
    }

    return simpleText;
};

let config: AppConfig | null = null;

// Initialize config
const init = async () => {
    try {
        config = await getStorage();
    } catch (e) {
        console.error('[AI Assistant] Failed to load config:', e);
    }
};

// Listen only to sync: local holds chat state with multi-MB images, and every
// local write would be copied into this listener in every open tab.
// Popups re-read the full config (including the local system prompt) on open.
const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (disposeIfStale()) return;
    if (isConfigStorageChange(changes, 'sync')) {
        getStorage()
            .then(freshConfig => {
                config = freshConfig;
            })
            .catch(e => {
                console.error('[AI Assistant] Failed to refresh config:', e);
            });
    }
};

// Listen for messages from background script
const handleMessage = (message: { action?: string; selection?: string; image?: string }, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (disposeIfStale()) return;
    if (message.action !== 'open_content_popup') return;
    getStorage().then(freshConfig => {
        config = freshConfig;
        openContentPopup(freshConfig, message.selection || '', message.image || null);
        sendResponse({ opened: true });
    }).catch(error => {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
    return true;
};

const NON_TEXT_INPUT_TYPES = new Set([
    'button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit',
]);

// Whether the keydown originated in a field the user is typing into
// (including fields inside open shadow roots, via composedPath()).
const isEditableTarget = (e: KeyboardEvent): boolean => {
    const target = e.composedPath()[0] ?? e.target;
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
    return false;
};

// Hotkeys without Ctrl/Alt/Meta would hijack normal typing in page fields.
const hasNonShiftModifier = (hotkey: { modifiers: string[] }): boolean =>
    hotkey.modifiers.some(m => ['ctrl', 'control', 'alt', 'meta', 'command'].includes(m.toLowerCase()));

// Hotkey Listener
const handleHotkey = (e: KeyboardEvent) => {
    if (disposeIfStale()) return;
    if (!config) return;
    // Autofill dispatches keydown events without a key; IME composition must not trigger hotkeys.
    if (!e.key || e.isComposing || e.keyCode === 229) return;

    const eventKey = e.key.toLowerCase();
    // Helper to ignore modifier keys themselves
    if (['control', 'alt', 'shift', 'meta'].includes(eventKey)) return;

    const inEditable = isEditableTarget(e);
    const isAllowedHere = (hotkey: { modifiers: string[] }) => !inEditable || hasNonShiftModifier(hotkey);

    // Check Crop Hotkey
    if (config.cropHotkey && isAllowedHere(config.cropHotkey)) {
        const { key, modifiers } = config.cropHotkey;
        const targetKey = key.toLowerCase();

        const ctrl = modifiers.includes('ctrl') || modifiers.includes('control');
        const alt = modifiers.includes('alt');
        const shift = modifiers.includes('shift');
        const meta = modifiers.includes('meta') || modifiers.includes('command');

        if (
            eventKey === targetKey &&
            e.ctrlKey === ctrl &&
            e.altKey === alt &&
            e.shiftKey === shift &&
            e.metaKey === meta
        ) {
            e.preventDefault();
            e.stopPropagation();

            // Start crop mode
            startCropMode(
                (imageDataUrl: string) => {
                    // Crop completed, open popup with image
                    // Always load fresh config
                    getStorage().then(freshConfig => {
                        config = freshConfig;
                        if (freshConfig.popupMode === 'content_script') {
                            openContentPopup(freshConfig, '', imageDataUrl);
                        } else {
                            return chrome.runtime.sendMessage({
                                action: 'open_with_image',
                                image: imageDataUrl
                            });
                        }
                    }).catch(error => {
                        console.error('[AI Assistant] Failed to open cropped image:', error);
                    });
                },
                () => {
                    // Crop canceled
                    console.log('[AI Assistant] Crop canceled');
                }
            );
            return;
        }
    }

    // Check Global Hotkey
    if (config.customHotkey && isAllowedHere(config.customHotkey)) {
        const { key, modifiers } = config.customHotkey;
        const targetKey = key.toLowerCase();

        const ctrl = modifiers.includes('ctrl') || modifiers.includes('control');
        const alt = modifiers.includes('alt');
        const shift = modifiers.includes('shift');
        const meta = modifiers.includes('meta') || modifiers.includes('command');

        if (
            eventKey === targetKey &&
            e.ctrlKey === ctrl &&
            e.altKey === alt &&
            e.shiftKey === shift &&
            e.metaKey === meta
        ) {
            e.preventDefault();
            e.stopPropagation();

            if (config.popupMode === 'content_script') {
                if (isContentPopupOpen()) {
                    closeContentPopup();
                } else {
                    const selection = extractTextFromSelection();
                    // Always load fresh config from storage to get latest model selection
                    getStorage().then(freshConfig => {
                        config = freshConfig;
                        openContentPopup(freshConfig, selection, null);
                    });
                }
            } else {
                (async () => {
                    try {
                        await chrome.runtime.sendMessage({
                            action: 'toggle_popup_hotkey',
                            selection: extractTextFromSelection()
                        });
                    } catch (err) {
                        console.error('[AI Assistant] Failed to send message:', err);
                    }
                })();
            }
            return;
        }
    }

    // Check Prompt Hotkeys
    if (config.prompts) {
        for (const prompt of config.prompts) {
            if (!prompt.hotkey || !isAllowedHere(prompt.hotkey)) continue;

            const { key, modifiers } = prompt.hotkey;
            const targetKey = key.toLowerCase();

            const ctrl = modifiers.includes('ctrl') || modifiers.includes('control');
            const alt = modifiers.includes('alt');
            const shift = modifiers.includes('shift');
            const meta = modifiers.includes('meta') || modifiers.includes('command');

            if (
                eventKey === targetKey &&
                e.ctrlKey === ctrl &&
                e.altKey === alt &&
                e.shiftKey === shift &&
                e.metaKey === meta
            ) {
                e.preventDefault();
                e.stopPropagation();
                const selection = extractTextFromSelection();

                if (config.popupMode === 'content_script') {
                    getStorage().then(freshConfig => {
                        config = freshConfig;
                        openContentPopup(freshConfig, selection, null, prompt.content, prompt);
                    }).catch(error => {
                        console.error('[AI Assistant] Failed to open prompt popup:', error);
                    });
                    // Note: auto-execute logic for prompt could be handled here if we passed 'immediate' flag or ID
                    // Currently ChatInterface checks props. But ContentPopup signature needs adjustment to support prompt object?
                    // openContentPopup accepts 'instruction'.
                    // If prompt is immediate, we should probably handle that in ContentPopup or ChatInterface.
                    // ChatInterface handles 'pendingAutoPrompt'.
                    // I should update openContentPopup to accept pendingAutoPrompt.
                } else {
                    (async () => {
                        try {
                            await chrome.runtime.sendMessage({
                                action: 'execute_prompt_hotkey',
                                selection: selection,
                                promptId: prompt.id
                            });
                        } catch (err) {
                            console.error('[AI Assistant] Failed to send message:', err);
                        }
                    })();
                }
                return;
            }
        }
    }
};

let disposed = false;
function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('keydown', handleHotkey);
    cancelCropMode();
    forceCloseContentPopup();
    try {
        chrome.storage.sync.onChanged.removeListener(handleStorageChange);
        chrome.runtime.onMessage.removeListener(handleMessage);
    } catch { /* The old extension context may already be invalid. */ }
}

// After an extension reload/update, this script's context is invalidated
// (chrome.runtime.id becomes undefined). A re-injected script may run in a
// fresh isolated world and cannot reach us, so stale handlers dispose themselves.
function disposeIfStale(): boolean {
    if (disposed) return true;
    if (chrome.runtime?.id) return false;
    dispose();
    return true;
}

// Re-injection must replace an invalidated script without duplicating hotkeys.
const contentGlobal = globalThis as typeof globalThis & {
    __aiAssistantContent?: { runtime: typeof chrome.runtime; dispose: () => void };
};
const previous = contentGlobal.__aiAssistantContent;
if (!previous?.runtime.id) {
    previous?.dispose();
    chrome.storage.sync.onChanged.addListener(handleStorageChange);
    chrome.runtime.onMessage.addListener(handleMessage);
    window.addEventListener('keydown', handleHotkey);
    contentGlobal.__aiAssistantContent = {
        runtime: chrome.runtime,
        dispose,
    };
    void init();
}
