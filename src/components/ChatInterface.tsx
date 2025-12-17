import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { type AppConfig, type ChatMessage, type PromptTemplate, type Provider } from '../lib/types';
import { callApi, fetchModels } from '../lib/api';
import { Send, Settings, Sparkles, Loader2, User, Bot, Trash2, Zap, Image as ImageIcon, ChevronDown, ChevronRight, Check, X, Copy, PauseCircle, SquarePen, Clock, Globe, Link2, ExternalLink, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { clsx } from 'clsx';
import { setStorage } from '../lib/storage';

const ProviderDisplayNames: Record<string, string> = {
    openai: 'OpenAI',
    google: 'Google Gemini',
    anthropic: 'Anthropic',
    openrouter: 'OpenRouter',
    perplexity: 'Perplexity'
};

interface ChatInterfaceProps {
    config: AppConfig;
    initialText: string;
    initialImage: string | null;
    initialInstruction?: string;
    initialMessages?: ChatMessage[];
    pendingAutoPrompt?: PromptTemplate | null;
    onClose?: () => void;
    onConfigUpdate?: (config: AppConfig) => void;
    onStateChange?: (state: {
        instruction: string;
        messages: ChatMessage[];
        selectedText: string;
        selectedImage: string | null;
    }) => void;
    hideSettings?: boolean;
}

export default function ChatInterface({
    config: initialConfig,
    initialText,
    initialImage,
    initialInstruction = '',
    initialMessages = [],
    pendingAutoPrompt = null,
    onClose,
    onConfigUpdate,
    onStateChange,
    hideSettings = false
}: ChatInterfaceProps) {
    const [config, setConfig] = useState<AppConfig>(initialConfig);
    const [selectedText, setSelectedText] = useState(initialText);
    const [selectedImage, setSelectedImage] = useState<string | null>(initialImage);
    const [instruction, setInstruction] = useState(initialInstruction);
    const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
    const [expandedSearches, setExpandedSearches] = useState<Record<number, boolean>>({});
    const [sourcesModal, setSourcesModal] = useState<{ sources: Array<{ title: string; url: string; snippet?: string }>; query: string } | null>(null);
    const [imageZoomOpen, setImageZoomOpen] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const modelMenuRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [modelSearch, setModelSearch] = useState('');

    // Abort controller for streaming
    const abortControllerRef = useRef<AbortController | null>(null);

    // Refs for cleanup state access
    const messagesRef = useRef(messages);
    const loadingRef = useRef(loading);
    const instructionRef = useRef(instruction);
    const selectedTextRef = useRef(selectedText);
    const selectedImageRef = useRef(selectedImage);

    // Sync refs
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    useEffect(() => { loadingRef.current = loading; }, [loading]);
    useEffect(() => { instructionRef.current = instruction; }, [instruction]);
    useEffect(() => { selectedTextRef.current = selectedText; }, [selectedText]);
    useEffect(() => { selectedImageRef.current = selectedImage; }, [selectedImage]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (loadingRef.current && abortControllerRef.current) {
                console.log('Aborting stream due to unmount');
                abortControllerRef.current.abort();

                // Mark last message as interrupted
                const currentMsgs = [...messagesRef.current];
                const lastMsg = currentMsgs[currentMsgs.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    lastMsg.interrupted = true;
                }

                // Force save state
                if (onStateChange) {
                    onStateChange({
                        instruction: instructionRef.current,
                        messages: currentMsgs,
                        selectedText: selectedTextRef.current,
                        selectedImage: selectedImageRef.current
                    });
                }
            }
        };
    }, []);

    // Notify state changes
    useEffect(() => {
        if (onStateChange) {
            const timer = setTimeout(() => {
                onStateChange({
                    instruction,
                    messages,
                    selectedText,
                    selectedImage
                });
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [instruction, messages, selectedText, selectedImage, onStateChange]);

    // Update state when props change (important for re-opening with new context)
    useEffect(() => {
        setSelectedText(initialText);
    }, [initialText]);

    useEffect(() => {
        setSelectedImage(initialImage);
    }, [initialImage]);

    useEffect(() => {
        if (initialMessages.length > 0) {
            setMessages(initialMessages);
        }
    }, [initialMessages]);

    useEffect(() => {
        if (initialInstruction) {
            setInstruction(initialInstruction);
        }
    }, [initialInstruction]);

    // Handle auto-execution
    useEffect(() => {
        if (pendingAutoPrompt) {
            // Use initialText (fresh selection) not selectedText (may have stale data)
            // Check both initialImage and selectedImage for image context (pasted images)
            // Also don't auto-submit if there's an existing conversation
            const hasFreshContext = !!initialText || !!initialImage || !!selectedImage;
            const hasExistingConversation = initialMessages && initialMessages.length > 0;

            if (pendingAutoPrompt.immediate && hasFreshContext && !hasExistingConversation) {
                handleSubmit(pendingAutoPrompt.content);
            } else {
                // Just fill the input without auto-submitting
                // Always strip ${text} placeholder when filling input manually
                let promptContent = pendingAutoPrompt.content
                    .replace(/\$\{text\}/g, '')
                    .replace(/\n\n+/g, '\n\n')
                    .trim();
                setInstruction(promptContent);
                if (textareaRef.current) {
                    textareaRef.current.focus();
                }
            }
        }
    }, [pendingAutoPrompt]);

    useEffect(() => {
        const loadModels = async () => {
            const models: Record<string, string[]> = {};
            for (const provider of Object.keys(config.apiKeys) as Provider[]) {
                if (config.apiKeys[provider] && config.apiKeys[provider].length > 0) {
                    try {
                        const fetched = await fetchModels(provider, config.apiKeys[provider][0], config.customBaseUrls[provider]);
                        if (fetched.length > 0) {
                            models[provider] = fetched;
                        }
                    } catch (e) {
                        console.error(`Failed to fetch models for ${provider}`, e);
                    }
                }
            }
            setAvailableModels(prev => ({ ...prev, ...models }));
        };

        if (Object.keys(config.apiKeys).some(k => config.apiKeys[k as Provider].length > 0)) {
            loadModels();
        }
    }, [config.apiKeys, config.customBaseUrls]);

    useEffect(() => {
        scrollToBottom();
    }, [messages, loading]);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
        }
    }, [instruction]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
                setIsModelMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (isModelMenuOpen) {
            // Pre-fill with current model name
            setModelSearch(config.selectedModel[config.selectedProvider] || '');
            setTimeout(() => {
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
            }, 50);
        } else {
            setModelSearch('');
        }
    }, [isModelMenuOpen]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    // Clear context and immediately persist (bypass debounce)
    const clearTextContext = () => {
        setSelectedText('');
        if (onStateChange) {
            onStateChange({
                instruction,
                messages,
                selectedText: '',
                selectedImage
            });
        }
    };

    const clearImageContext = () => {
        setSelectedImage(null);
        if (onStateChange) {
            onStateChange({
                instruction,
                messages,
                selectedText,
                selectedImage: null
            });
        }
    };

    const handlePaste = (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const dataUrl = event.target?.result as string;
                        setSelectedImage(dataUrl);
                        if (onStateChange) {
                            onStateChange({
                                instruction,
                                messages,
                                selectedText,
                                selectedImage: dataUrl
                            });
                        }
                    };
                    reader.readAsDataURL(file);
                }
                break;
            }
        }
    };

    const handlePromptClick = (prompt: PromptTemplate) => {
        // Use initialText (fresh selection) not selectedText (may have stale data)
        // Check both initialImage and selectedImage for image context (pasted images)
        // Also don't auto-submit if there's an existing conversation
        const hasFreshContext = !!initialText || !!initialImage || !!selectedImage;
        const hasExistingConversation = messages.length > 0;

        if (prompt.immediate && hasFreshContext && !hasExistingConversation) {
            handleSubmit(prompt.content);
        } else {
            // Always strip ${text} placeholder when filling input manually
            let promptContent = prompt.content
                .replace(/\$\{text\}/g, '')
                .replace(/\n\n+/g, '\n\n')  // Remove extra newlines
                .trim();
            setInstruction(promptContent);
            if (textareaRef.current) {
                textareaRef.current.focus();
            }
        }
    };

    const handleModelChange = async (provider: Provider, model: string) => {
        const newConfig = {
            ...config,
            selectedProvider: provider,
            selectedModel: {
                ...config.selectedModel,
                [provider]: model
            }
        };
        setConfig(newConfig);
        if (onConfigUpdate) {
            onConfigUpdate(newConfig);
        } else {
            // Fallback for extension popup
            await setStorage(newConfig);
        }
        setIsModelMenuOpen(false);
    };

    const handleSubmit = async (overrideInstruction?: string) => {
        const textToSubmit = overrideInstruction !== undefined ? overrideInstruction : instruction;

        if (!textToSubmit.trim()) return;

        setLoading(true);
        setError('');

        // Track response time
        const startTime = Date.now();

        // Abort previous if any
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();

        let userContent = textToSubmit.trim();
        let messagePayload: ChatMessage;

        if (messages.length === 0) {
            if (userContent.includes('${text}')) {
                userContent = userContent.replace('${text}', selectedText || '');
            } else if (selectedText) {
                userContent = `${userContent}\n\nContext:\n${selectedText}`;
            }

            if (selectedImage) {
                messagePayload = {
                    role: 'user',
                    content: userContent,
                    image: selectedImage
                };
            } else {
                messagePayload = { role: 'user', content: userContent };
            }
        } else {
            messagePayload = { role: 'user', content: userContent };
        }

        const newMessages = [...messages, messagePayload];
        setMessages(newMessages);
        setInstruction('');

        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }

        // Add placeholder assistant message
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
        setMessages([...newMessages, assistantMsg]);
        let accumulatedText = '';
        let isInNewMessage = false;

        try {
            const res = await callApi(newMessages, config, (chunk) => {
                if (isInNewMessage) {
                    // Append to the new (follow-up) message
                    accumulatedText += chunk;
                    const currentResponseTime = Date.now() - startTime;
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.content = accumulatedText;
                            last.responseTime = currentResponseTime;
                        }
                        return updated;
                    });
                } else {
                    // Append to the initial message
                    accumulatedText += chunk;
                    const currentResponseTime = Date.now() - startTime;
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.content = accumulatedText;
                            last.responseTime = currentResponseTime;
                        }
                        return updated;
                    });
                }
            }, abortControllerRef.current.signal, (searchStatus) => {
                if (searchStatus.startNewMessage && !isInNewMessage) {
                    // Create a new message for the follow-up response (only once)
                    isInNewMessage = true;
                    accumulatedText = ''; // Reset for new message
                    setMessages(prev => {
                        const updated = [...prev];
                        // Update the previous message's web search info only (don't touch content)
                        const prevLast = updated[updated.length - 1];
                        if (prevLast && prevLast.role === 'assistant') {
                            prevLast.webSearch = {
                                query: searchStatus.query,
                                result: searchStatus.result || '',
                                isSearching: false,
                                sources: searchStatus.sources
                            };
                        }
                        // Add new assistant message for the follow-up (no webSearch on this one)
                        return [...updated, { role: 'assistant', content: '' }];
                    });
                } else if (!isInNewMessage) {
                    // Only update web search info if we haven't created a new message yet
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.webSearch = {
                                query: searchStatus.query,
                                result: searchStatus.result || '',
                                isSearching: searchStatus.isSearching,
                                sources: searchStatus.sources
                            };
                        }
                        return updated;
                    });
                }
                // If isInNewMessage is true and it's not startNewMessage, skip (don't update the new message's webSearch)
            });

            if (res.error) {
                setError(res.error);
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                // Aborted - still record response time for interrupted messages
                const responseTime = Date.now() - startTime;
                setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === 'assistant') {
                        last.interrupted = true;
                        last.responseTime = responseTime;
                    }
                    return updated;
                });
            } else {
                setError(err.message);
            }
        } finally {
            setLoading(false);
            abortControllerRef.current = null;
        }
    };

    const openOptions = () => {
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open(chrome.runtime.getURL('src/options/index.html'), '_blank');
        }
    };

    const allProviders = (Object.keys(config.apiKeys) as Provider[]).filter(p => config.apiKeys[p].length > 0);

    const filteredModelGroups = allProviders.map(p => {
        const models = availableModels[p] || [config.selectedModel[p]];
        const uniqueModels = Array.from(new Set([...models, config.selectedModel[p]]));
        const filteredModels = uniqueModels.filter(m =>
            m && m.toLowerCase().includes(modelSearch.toLowerCase())
        );
        return { provider: p, models: filteredModels };
    }).filter(g => g.models.length > 0);

    return (
        <div className="w-full h-full bg-slate-50 dark:bg-gpt-main flex flex-col font-sans text-slate-900 dark:text-gpt-text overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 bg-white dark:bg-gpt-sidebar border-b border-slate-200 dark:border-gpt-hover shrink-0 z-20 relative draggable-header cursor-move">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                    <img
                        src={chrome.runtime.getURL ? chrome.runtime.getURL("/icons/icon32.png") : "/icons/icon32.png"}
                        alt="Logo"
                        className="w-6 h-6 shrink-0"
                        onMouseDown={e => e.preventDefault()} // Prevent native image drag
                    />

                    <div className="relative min-w-0 flex-1" ref={modelMenuRef}>
                        <button
                            onMouseDown={e => e.stopPropagation()} // Allow click but don't start dragging window
                            onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
                            className="flex items-center gap-2 bg-transparent focus:outline-none cursor-pointer hover:bg-slate-100 dark:hover:bg-gpt-hover p-1.5 -ml-1.5 rounded-lg transition-colors group max-w-full"
                        >
                            <div className="flex flex-col items-start min-w-0">
                                <span className="text-[10px] font-bold text-slate-400 dark:text-gpt-secondary uppercase tracking-wider leading-none mb-0.5">
                                    {(() => {
                                        const p = config.selectedProvider;
                                        const custom = config.customProviders?.find(cp => cp.id === p);
                                        return custom ? custom.name : (ProviderDisplayNames[p] || p);
                                    })()}
                                </span>
                                <span className="text-sm font-semibold text-slate-900 dark:text-gray-100 truncate w-full text-left group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                    {config.selectedModel[config.selectedProvider] || 'Select Model'}
                                </span>
                            </div>
                            <ChevronDown size={14} className={clsx("shrink-0 text-slate-400 group-hover:text-blue-500 transition-transform", isModelMenuOpen && "rotate-180")} />
                        </button>

                        {isModelMenuOpen && (
                            <div
                                className="absolute top-full left-0 w-[260px] max-h-[400px] overflow-y-auto bg-white dark:bg-gpt-sidebar border border-slate-200 dark:border-gpt-hover rounded-xl shadow-xl z-50 mt-2 custom-scrollbar flex flex-col text-left"
                                onMouseDown={e => e.stopPropagation()}
                            >
                                <div className="p-2 sticky top-0 bg-white dark:bg-gpt-sidebar z-10 border-b border-slate-100 dark:border-gpt-hover">
                                    <div className="relative">
                                        <input
                                            ref={searchInputRef}
                                            type="text"
                                            value={modelSearch}
                                            onChange={(e) => setModelSearch(e.target.value)}
                                            placeholder="Search models..."
                                            className="w-full px-3 py-2 pr-8 text-xs bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-slate-900 dark:text-gpt-text placeholder:text-slate-400 transition-colors"
                                            onClick={(e) => e.stopPropagation()}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === 'Enter' && modelSearch.trim() && filteredModelGroups.length === 0 && allProviders.length > 0) {
                                                    // Use search term as custom model for current provider
                                                    handleModelChange(config.selectedProvider as Provider, modelSearch.trim());
                                                }
                                            }}
                                        />
                                        {modelSearch && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setModelSearch('');
                                                    searchInputRef.current?.focus();
                                                }}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                                                title="Clear search"
                                            >
                                                <X size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="py-2 overflow-y-auto">
                                    {allProviders.length === 0 && (
                                        <div className="px-4 py-3 text-xs text-slate-500 text-center">
                                            No API keys configured.<br />Click settings to add keys.
                                        </div>
                                    )}
                                    {allProviders.length > 0 && filteredModelGroups.length === 0 && (
                                        <div className="px-4 py-8 text-center">
                                            <p className="text-xs text-slate-500 dark:text-gpt-secondary mb-2">No models found</p>
                                            {modelSearch.trim() && (
                                                <p className="text-xs text-blue-500 dark:text-blue-400">Press Enter to use "<span className="font-medium">{modelSearch.trim()}</span>" as custom model</p>
                                            )}
                                        </div>
                                    )}
                                    {filteredModelGroups.map(group => (
                                        <div key={group.provider} className="mb-2 last:mb-0">
                                            <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 dark:text-gpt-secondary uppercase tracking-wider">
                                                {(() => {
                                                    const custom = config.customProviders?.find(cp => cp.id === group.provider);
                                                    return custom ? custom.name : (ProviderDisplayNames[group.provider] || group.provider);
                                                })()}
                                            </div>
                                            {group.models.map(m => {
                                                const isSelected = config.selectedProvider === group.provider && config.selectedModel[group.provider] === m;
                                                return (
                                                    <button
                                                        key={`${group.provider}:${m}`}
                                                        onClick={() => handleModelChange(group.provider, m)}
                                                        className={clsx(
                                                            "w-full text-left px-4 py-2 text-sm flex items-center justify-between group transition-colors",
                                                            isSelected
                                                                ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
                                                                : "text-slate-700 dark:text-gpt-text hover:bg-slate-50 dark:hover:bg-gpt-hover"
                                                        )}
                                                    >
                                                        <span className="truncate">{m}</span>
                                                        {isSelected && <Check size={14} />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2" onMouseDown={e => e.stopPropagation()}>
                    <button
                        onClick={() => {
                            setMessages([]);
                            setInstruction('');
                            setSelectedText('');
                            setSelectedImage(null);
                            setError('');
                            // Immediately persist cleared state
                            if (onStateChange) {
                                onStateChange({
                                    instruction: '',
                                    messages: [],
                                    selectedText: '',
                                    selectedImage: null
                                });
                            }
                        }}
                        className="text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 p-2 rounded-lg transition-all duration-200 shrink-0"
                        title="New Chat"
                    >
                        <SquarePen size={18} />
                    </button>
                    {!hideSettings && (
                        <button
                            onClick={openOptions}
                            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-gpt-hover p-2 rounded-lg transition-all duration-200 shrink-0"
                            title="Settings"
                        >
                            <Settings size={18} />
                        </button>
                    )}
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-2 rounded-lg transition-all duration-200 shrink-0"
                            title="Close"
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>
            </div>

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar text-left" onMouseDown={e => e.stopPropagation()}>
                {/* Context Badge */}
                {selectedText && messages.length === 0 && (
                    <div className="bg-blue-50 dark:bg-gpt-sidebar border border-blue-100 dark:border-gpt-hover rounded-xl p-3 mb-4">
                        <div className="flex justify-between items-start">
                            <div className="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-wider mb-1">Current Context</div>
                            <button onClick={clearTextContext} className="text-slate-400 hover:text-red-500 transition-colors" title="Clear context"><X size={14} /></button>
                        </div>
                        <div className="text-xs text-slate-600 dark:text-gpt-secondary italic line-clamp-3">
                            "{selectedText}"
                        </div>
                    </div>
                )}

                {/* Image Context Badge - Only shows before first message */}
                {selectedImage && messages.length === 0 && (
                    <div className="flex justify-end mb-4">
                        <div className="inline-flex flex-col bg-blue-50 dark:bg-gpt-sidebar border border-blue-100 dark:border-gpt-hover rounded-xl p-2">
                            <div className="flex items-center justify-between gap-3 mb-2">
                                <div className="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-wider">Image</div>
                                <button onClick={clearImageContext} className="text-slate-400 hover:text-red-500 transition-colors" title="Clear image"><Trash2 size={14} /></button>
                            </div>
                            <button
                                onClick={() => setImageZoomOpen(true)}
                                className="w-48 h-48 rounded-lg overflow-hidden border-2 border-blue-200 dark:border-gpt-hover hover:opacity-80 transition-opacity cursor-zoom-in"
                                title="Click to enlarge"
                            >
                                <img src={selectedImage} alt="Selected Context" className="w-full h-full object-cover" />
                            </button>
                        </div>
                    </div>
                )}

                {/* Image Zoom Modal - Rendered to document.body for true fullscreen */}
                {imageZoomOpen && selectedImage && createPortal(
                    <div
                        className="fixed inset-0 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
                        style={{ zIndex: 2147483647 }}
                        onClick={() => setImageZoomOpen(false)}
                    >
                        <img
                            src={selectedImage}
                            alt="Zoomed Context"
                            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
                            onClick={(e) => e.stopPropagation()}
                        />
                        <button
                            onClick={() => setImageZoomOpen(false)}
                            className="absolute top-4 right-4 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors"
                            title="Close (ESC)"
                        >
                            <X size={24} />
                        </button>
                    </div>,
                    document.body
                )}

                {/* Welcome State */}
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-32 text-center opacity-60 mt-10">
                        <Sparkles size={32} className="text-slate-300 dark:text-gpt-hover mb-2" />
                        <p className="text-sm text-slate-500 dark:text-gpt-secondary">Select a Quick Action below or type an instruction to start.</p>
                    </div>
                )}

                {/* Messages */}
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${msg.role === 'user' ? 'bg-slate-200 dark:bg-gpt-hover text-slate-500 dark:text-gpt-text' : 'bg-blue-600 text-white'}`}>
                            {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                        </div>
                        <div className={`relative group max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm dark:shadow-none ${msg.role === 'user'
                            ? 'bg-white dark:bg-gpt-input text-slate-800 dark:text-gpt-text border border-slate-200 dark:border-gpt-hover rounded-tr-none'
                            : 'bg-white dark:bg-transparent text-slate-800 dark:text-gpt-text border border-slate-200 dark:border-none rounded-tl-none px-0 py-0'
                            }`}>
                            {msg.role === 'assistant' ? (
                                <div className={clsx("prose prose-sm max-w-none prose-slate dark:prose-invert prose-p:leading-relaxed prose-pre:bg-slate-100 dark:prose-pre:bg-gpt-sidebar prose-pre:p-2 prose-pre:rounded-lg mb-4",
                                    "dark:px-0 dark:py-0 px-1"
                                )}>
                                    {/* Response content - show static text for web search messages, Thinking for loading */}
                                    {!msg.content && msg.webSearch ? (
                                        // Message has web search but no content - show static text
                                        <div className="text-sm text-slate-700 dark:text-gpt-text py-1">
                                            AI is using web search to search for "{msg.webSearch.query}"
                                        </div>
                                    ) : !msg.content && loading && idx === messages.length - 1 ? (
                                        // Empty message at the end while loading - show Thinking
                                        <div className="flex items-center gap-2 text-slate-500 dark:text-gpt-secondary py-1">
                                            <Loader2 size={14} className="animate-spin" />
                                            <span className="text-xs font-medium">Thinking...</span>
                                        </div>
                                    ) : (
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm, remarkBreaks]}
                                            components={{
                                                a: ({ node, ...props }) => {
                                                    const href = props.href || '';
                                                    if (href.startsWith('#source-')) {
                                                        const index = parseInt(href.replace('#source-', ''));
                                                        const source = msg.webSearch?.sources?.[index - 1];

                                                        if (source) {
                                                            return (
                                                                <span className="inline-flex items-center justify-center align-super text-[10px]">
                                                                    <a
                                                                        href={source.url}
                                                                        target="_blank"
                                                                        rel="noopener noreferrer"
                                                                        className="flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-blue-600 hover:text-white dark:hover:bg-blue-500 transition-colors no-underline font-medium mx-0.5"
                                                                        title={`${source.title}\n${source.url}`}
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                        }}
                                                                    >
                                                                        {index}
                                                                    </a>
                                                                </span>
                                                            );
                                                        }
                                                    }
                                                    return <a {...props} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" />;
                                                }
                                            }}
                                        >
                                            {/* Preprocess content to convert [^N] to [N](#source-N) */}
                                            {msg.content.replace(/\[\^(\d+)\]/g, '[$1](#source-$1)')}
                                        </ReactMarkdown>
                                    )}
                                    {/* Web Search Section - always shown when webSearch exists */}
                                    {msg.webSearch && (
                                        <div className="mt-3 not-prose">
                                            <div className="border border-slate-200 dark:border-gpt-hover rounded-lg overflow-hidden">
                                                <button
                                                    onClick={() => setExpandedSearches(prev => ({ ...prev, [idx]: !prev[idx] }))}
                                                    className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-gpt-sidebar hover:bg-slate-100 dark:hover:bg-gpt-hover transition-colors text-left"
                                                    disabled={msg.webSearch.isSearching}
                                                >
                                                    {msg.webSearch.isSearching ? (
                                                        <Loader2 size={14} className="animate-spin text-blue-500 shrink-0" />
                                                    ) : (
                                                        <Globe size={14} className="text-green-500 shrink-0" />
                                                    )}
                                                    <span className="text-xs font-medium text-slate-700 dark:text-gpt-text flex-1 truncate">
                                                        {msg.webSearch.isSearching ? `Searching: "${msg.webSearch.query}"...` : `Web search: "${msg.webSearch.query}"`}
                                                    </span>
                                                    {!msg.webSearch.isSearching && (
                                                        <ChevronRight size={14} className={clsx("text-slate-400 transition-transform", expandedSearches[idx] && "rotate-90")} />
                                                    )}
                                                </button>
                                                {!msg.webSearch.isSearching && expandedSearches[idx] && (
                                                    <div className="px-3 py-2 bg-white dark:bg-gpt-main border-t border-slate-200 dark:border-gpt-hover max-h-48 overflow-y-auto custom-scrollbar">
                                                        <div className="text-xs text-slate-600 dark:text-gpt-secondary">
                                                            <ReactMarkdown
                                                                remarkPlugins={[remarkGfm, remarkBreaks]}
                                                                components={{
                                                                    a: ({ node, ...props }) => {
                                                                        const href = props.href || '';
                                                                        if (href.startsWith('#source-')) {
                                                                            const index = parseInt(href.replace('#source-', ''));
                                                                            const source = msg.webSearch?.sources?.[index - 1];

                                                                            if (source) {
                                                                                return (
                                                                                    <span className="inline-flex items-center justify-center align-super text-[9px]">
                                                                                        <a
                                                                                            href={source.url}
                                                                                            target="_blank"
                                                                                            rel="noopener noreferrer"
                                                                                            className="flex items-center justify-center w-3.5 h-3.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-blue-600 hover:text-white dark:hover:bg-blue-500 transition-colors no-underline font-medium mx-0.5"
                                                                                            title={`${source.title}\n${source.url}`}
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                            }}
                                                                                        >
                                                                                            {index}
                                                                                        </a>
                                                                                    </span>
                                                                                );
                                                                            }
                                                                        }
                                                                        return <a {...props} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" />;
                                                                    }
                                                                }}
                                                            >
                                                                {msg.webSearch.result.replace(/\[\^(\d+)\]/g, '[$1](#source-$1)')}
                                                            </ReactMarkdown>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {msg.interrupted && (
                                        <div className="flex items-center gap-1.5 mt-2 text-xs text-slate-400 dark:text-slate-500 italic border-t border-slate-100 dark:border-slate-800 pt-2">
                                            <PauseCircle size={12} />
                                            <span>Stream interrupted</span>
                                        </div>
                                    )}
                                    {/* Sources Button */}
                                    {msg.webSearch?.sources && msg.webSearch.sources.length > 0 && (
                                        <button
                                            onClick={() => setSourcesModal({ sources: msg.webSearch!.sources!, query: msg.webSearch!.query })}
                                            className="flex items-center gap-1.5 mt-2 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-lg transition-colors border border-blue-200 dark:border-blue-800"
                                        >
                                            <Link2 size={12} />
                                            <span>{msg.webSearch.sources.length} Sources</span>
                                        </button>
                                    )}
                                    {msg.responseTime !== undefined && (
                                        <div className="flex items-center gap-1 mt-1 text-[10px] text-slate-400 dark:text-slate-500">
                                            <Clock size={10} />
                                            <span>{(msg.responseTime / 1000).toFixed(1)}s</span>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div>
                                    {/* Show attached image in user message */}
                                    {msg.image && (
                                        <button
                                            onClick={() => setImageZoomOpen(true)}
                                            className="mb-2 rounded-lg overflow-hidden hover:opacity-80 transition-opacity cursor-zoom-in max-w-full"
                                            title="Click to enlarge"
                                        >
                                            <img src={msg.image} alt="Attached" className="w-48 h-48 object-cover rounded-lg" />
                                        </button>
                                    )}
                                    <div className="whitespace-pre-wrap">{msg.content}</div>
                                </div>
                            )}
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(msg.content);
                                    setCopiedIndex(idx);
                                    setTimeout(() => setCopiedIndex(null), 2000);
                                }}
                                className={clsx(
                                    "absolute bottom-1 right-1 p-1 rounded-md transition-all duration-200",
                                    "opacity-0 group-hover:opacity-100 focus:opacity-100",
                                    "hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                                )}
                                title="Copy"
                            >
                                {copiedIndex === idx ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                            </button>
                        </div>
                    </div>
                ))}

                {error && (
                    <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs p-3 rounded-lg border border-red-100 dark:border-red-800 text-center">
                        {error}
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="bg-white dark:bg-gpt-main border-t border-slate-200 dark:border-gpt-hover p-4 shrink-0 z-20" onMouseDown={e => e.stopPropagation()}>
                {/* Quick Actions */}
                {messages.length === 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                        {config.prompts
                            .filter(p => !p.onlyImage || selectedImage)
                            .sort((a, b) => {
                                if (selectedImage) {
                                    if (a.onlyImage && !b.onlyImage) return -1;
                                    if (!a.onlyImage && b.onlyImage) return 1;
                                }
                                return 0;
                            })
                            .map(p => (
                                <button
                                    key={p.id}
                                    onClick={() => handlePromptClick(p)}
                                    className={clsx(
                                        "px-2.5 py-1 text-[11px] font-medium border rounded-full transition-all active:scale-95 flex items-center gap-1",
                                        p.onlyImage
                                            ? "bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/40 hover:border-purple-300"
                                            : p.immediate
                                                ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 hover:border-amber-300"
                                                : "bg-slate-50 dark:bg-gpt-sidebar border-slate-200 dark:border-gpt-hover text-slate-600 dark:text-gpt-text hover:bg-slate-100 dark:hover:bg-gpt-hover hover:border-slate-300"
                                    )}
                                >
                                    {p.onlyImage && <ImageIcon size={10} />}
                                    {p.immediate && !p.onlyImage && <Zap size={10} className="fill-current" />}
                                    {p.name}
                                </button>
                            ))}
                    </div>
                )}

                <div className="relative bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-2xl px-3 py-3 focus-within:ring-2 focus-within:ring-blue-500/20 dark:focus-within:ring-transparent focus-within:border-blue-500 dark:focus-within:border-gpt-secondary transition-all">
                    <textarea
                        ref={textareaRef}
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder={messages.length === 0 ? (selectedText ? "What should I do with the selected text?" : "Type a message...") : "Reply to continue chat..."}
                        className="w-full bg-transparent border-none focus:ring-0 p-0 pr-10 text-sm text-slate-900 dark:text-gpt-text placeholder:text-slate-400 dark:placeholder:text-zinc-500 resize-none max-h-[200px] min-h-[44px] overflow-y-auto no-scrollbar outline-none"
                        rows={1}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                        onPaste={handlePaste}
                    />
                    <div className="absolute bottom-2 right-2">
                        {loading ? (
                            <button
                                onClick={() => {
                                    if (abortControllerRef.current) {
                                        abortControllerRef.current.abort();
                                    }
                                }}
                                className="w-8 h-8 bg-red-500 hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-600 text-white rounded-lg shadow-md hover:shadow-lg transition-all duration-200 flex items-center justify-center animate-in zoom-in spin-in-90 duration-200"
                                title="Stop generating"
                            >
                                <Square size={12} fill="currentColor" />
                            </button>
                        ) : (
                            <button
                                onClick={() => handleSubmit()}
                                disabled={!instruction.trim()}
                                className="w-8 h-8 bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 text-white rounded-lg shadow-md hover:shadow-lg disabled:opacity-50 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:text-slate-500 dark:disabled:text-slate-400 disabled:cursor-not-allowed disabled:shadow-none transition-all duration-200 flex items-center justify-center"
                            >
                                <Send size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Sources Modal */}
            {sourcesModal && (
                <div
                    className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
                    onClick={() => setSourcesModal(null)}
                >
                    <div
                        className="bg-white dark:bg-gpt-sidebar rounded-xl shadow-2xl max-w-md w-full mx-4 max-h-[70vh] flex flex-col overflow-hidden"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Modal Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-gpt-hover">
                            <div className="flex items-center gap-2">
                                <Link2 size={16} className="text-blue-500" />
                                <span className="font-semibold text-slate-800 dark:text-gpt-text">Sources</span>
                            </div>
                            <button
                                onClick={() => setSourcesModal(null)}
                                className="p-1 hover:bg-slate-100 dark:hover:bg-gpt-hover rounded-lg transition-colors text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Citations Label */}
                        <div className="px-4 py-2 bg-slate-50 dark:bg-gpt-main border-b border-slate-200 dark:border-gpt-hover">
                            <span className="text-xs font-semibold text-slate-500 dark:text-gpt-secondary uppercase tracking-wide">Citations</span>
                        </div>

                        {/* Sources List */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {sourcesModal.sources.map((source, idx) => (
                                <a
                                    key={idx}
                                    href={source.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-gpt-hover transition-colors border-b border-slate-100 dark:border-gpt-hover last:border-b-0 group"
                                >
                                    <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0 mt-0.5">
                                        <Globe size={12} className="text-blue-500" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium text-slate-800 dark:text-gpt-text group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors line-clamp-2">
                                            {source.title || `Source ${idx + 1}`}
                                        </div>
                                        <div className="text-xs text-slate-500 dark:text-gpt-secondary truncate mt-0.5">
                                            {source.url}
                                        </div>
                                        {source.snippet && (
                                            <div className="text-xs text-slate-600 dark:text-gpt-secondary mt-1 line-clamp-2">
                                                {source.snippet}
                                            </div>
                                        )}
                                    </div>
                                    <ExternalLink size={14} className="text-slate-400 group-hover:text-blue-500 transition-colors shrink-0 mt-1" />
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
