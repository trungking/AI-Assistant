import type { AppConfig, PromptTemplate } from '../lib/types';

// Inline Default Config to avoid shared chunk import issues in content scripts
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
    },
    selectedProvider: 'google',
    customBaseUrls: {
        openai: 'https://api.openai.com/v1',
        google: 'https://generativelanguage.googleapis.com/v1beta',
        anthropic: 'https://api.anthropic.com/v1',
        openrouter: 'https://openrouter.ai/api/v1',
    },
    prompts: DEFAULT_PROMPTS,
    selectedModel: {
        openai: 'gpt-4o-mini',
        google: 'gemini-1.5-flash',
        anthropic: 'claude-3-haiku-20240307',
        openrouter: 'google/gemini-2.0-flash-exp:free',
    },
    customProviders: [],
    customHotkey: null,
    theme: 'system'
};

const getStorage = async (): Promise<AppConfig> => {
    const result = await chrome.storage.sync.get('appConfig');
    return result.appConfig ? { ...DEFAULT_CONFIG, ...result.appConfig } : DEFAULT_CONFIG;
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

// Hotkey Listener
window.addEventListener('keydown', (e) => {
    if (!config) return;

    const eventKey = e.key.toLowerCase();
    // Helper to ignore modifier keys themselves
    if (['control', 'alt', 'shift', 'meta'].includes(eventKey)) return;

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
            // Get selection
            const selection = window.getSelection()?.toString();
            (async () => {
                try {
                    await chrome.runtime.sendMessage({
                        action: 'open_popup_hotkey',
                        selection: selection
                    });
                } catch (err) {
                    console.error('[AI Assistant] Failed to send message:', err);
                }
            })();
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
                const selection = window.getSelection()?.toString();
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
                return;
            }
        }
    }
});

init();