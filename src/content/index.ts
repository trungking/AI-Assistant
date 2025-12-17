import type { AppConfig, PromptTemplate } from '../lib/types';
import { openContentPopup, closeContentPopup, isContentPopupOpen } from './ContentPopup';
import { startCropMode } from './CropOverlay';

// Inline Default Config to avoid shared chunk import issues in content scripts
// (Or import from types if build confirms it works, forcing inline here for safety as before)
const DEFAULT_PROMPTS: PromptTemplate[] = [
    { id: '1', name: 'Summarize', content: 'Summarize the following text:\n\n${text}' },
    { id: '2', name: 'Explain', content: 'Explain this text in simple terms:\n\n${text}' },
    { id: '3', name: 'Translate to English', content: 'Translate the following text to English:\n\n${text}' },
    { id: '4', name: 'Fix Grammar', content: 'Fix the grammar and improve the writing of the following text:\n\n${text}' },
];

const DEFAULT_CONFIG: AppConfig = {
    apiKeys: {
        openai: [],
        google: [],
        anthropic: [],
        openrouter: [],
        perplexity: [],
    },
    selectedProvider: 'google',
    customBaseUrls: {
        openai: 'https://api.openai.com/v1',
        google: 'https://generativelanguage.googleapis.com/v1beta',
        anthropic: 'https://api.anthropic.com/v1',
        openrouter: 'https://openrouter.ai/api/v1',
        perplexity: 'https://api.perplexity.ai',
    },
    prompts: DEFAULT_PROMPTS,
    selectedModel: {
        openai: 'gpt-4o-mini',
        google: 'gemini-1.5-flash',
        anthropic: 'claude-3-haiku-20240307',
        openrouter: 'google/gemini-2.0-flash-exp:free',
        perplexity: 'sonar-pro',
    },
    customProviders: [],
    customHotkey: null,
    cropHotkey: null,
    theme: 'system',
    popupMode: 'extension',
    popupSize: { width: 450, height: 600 },
    webSearchProvider: 'perplexity',
    kagiSession: ''
};

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

const getStorage = async (): Promise<AppConfig> => {
    const result = await chrome.storage.sync.get('appConfig');
    if (!result.appConfig) return DEFAULT_CONFIG;

    const stored = result.appConfig as Partial<AppConfig>;

    // Deep merge for nested objects
    return {
        ...DEFAULT_CONFIG,
        ...stored,
        apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...stored.apiKeys },
        customBaseUrls: { ...DEFAULT_CONFIG.customBaseUrls, ...stored.customBaseUrls },
        selectedModel: { ...DEFAULT_CONFIG.selectedModel, ...stored.selectedModel },
    };
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

// Listen for storage changes to update config dynamically
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.appConfig) {
        config = changes.appConfig.newValue as AppConfig;
    }
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'open_content_popup') {
        // Always load fresh config to get latest model selection
        getStorage().then(freshConfig => {
            config = freshConfig;
            openContentPopup(freshConfig, message.selection || '', message.image || null);
        });
    }
});

// Hotkey Listener
window.addEventListener('keydown', (e) => {
    if (!config) return;

    const eventKey = e.key.toLowerCase();
    // Helper to ignore modifier keys themselves
    if (['control', 'alt', 'shift', 'meta'].includes(eventKey)) return;

    // Check Crop Hotkey
    if (config.cropHotkey) {
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
                            chrome.runtime.sendMessage({
                                action: 'open_with_image',
                                image: imageDataUrl
                            });
                        }
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
    if (config.customHotkey) {
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
            if (!prompt.hotkey) continue;

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
                    openContentPopup(config, selection, null, prompt.content, prompt);
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
});

init();
