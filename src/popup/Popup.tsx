import { useState, useEffect } from 'react';
import { type AppConfig, DEFAULT_CONFIG, type ChatMessage, type PromptTemplate } from '../lib/types';
import { getStorage, getSelectedText } from '../lib/storage';
import { useTheme } from '../lib/theme';
import ChatInterface from '../components/ChatInterface';

export default function Popup() {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [selectedText, setSelectedText] = useState('');
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const [initialInstruction, setInitialInstruction] = useState('');
    const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);
    const [pendingAutoPrompt, setPendingAutoPrompt] = useState<PromptTemplate | null>(null);
    const [loading, setLoading] = useState(true);

    // Theme handling
    const isDark = useTheme(config.theme);
    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDark);
    }, [isDark]);

    useEffect(() => {
        const init = async () => {
            const [cfg, pageText] = await Promise.all([getStorage(), getSelectedText()]);
            setConfig(cfg);

            const storage = await chrome.storage.local.get(['contextSelection', 'contextImage', 'autoExecutePromptId', 'popupState']);

            // Check if opened via context menu or specific trigger
            const hasContextTrigger = storage.contextSelection || storage.contextImage || storage.autoExecutePromptId;

            if (hasContextTrigger) {
                // Handle context triggers - start fresh session
                let currentText = pageText;

                if (storage.contextSelection) {
                    currentText = storage.contextSelection as string;
                    await chrome.storage.local.remove('contextSelection');
                }

                if (storage.contextImage) {
                    setSelectedImage(storage.contextImage as string);
                    await chrome.storage.local.remove('contextImage');
                } else {
                    // If triggered by text context only, ensure image is clear
                    setSelectedImage(null);
                }

                setSelectedText(currentText);

                if (storage.autoExecutePromptId) {
                    const promptId = storage.autoExecutePromptId;
                    await chrome.storage.local.remove('autoExecutePromptId');
                    const prompt = cfg.prompts.find((p: PromptTemplate) => p.id === promptId);
                    if (prompt) {
                        setPendingAutoPrompt(prompt);
                    }
                }

                // Clear any stored state since we're starting a new explicit task
                await chrome.storage.local.remove('popupState');

            } else {
                // Simple open (icon click) - Restore previous state if available
                if (storage.popupState) {
                    const s = storage.popupState as any;
                    setInitialInstruction(s.instruction || '');
                    setInitialMessages(s.messages || []);
                    setSelectedText(s.selectedText || '');
                    setSelectedImage(s.selectedImage || null);
                } else {
                    // No previous state, just use current page text
                    setSelectedText(pageText);
                }
            }
            setLoading(false);
        };
        init();
    }, []);

    const handleStateChange = (state: any) => {
        const stateToSave = {
            instruction: state.instruction,
            messages: state.messages,
            selectedText: state.selectedText,
            selectedImage: state.selectedImage,
            timestamp: Date.now()
        };
        chrome.storage.local.set({ popupState: stateToSave });
    };

    if (loading) return null;

    return (
        <div className="w-[450px] h-[600px] overflow-hidden">
            <ChatInterface
                config={config}
                initialText={selectedText}
                initialImage={selectedImage}
                initialInstruction={initialInstruction}
                initialMessages={initialMessages}
                pendingAutoPrompt={pendingAutoPrompt}
                onStateChange={handleStateChange}
                onConfigUpdate={setConfig}
                onClose={() => window.close()}
            />
        </div>
    );
}