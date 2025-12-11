import { useState, useEffect } from 'react';
import { type AppConfig, type ChatMessage, DEFAULT_CONFIG } from './types';
import { getStorage, setStorage, getSelectedText } from './storage';

export const useAppConfig = (initialConfig?: AppConfig) => {
    const [config, setConfigState] = useState<AppConfig>(initialConfig || DEFAULT_CONFIG);
    const [loading, setLoading] = useState(!initialConfig);

    useEffect(() => {
        // If initialConfig provided, we assume it's fresh enough or we just load strictly from storage to be sure?
        // Usually hooks should load truth from storage.
        const load = async () => {
            const stored = await getStorage();
            setConfigState(stored);
            setLoading(false);
        };
        load();
    }, []);

    const updateConfig = async (newConfig: AppConfig) => {
        setConfigState(newConfig);
        await setStorage(newConfig);
    };

    return { config, loading, updateConfig };
};

interface ChatState {
    instruction: string;
    messages: ChatMessage[];
    selectedText: string;
    selectedImage: string | null;
}

interface UseChatStateProps {
    initialText?: string;
    initialImage?: string | null;
    initialInstruction?: string;
    initialMessages?: ChatMessage[];
    // If true, we prioritize initial values over storage (e.g. fresh context trigger)
    isFreshContext?: boolean;
}

export const useChatState = ({
    initialText = '',
    initialImage = null,
    initialInstruction = '',
    initialMessages = [],
    isFreshContext = false
}: UseChatStateProps = {}) => {
    const [state, setState] = useState<ChatState>({
        instruction: initialInstruction,
        messages: initialMessages,
        selectedText: initialText,
        selectedImage: initialImage
    });
    const [hydrated, setHydrated] = useState(false);
    const [autoExecutePromptId, setAutoExecutePromptId] = useState<string | null>(null);

    useEffect(() => {
        const init = async () => {
            // Get page text if no initial text provided
            let pageText = initialText;
            if (!pageText && !isFreshContext) {
                pageText = await getSelectedText();
            }

            // Check triggers from background (context menu) if in extension context
            // In content script context, these are usually passed as props.
            // We can check chrome.storage.local for trigger flags regardless.
            const storage = await chrome.storage.local.get(['contextSelection', 'contextImage', 'autoExecutePromptId', 'popupState']);

            const hasContextTrigger = storage.contextSelection || storage.contextImage || storage.autoExecutePromptId;
            // If explicit fresh context passed via props, we treat it as a trigger too.
            const effectiveFreshContext = isFreshContext || hasContextTrigger;

            if (effectiveFreshContext) {
                // Start fresh
                let currentText = initialText || pageText; // Prefer prop input, fallback to page/stored
                let currentImage = initialImage;
                let currentInstruction = initialInstruction;

                if (storage.contextSelection) {
                    currentText = storage.contextSelection as string;
                    await chrome.storage.local.remove('contextSelection');
                }

                if (storage.contextImage) {
                    currentImage = storage.contextImage as string;
                    await chrome.storage.local.remove('contextImage');
                } else if (!isFreshContext) {
                    // If triggered by text context only (and not props), ensure image is clear
                    // UNLESS props provided an image?
                    currentImage = null;
                }

                if (storage.autoExecutePromptId) {
                    setAutoExecutePromptId(storage.autoExecutePromptId as string);
                    await chrome.storage.local.remove('autoExecutePromptId');
                }

                // Clear any stored state since we're starting a new explicit task
                await chrome.storage.local.remove('popupState');

                setState({
                    instruction: currentInstruction,
                    messages: [],
                    selectedText: currentText,
                    selectedImage: currentImage
                });

            } else {
                // Restore previous state if available
                if (storage.popupState) {
                    const s = storage.popupState as any;
                    setState({
                        instruction: s.instruction || '',
                        messages: s.messages || [],
                        selectedText: s.selectedText || '',
                        selectedImage: s.selectedImage || null
                    });
                } else {
                    // No previous state, just use current page text
                    setState(prev => ({ ...prev, selectedText: pageText }));
                }
            }

            setHydrated(true);
        };
        init();
    }, []);

    const updateState = (newState: Partial<ChatState>) => {
        setState(prev => {
            const updated = { ...prev, ...newState };
            // Persist
            const stateToSave = {
                instruction: updated.instruction,
                messages: updated.messages,
                selectedText: updated.selectedText,
                selectedImage: updated.selectedImage,
                timestamp: Date.now()
            };
            chrome.storage.local.set({ popupState: stateToSave });
            return updated;
        });
    };

    return { state, updateState, hydrated, autoExecutePromptId };
};
