import { useEffect } from 'react';
import { type PromptTemplate } from '../lib/types';
import { useTheme } from '../lib/theme';
import ChatInterface from '../components/ChatInterface';
import { useAppConfig, useChatState } from '../lib/hooks';

export default function Popup() {
    const { config, loading: configLoading, updateConfig } = useAppConfig();

    // We pass isFreshContext: false generally, as this is the standard popup.
    // However, internally useChatState checks chrome.storage.local for trigger flags which handles the "fresh context" cases.
    const { state, updateState, hydrated, autoExecutePromptId } = useChatState();

    // Theme handling
    const isDark = useTheme(config.theme);
    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDark);
    }, [isDark]);

    if (configLoading || !hydrated) return null;

    // Resolve prompt from ID if present
    let pendingAutoPrompt: PromptTemplate | null = null;
    if (autoExecutePromptId) {
        pendingAutoPrompt = config.prompts.find(p => p.id === autoExecutePromptId) || null;
    }

    return (
        <div className="w-[450px] h-[600px] overflow-hidden">
            <ChatInterface
                config={config}
                initialText={state.selectedText}
                initialImage={state.selectedImage}
                initialInstruction={state.instruction}
                initialMessages={state.messages}
                pendingAutoPrompt={pendingAutoPrompt}
                onStateChange={updateState}
                onConfigUpdate={updateConfig}
                onClose={() => window.close()}
            />
        </div>
    );
}