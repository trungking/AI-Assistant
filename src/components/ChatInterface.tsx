import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { type AppConfig, type ChatMessage, type PromptTemplate, type Provider } from '../lib/types';
import { callApi, fetchModels } from '../lib/api';
import { Send, Settings, Sparkles, Loader2, User, Bot, Trash2, Zap, Image as ImageIcon, ChevronDown, ChevronRight, Check, X, Copy, PauseCircle, SquarePen, Clock, Globe, Link2, ExternalLink, Square, RefreshCw } from 'lucide-react';
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
    const [expandedReasoning, setExpandedReasoning] = useState<Record<number, boolean>>({});
    const [reasoningStartTime, setReasoningStartTime] = useState<Record<number, number>>({});
    const [reasoningElapsed, setReasoningElapsed] = useState<Record<number, number>>({});
    const [, forceUpdate] = useState(0); // Force re-render for timer updates
    const [sourcesModal, setSourcesModal] = useState<{ sources: Array<{ title: string; url: string; snippet?: string }>; query: string } | null>(null);
    const [imageZoomOpen, setImageZoomOpen] = useState(false);
    const [retryModelMenuOpen, setRetryModelMenuOpen] = useState<number | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const retryModelMenuRef = useRef<HTMLDivElement>(null);
    const modelMenuRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [modelSearch, setModelSearch] = useState('');

    // Abort controller for streaming
    const abortControllerRef = useRef<AbortController | null>(null);

    // Ref for reasoning start times (for synchronous access)
    const reasoningStartTimeRef = useRef<Record<number, number>>({});

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

                    // Calculate and save reasoning time if reasoning was happening
                    const msgIndex = currentMsgs.length - 1;
                    if (reasoningStartTimeRef.current[msgIndex]) {
                        const finalElapsed = Math.floor((Date.now() - reasoningStartTimeRef.current[msgIndex]) / 1000);
                        lastMsg.reasoningTime = finalElapsed;
                    }
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

    // Initialize reasoning elapsed times from saved messages
    useEffect(() => {
        if (initialMessages.length > 0) {
            const elapsed: Record<number, number> = {};
            initialMessages.forEach((msg, idx) => {
                if (msg.reasoningTime !== undefined) {
                    elapsed[idx] = msg.reasoningTime;
                }
            });
            if (Object.keys(elapsed).length > 0) {
                setReasoningElapsed(elapsed);
            }
        }
    }, [initialMessages]);

    // Handle auto-execution
    useEffect(() => {
        if (pendingAutoPrompt) {
            // Use initialText (fresh selection) not selectedText (may have stale data)
            // Check both initialImage and selectedImage for image context (pasted images)
            // Also don't auto-submit if there's an existing conversation
            const hasFreshContext = !!initialText || !!initialImage || !!selectedImage;
            const hasExistingConversation = initialMessages && initialMessages.length > 0;

            // Build config override if prompt has a specific model
            let promptConfig: AppConfig | undefined;
            if (pendingAutoPrompt.model) {
                promptConfig = {
                    ...config,
                    selectedProvider: pendingAutoPrompt.model.provider,
                    selectedModel: {
                        ...config.selectedModel,
                        [pendingAutoPrompt.model.provider]: pendingAutoPrompt.model.modelName
                    }
                };
            }

            if (pendingAutoPrompt.immediate && hasFreshContext && !hasExistingConversation) {
                handleSubmit(pendingAutoPrompt.content, promptConfig);
            } else {
                // Just fill the input without auto-submitting
                // Always strip ${text} placeholder when filling input manually
                let promptContent = pendingAutoPrompt.content
                    .replace(/\$\{text\}/g, '')
                    .replace(/\n\n+/g, '\n\n')
                    .trim();
                setInstruction(promptContent);

                // If prompt has a model, temporarily switch to it
                if (promptConfig) {
                    setConfig(promptConfig);
                }

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

    // Auto-scroll disabled - users can manually scroll if needed
    // useEffect(() => {
    //     scrollToBottom();
    // }, [messages, loading]);

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
            if (retryModelMenuRef.current && !retryModelMenuRef.current.contains(event.target as Node)) {
                setRetryModelMenuOpen(null);
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

    // Auto-focus textarea when popup is first shown
    useEffect(() => {
        // Focus the textarea after component mounts
        // Small delay ensures the component is fully rendered
        const timer = setTimeout(() => {
            if (textareaRef.current) {
                textareaRef.current.focus();
            }
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    // Force update every second for timer display
    useEffect(() => {
        const interval = setInterval(() => {
            // Check if any message has active reasoning
            const hasActiveReasoning = messages.some((msg, idx) =>
                msg.reasoning && !msg.interrupted && reasoningStartTime[idx]
            );
            if (hasActiveReasoning) {
                forceUpdate(prev => prev + 1);
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [messages, reasoningStartTime]);


    const scrollToBottom = () => {
        // Use setTimeout to ensure DOM has updated
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 100);
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

        // Build config override if prompt has a specific model
        let promptConfig: AppConfig | undefined;
        if (prompt.model) {
            promptConfig = {
                ...config,
                selectedProvider: prompt.model.provider,
                selectedModel: {
                    ...config.selectedModel,
                    [prompt.model.provider]: prompt.model.modelName
                }
            };
        }

        if (prompt.immediate && hasFreshContext && !hasExistingConversation) {
            handleSubmit(prompt.content, promptConfig);
        } else {
            // Always strip ${text} placeholder when filling input manually
            let promptContent = prompt.content
                .replace(/\$\{text\}/g, '')
                .replace(/\n\n+/g, '\n\n')  // Remove extra newlines
                .trim();
            setInstruction(promptContent);

            // If prompt has a model, temporarily switch to it
            if (promptConfig) {
                setConfig(promptConfig);
            }

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

    const handleRetryWithModel = async (messageIndex: number, provider: string, model: string) => {
        // Close the retry menu
        setRetryModelMenuOpen(null);

        // Remove the assistant message being retried (keep all messages before it)
        const newMessages = messages.slice(0, messageIndex);
        setMessages(newMessages);

        // Temporarily switch to the backup model
        const previousProvider = config.selectedProvider;
        const previousModel = config.selectedModel[previousProvider];

        const tempConfig = {
            ...config,
            selectedProvider: provider,
            selectedModel: {
                ...config.selectedModel,
                [provider]: model
            }
        };
        setConfig(tempConfig);

        setLoading(true);
        setError('');

        // Track response time
        const startTime = Date.now();

        // Abort previous if any
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();

        // Add placeholder assistant message
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
        setMessages([...newMessages, assistantMsg]);

        // Scroll to bottom when retrying
        scrollToBottom();

        let accumulatedText = '';
        let accumulatedReasoning = '';
        let isInNewMessage = false;

        try {
            const res = await callApi(newMessages, tempConfig, (chunk) => {
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
                if (searchStatus.startNewMessage) {
                    // Create a new message for the follow-up response
                    // This can happen multiple times for sequential web searches
                    accumulatedText = ''; // Reset for new message
                    accumulatedReasoning = ''; // Reset reasoning for new message
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
                        // Add new assistant message for the follow-up (no webSearch on this one yet)
                        return [...updated, { role: 'assistant', content: '' }];
                    });
                    isInNewMessage = true;
                } else {
                    // Update web search info on current message (search in progress)
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
            }, (reasoningChunk) => {
                // Handle reasoning content (from models like DeepSeek)
                accumulatedReasoning += reasoningChunk;
                const msgIndex = newMessages.length; // Index of the assistant message

                // Start timer when first reasoning chunk arrives
                if (accumulatedReasoning === reasoningChunk) {
                    const startTime = Date.now();
                    reasoningStartTimeRef.current[msgIndex] = startTime;
                    setReasoningStartTime(prev => ({ ...prev, [msgIndex]: startTime }));
                }

                setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === 'assistant') {
                        last.reasoning = accumulatedReasoning;
                    }
                    return updated;
                });
            });

            if (res.error) {
                setError(res.error);
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                // Aborted - still record response time for interrupted messages
                const responseTime = Date.now() - startTime;
                const msgIndex = newMessages.length;

                // Calculate and store final reasoning time if reasoning was happening
                if (reasoningStartTimeRef.current[msgIndex]) {
                    const finalElapsed = Math.floor((Date.now() - reasoningStartTimeRef.current[msgIndex]) / 1000);
                    setReasoningElapsed(prev => ({ ...prev, [msgIndex]: finalElapsed }));

                    // Also save to the message itself for persistence
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.interrupted = true;
                            last.responseTime = responseTime;
                            last.reasoningTime = finalElapsed;
                        }
                        return updated;
                    });
                } else {
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.interrupted = true;
                            last.responseTime = responseTime;
                        }
                        return updated;
                    });
                }
            } else {
                setError(err.message);
            }
        } finally {
            setLoading(false);
            abortControllerRef.current = null;

            // Restore original model selection
            const restoredConfig = {
                ...config,
                selectedProvider: previousProvider,
                selectedModel: {
                    ...config.selectedModel,
                    [previousProvider]: previousModel
                }
            };
            setConfig(restoredConfig);
        }
    };

    const handleSubmit = async (overrideInstruction?: string, overrideConfig?: AppConfig) => {
        const textToSubmit = overrideInstruction !== undefined ? overrideInstruction : instruction;
        const activeConfig = overrideConfig || config;

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

        // Scroll to bottom when user sends a message
        scrollToBottom();

        let accumulatedText = '';
        let accumulatedReasoning = '';
        let isInNewMessage = false;

        try {
            const res = await callApi(newMessages, activeConfig, (chunk) => {
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
                if (searchStatus.startNewMessage) {
                    // Create a new message for the follow-up response
                    // This can happen multiple times for sequential web searches
                    accumulatedText = ''; // Reset for new message
                    accumulatedReasoning = ''; // Reset reasoning for new message
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
                        // Add new assistant message for the follow-up (no webSearch on this one yet)
                        return [...updated, { role: 'assistant', content: '' }];
                    });
                    isInNewMessage = true;
                } else {
                    // Update web search info on current message (search in progress)
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
            }, (reasoningChunk) => {
                // Handle reasoning content (from models like DeepSeek)
                accumulatedReasoning += reasoningChunk;
                const msgIndex = newMessages.length; // Index of the assistant message

                // Start timer when first reasoning chunk arrives
                if (accumulatedReasoning === reasoningChunk) {
                    const startTime = Date.now();
                    reasoningStartTimeRef.current[msgIndex] = startTime;
                    setReasoningStartTime(prev => ({ ...prev, [msgIndex]: startTime }));
                }

                setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === 'assistant') {
                        last.reasoning = accumulatedReasoning;
                    }
                    return updated;
                });
            });

            // Check for multimodal error when using a model that doesn't support images
            if (res.error && messagePayload.image) {
                const isMultimodalError = res.error.toLowerCase().includes('content must be a string') ||
                    res.error.toLowerCase().includes('must be a string') ||
                    res.error.includes('.content must be a string');

                if (isMultimodalError) {
                    // Fallback to default config - model doesn't support images
                    console.log('Prompt model does not support images, falling back to default model');

                    // Reset accumulated text for retry
                    accumulatedText = '';
                    accumulatedReasoning = '';
                    isInNewMessage = false;

                    // Reset the assistant message
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.content = '';
                            last.reasoning = undefined;
                        }
                        return updated;
                    });

                    // Create new abort controller for retry
                    abortControllerRef.current = new AbortController();

                    // Retry with original config (before any prompt model overrides)
                    const fallbackRes = await callApi(newMessages, initialConfig, (chunk) => {
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
                    }, abortControllerRef.current.signal, (searchStatus) => {
                        if (searchStatus.startNewMessage) {
                            accumulatedText = '';
                            accumulatedReasoning = '';
                            setMessages(prev => {
                                const updated = [...prev];
                                const prevLast = updated[updated.length - 1];
                                if (prevLast && prevLast.role === 'assistant') {
                                    prevLast.webSearch = {
                                        query: searchStatus.query,
                                        result: searchStatus.result || '',
                                        isSearching: false,
                                        sources: searchStatus.sources
                                    };
                                }
                                return [...updated, { role: 'assistant', content: '' }];
                            });
                            isInNewMessage = true;
                        } else {
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
                    }, (reasoningChunk) => {
                        accumulatedReasoning += reasoningChunk;
                        const msgIndex = newMessages.length;
                        if (accumulatedReasoning === reasoningChunk) {
                            const reasoningStart = Date.now();
                            reasoningStartTimeRef.current[msgIndex] = reasoningStart;
                            setReasoningStartTime(prev => ({ ...prev, [msgIndex]: reasoningStart }));
                        }
                        setMessages(prev => {
                            const updated = [...prev];
                            const last = updated[updated.length - 1];
                            if (last && last.role === 'assistant') {
                                last.reasoning = accumulatedReasoning;
                            }
                            return updated;
                        });
                    });

                    if (fallbackRes.error) {
                        setError(fallbackRes.error);
                    }
                    // Don't show fallback notice - just work silently
                    return;
                }
            }

            if (res.error) {
                setError(res.error);
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                // Aborted - still record response time for interrupted messages
                const responseTime = Date.now() - startTime;
                const msgIndex = newMessages.length;

                // Calculate and store final reasoning time if reasoning was happening
                if (reasoningStartTimeRef.current[msgIndex]) {
                    const finalElapsed = Math.floor((Date.now() - reasoningStartTimeRef.current[msgIndex]) / 1000);
                    setReasoningElapsed(prev => ({ ...prev, [msgIndex]: finalElapsed }));

                    // Also save to the message itself for persistence
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.interrupted = true;
                            last.responseTime = responseTime;
                            last.reasoningTime = finalElapsed;
                        }
                        return updated;
                    });
                } else {
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            last.interrupted = true;
                            last.responseTime = responseTime;
                        }
                        return updated;
                    });
                }
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
                                    {/* Reasoning Section - shown when reasoning content exists */}
                                    {msg.reasoning && (
                                        <div className="mb-2 not-prose">
                                            <button
                                                onClick={() => {
                                                    const isExpanded = expandedReasoning[idx] ?? config.alwaysExpandReasoning ?? false;
                                                    setExpandedReasoning(prev => ({ ...prev, [idx]: !isExpanded }));
                                                }}
                                                className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-gpt-secondary hover:text-slate-700 dark:hover:text-gpt-text transition-colors w-full group py-1 text-left"
                                            >
                                                {loading && idx === messages.length - 1 && !msg.content ? (
                                                    <Loader2 size={14} className="animate-spin text-blue-500 shrink-0" />
                                                ) : (
                                                    <Sparkles size={14} className="text-blue-500 shrink-0" />
                                                )}
                                                <span className="truncate flex-1">
                                                    {(() => {
                                                        const lastStep = msg.reasoning?.match(/(?:^|\n)\*\*([^\*]+)\*\*/g)?.pop()?.replace(/[\n\*]/g, '').trim();
                                                        if (lastStep) return <span className="text-slate-700 dark:text-gray-300">{lastStep}</span>;
                                                        return loading && idx === messages.length - 1 && !msg.content ? 'Reasoning...' : 'Reasoning';
                                                    })()}
                                                </span>
                                                <div className="opacity-50 group-hover:opacity-100 transition-opacity">
                                                    {(expandedReasoning[idx] ?? config.alwaysExpandReasoning ?? false) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                </div>
                                            </button>

                                            {(expandedReasoning[idx] ?? config.alwaysExpandReasoning ?? false) && (
                                                <div className="mt-1 pl-3 border-l-2 border-slate-200 dark:border-slate-700 ml-1.5">
                                                    <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed max-h-[30vh] overflow-y-auto custom-scrollbar">
                                                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                                            {msg.reasoning.replace(/(\*\*[^\*]+\*\*)\n(?!\n)/g, '$1\n\n')}
                                                        </ReactMarkdown>
                                                    </div>
                                                </div>
                                            )}

                                            <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-500 ml-1.5">
                                                Reasoning for {(() => {
                                                    // First, check if message has stored reasoningTime (for persistence)
                                                    if (msg.reasoningTime !== undefined) {
                                                        return msg.reasoningTime;
                                                    }
                                                    // If interrupted, show stored final time from state
                                                    if (msg.interrupted && reasoningElapsed[idx] !== undefined) {
                                                        return reasoningElapsed[idx];
                                                    }
                                                    // If still processing, calculate real-time
                                                    if (reasoningStartTime[idx]) {
                                                        return Math.floor((Date.now() - reasoningStartTime[idx]) / 1000);
                                                    }
                                                    // Fallback
                                                    return 0;
                                                })()} seconds
                                            </div>
                                        </div>
                                    )}
                                    {/* Response content - show static text for web search messages, Thinking for loading */}
                                    {!msg.content && msg.webSearch ? (
                                        // Message has web search but no content - show static text
                                        <div className="text-sm text-slate-700 dark:text-gpt-text py-1">
                                            AI is using web search to search for "{msg.webSearch.query}"
                                        </div>
                                    ) : !msg.content && loading && idx === messages.length - 1 && !msg.reasoning ? (
                                        // Empty message at the end while loading (and no reasoning) - show Thinking
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
                            {/* Only show copy button when response is complete */}
                            {!(loading && idx === messages.length - 1) && msg.content && (
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
                            )}
                            {/* Response time and retry button row */}
                            {msg.role === 'assistant' && msg.content && !(loading && idx === messages.length - 1) && (
                                <div className="flex items-center gap-2 mt-2">
                                    {/* Response time */}
                                    {msg.responseTime !== undefined && (
                                        <div className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500">
                                            <Clock size={10} />
                                            <span>{(msg.responseTime / 1000).toFixed(1)}s</span>
                                        </div>
                                    )}
                                    {/* Try with another model button */}
                                    <div className="relative" ref={retryModelMenuOpen === idx ? retryModelMenuRef : null}>
                                        <button
                                            onClick={() => setRetryModelMenuOpen(retryModelMenuOpen === idx ? null : idx)}
                                            className="p-1 text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                                            title="Try with another model"
                                        >
                                            <RefreshCw size={12} />
                                        </button>

                                        {/* Backup models dropdown */}
                                        {retryModelMenuOpen === idx && config.backupModels && (
                                            <div className="absolute bottom-full left-0 mb-1 w-56 max-h-64 overflow-y-auto bg-white dark:bg-gpt-sidebar border border-slate-200 dark:border-gpt-hover rounded-xl shadow-xl z-50 custom-scrollbar">
                                                <div className="py-1">
                                                    {(() => {
                                                        // Collect all backup models from all providers
                                                        const allBackups = Object.entries(config.backupModels).flatMap(([provider, models]) =>
                                                            models.map(m => ({ ...m, fromProvider: provider }))
                                                        );

                                                        if (allBackups.length === 0) {
                                                            return (
                                                                <div className="px-4 py-3 text-xs text-slate-500 text-center">
                                                                    No backup models configured.<br />
                                                                    <span className="text-[10px]">Add them in Settings</span>
                                                                </div>
                                                            );
                                                        }

                                                        // Group by provider
                                                        const groupedBackups = allBackups.reduce((acc, backup) => {
                                                            if (!acc[backup.provider]) {
                                                                acc[backup.provider] = [];
                                                            }
                                                            acc[backup.provider].push(backup);
                                                            return acc;
                                                        }, {} as Record<string, typeof allBackups>);

                                                        return Object.entries(groupedBackups).map(([provider, models]) => (
                                                            <div key={provider} className="mb-1 last:mb-0">
                                                                <div className="px-3 py-1 text-[10px] font-bold text-slate-400 dark:text-gpt-secondary uppercase tracking-wider">
                                                                    {(() => {
                                                                        const custom = config.customProviders?.find(cp => cp.id === provider);
                                                                        return custom ? custom.name : (ProviderDisplayNames[provider] || provider);
                                                                    })()}
                                                                </div>
                                                                {models.map((backup, backupIdx) => (
                                                                    <button
                                                                        key={`${backup.provider}-${backup.model}-${backupIdx}`}
                                                                        onClick={() => handleRetryWithModel(idx, backup.provider, backup.model)}
                                                                        className="w-full text-left px-4 py-2 text-xs text-slate-700 dark:text-gpt-text hover:bg-slate-50 dark:hover:bg-gpt-hover transition-colors"
                                                                    >
                                                                        <div className="truncate">{backup.model}</div>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        ));
                                                    })()}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
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
