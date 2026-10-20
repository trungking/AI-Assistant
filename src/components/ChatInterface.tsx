import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { type AppConfig, type ChatMessage, type PromptTemplate, type Provider } from '../lib/types';
import { callApi, fetchModels } from '../lib/api';
import { Send, Settings, Sparkles, Loader2, User, Bot, Trash2, Zap, Image as ImageIcon, ChevronDown, ChevronRight, Check, X, Copy, PauseCircle, SquarePen, Clock, Globe, Link2, ExternalLink, Square, RefreshCw, Download, RotateCcw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import { clsx } from 'clsx';
import { setStorage } from '../lib/storage';
import { CHROME_NANO_MODEL, CHROME_PROVIDER, destroyChromeNanoSession, getChromeNanoAvailability } from '../lib/chromeNano';

const markdownRemarkPlugins: PluggableList = [
    remarkGfm,
    remarkBreaks,
    remarkMath
];

const markdownRehypePlugins: PluggableList = [rehypeKatex];

const isEscapedDollar = (content: string, index: number) => {
    let backslashCount = 0;

    for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) {
        backslashCount++;
    }

    return backslashCount % 2 === 1;
};

const countDollarRun = (content: string, index: number) => {
    let runLength = 0;

    while (content[index + runLength] === '$') {
        runLength++;
    }

    return runLength;
};

const findClosingDollarRun = (content: string, startIndex: number, runLength: number) => {
    for (let i = startIndex; i < content.length; i++) {
        if (runLength === 1 && (content[i] === '\n' || content[i] === '\r')) {
            return -1;
        }

        if (content[i] !== '$' || isEscapedDollar(content, i)) {
            continue;
        }

        const closeRunLength = countDollarRun(content, i);

        if (closeRunLength === runLength) {
            return i;
        }

        i += closeRunLength - 1;
    }

    return -1;
};

const isLikelyInlineMath = (value: string) => {
    const trimmed = value.trim();

    if (!trimmed || trimmed !== value || /[\r\n]/.test(value)) {
        return false;
    }

    if (/^[=+\-*/^_<>,|~]/.test(trimmed) || /[=+\-*/^_<>,|~]$/.test(trimmed)) {
        return false;
    }

    if (/\\[a-zA-Z]+/.test(trimmed)) {
        return true;
    }

    if (!/[0-9a-zA-Z]/.test(trimmed)) {
        return false;
    }

    const mathCharactersOnly = /^[0-9a-zA-Z\s{}()[\].,=+\-*/^_<>,|:;!]+$/.test(trimmed);

    if (!mathCharactersOnly) {
        return false;
    }

    if (!/\s/.test(trimmed)) {
        return true;
    }

    if (!/[=+\-*/^_<>|~]/.test(trimmed)) {
        return false;
    }

    return !/\b(and|or|the|is|are|was|were|be|to|for|from|with|without|because|itself|today|tomorrow|tax|price|cost|costs|dollar|dollars)\b/i.test(trimmed);
};

// Keep likely $...$ math intact, but escape lone dollars before remark-math can pair currency amounts with later text.
const escapeCurrencyDollars = (content: string) => {
    let result = '';

    for (let i = 0; i < content.length; i++) {
        if (content[i] !== '$' || isEscapedDollar(content, i)) {
            result += content[i];
            continue;
        }

        const runLength = countDollarRun(content, i);

        if (runLength > 1) {
            const closingIndex = findClosingDollarRun(content, i + runLength, runLength);

            if (closingIndex !== -1) {
                result += content.slice(i, closingIndex + runLength);
                i = closingIndex + runLength - 1;
            } else {
                result += content.slice(i, i + runLength);
                i += runLength - 1;
            }

            continue;
        }

        const closingIndex = findClosingDollarRun(content, i + 1, runLength);

        if (closingIndex !== -1 && isLikelyInlineMath(content.slice(i + 1, closingIndex))) {
            result += content.slice(i, closingIndex + runLength);
            i = closingIndex + runLength - 1;
            continue;
        }

        result += '\\$';
    }

    return result;
};

// Extracts the raw text from a react-markdown <pre><code> node tree so the
// clipboard gets the unformatted source (no trailing newline added by the DOM).
const extractTextFromNode = (node: any): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(extractTextFromNode).join('');
    if (typeof node === 'object' && 'props' in node) {
        return extractTextFromNode((node as any).props?.children);
    }
    return '';
};

// Renders a fenced code block with a hover copy button. Inline code is left untouched.
const CodeBlock = ({ node, children, ...props }: any) => {
    const [copied, setCopied] = useState(false);
    const raw = extractTextFromNode(node) || extractTextFromNode(children) || '';

    return (
        <div className="relative group/code my-4">
            <button
                onClick={() => {
                    navigator.clipboard.writeText(raw.replace(/\n$/, ''));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                }}
                className="absolute right-2 top-2 p-1 rounded-md bg-white/80 dark:bg-gpt-hover/80 text-slate-500 dark:text-slate-300 hover:text-slate-800 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-600 opacity-0 group-hover/code:opacity-100 focus:opacity-100 transition-all duration-200"
                title={copied ? 'Copied' : 'Copy code'}
            >
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
            <pre {...props} className="whitespace-pre-wrap break-words">{children}</pre>
        </div>
    );
};

type WebSearchEntry = NonNullable<ChatMessage['webSearches']>[number];
type WebSearchStatus = Parameters<NonNullable<Parameters<typeof callApi>[4]>>[0];

// Returns a new list with the entry for the same query replaced, or the entry appended
const upsertWebSearch = (searches: WebSearchEntry[] | undefined, entry: WebSearchEntry): WebSearchEntry[] => {
    const list = searches ? [...searches] : [];
    const existingIdx = list.findIndex(s => s.query === entry.query);
    if (existingIdx >= 0) {
        list[existingIdx] = entry;
    } else {
        list.push(entry);
    }
    return list;
};

// True if every message in `prefix` matches the message at the same position in `list`
const isMessagePrefix = (prefix: ChatMessage[], list: ChatMessage[]) =>
    prefix.every((m, i) => list[i] && list[i].role === m.role && list[i].content === m.content);

const ProviderDisplayNames: Record<string, string> = {
    chrome: 'Chrome',
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
    const [expandedSearches, setExpandedSearches] = useState<Record<string, boolean>>({});
    const [expandedReasoning, setExpandedReasoning] = useState<Record<number, boolean>>({});
    const [reasoningStartTime, setReasoningStartTime] = useState<Record<number, number>>({});
    const [reasoningElapsed, setReasoningElapsed] = useState<Record<number, number>>({});
    const [, forceUpdate] = useState(0); // Force re-render for timer updates
    const [sourcesModal, setSourcesModal] = useState<{ sources: Array<{ title: string; url: string; snippet?: string }>; query: string } | null>(null);
    const [imageZoomOpen, setImageZoomOpen] = useState(false);
    const [generatedImageZoom, setGeneratedImageZoom] = useState<string | null>(null);
    const [retryModelMenuOpen, setRetryModelMenuOpen] = useState<number | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const retryModelMenuRef = useRef<HTMLDivElement>(null);
    const modelMenuRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [modelSearch, setModelSearch] = useState('');
    const [chromeNanoAvailable, setChromeNanoAvailable] = useState(false);

    useEffect(() => {
        let mounted = true;
        getChromeNanoAvailability().then(availability => {
            if (mounted && availability === 'available') {
                setChromeNanoAvailable(true);
                setAvailableModels(prev => ({ ...prev, [CHROME_PROVIDER]: [CHROME_NANO_MODEL] }));
            }
        });
        return () => { mounted = false; };
    }, []);

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
    // Parents may pass a new callback every render; effects read it from here
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;
    const mountedRef = useRef(true);

    // Sync refs
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    useEffect(() => { loadingRef.current = loading; }, [loading]);
    useEffect(() => { instructionRef.current = instruction; }, [instruction]);
    useEffect(() => { selectedTextRef.current = selectedText; }, [selectedText]);
    useEffect(() => { selectedImageRef.current = selectedImage; }, [selectedImage]);

    // Cleanup on unmount - always save state, DON'T abort the stream
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            destroyChromeNanoSession();
            // Always save current state on unmount so it can be restored
            if (onStateChangeRef.current) {
                onStateChangeRef.current({
                    instruction: instructionRef.current,
                    messages: [...messagesRef.current],
                    selectedText: selectedTextRef.current,
                    selectedImage: selectedImageRef.current
                });
            }
        };
    }, []);

    // Reconnect to active background stream on mount
    useEffect(() => {
        const checkActiveStream = async () => {
            try {
                // Skip reconnection if we have a pending auto prompt -
                // it will start its own fresh API call
                if (pendingAutoPrompt) {
                    await chrome.storage.local.remove('activeStream');
                    return;
                }

                const storage = await chrome.storage.local.get('activeStream');
                if (!storage.activeStream) return;

                const stream = storage.activeStream as {
                    id: string;
                    accumulatedText: string;
                    accumulatedReasoning: string;
                    messages: any[];
                    webSearches: any[];
                    images: string[];
                    done: boolean;
                    error: string | null;
                    startTime: number;
                };

                // If the stream is already done and has accumulated text, we can
                // reconstruct the conversation directly from storage without reconnecting.
                // This handles the case where the background service worker restarted
                // and lost its in-memory state.
                if (stream.done && stream.accumulatedText) {
                    const streamMessages = (stream.messages || []) as ChatMessage[];
                    const current = messagesRef.current;
                    // Don't let a finished stream override a different/newer conversation
                    // (current may lag behind the stream if it was saved before the send)
                    const belongsToCurrent = current.length === 0 || (current.length <= streamMessages.length
                        ? isMessagePrefix(current, streamMessages)
                        : isMessagePrefix(streamMessages, current) && current.slice(streamMessages.length).every(m => m.role === 'assistant'));
                    if (!belongsToCurrent) {
                        chrome.storage.local.remove('activeStream');
                        return;
                    }
                    const restoredMessages: ChatMessage[] = [
                        ...streamMessages,
                        {
                            role: 'assistant' as const,
                            content: stream.accumulatedText,
                            reasoning: stream.accumulatedReasoning || undefined,
                            webSearches: stream.webSearches?.length > 0 ? stream.webSearches : undefined,
                            images: stream.images?.length > 0 ? stream.images : undefined,
                            responseTime: stream.startTime ? Date.now() - stream.startTime : undefined,
                        }
                    ];
                    setMessages(restoredMessages);
                    // Save the restored state
                    if (onStateChangeRef.current) {
                        onStateChangeRef.current({
                            instruction: '',
                            messages: restoredMessages,
                            selectedText: '',
                            selectedImage: null
                        });
                    }
                    // Clear the stale active stream record
                    chrome.storage.local.remove('activeStream');
                    return;
                }

                // If the stream is marked done but has no text, it's a stale/empty record.
                // Just clean it up and keep the current messages (from popupState).
                if (stream.done && !stream.accumulatedText) {
                    chrome.storage.local.remove('activeStream');
                    return;
                }

                // There's an active (in-progress) stream - reconnect to it
                // Save original messages so we can restore if background has no stream
                const savedMessages = [...messagesRef.current];

                // Restore the original conversation messages (including user's question),
                // plus an empty assistant placeholder so "Thinking..." shows and reasoning,
                // web searches and images that arrive before the first text chunk have a target
                if (stream.messages && stream.messages.length > 0) {
                    setMessages([...(stream.messages as ChatMessage[]), { role: 'assistant', content: '' }]);
                }

                setLoading(true);

                // Create an AbortController so the Stop button works during reconnection
                const reconnectController = new AbortController();
                abortControllerRef.current = reconnectController;

                const port = chrome.runtime.connect({ name: `stream_reconnect:${stream.id}` });
                let reconnectedText = '';
                let reconnectedReasoning = '';

                // Immutably update the streaming assistant message (the last one), adding it if missing
                const updateStreamingAssistant = (update: (msg: ChatMessage) => Partial<ChatMessage>) => {
                    setMessages(prev => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last && last.role === 'assistant') {
                            updated[updated.length - 1] = { ...last, ...update(last) };
                        } else {
                            const placeholder: ChatMessage = { role: 'assistant', content: '' };
                            updated.push({ ...placeholder, ...update(placeholder) });
                        }
                        return updated;
                    });
                };

                const markLastInterrupted = () => {
                    setMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (!last || last.role !== 'assistant') return prev;
                        return [...prev.slice(0, -1), { ...last, interrupted: true }];
                    });
                };

                // Handle abort from Stop button
                reconnectController.signal.addEventListener('abort', () => {
                    chrome.runtime.sendMessage({ action: 'abort_stream', streamId: stream.id }).catch(() => { });
                    port.disconnect();
                    setLoading(false);
                    if (abortControllerRef.current === reconnectController) {
                        abortControllerRef.current = null;
                    }
                    // Mark last message as interrupted
                    markLastInterrupted();
                    chrome.runtime.sendMessage({ action: 'clear_active_stream', streamId: stream.id }).catch(() => { });
                });

                // Helper to save final state. Deferred so pending message updates have
                // committed and messagesRef is current.
                const saveReconnectedState = () => {
                    setTimeout(() => {
                        onStateChangeRef.current?.({
                            instruction: instructionRef.current,
                            messages: messagesRef.current,
                            selectedText: selectedTextRef.current,
                            selectedImage: selectedImageRef.current
                        });
                    }, 0);
                };

                port.onMessage.addListener((msg) => {
                    if (msg.noStream) {
                        // Background service worker restarted and lost the stream.
                        // Restore the original messages from popupState (before we overwrote them).
                        // Checked first: older backgrounds send it together with done: true.
                        port.disconnect();
                        setLoading(false);
                        abortControllerRef.current = null;
                        setMessages(savedMessages);
                        chrome.storage.local.remove('activeStream');
                        return;
                    }

                    if (msg.reconnected) {
                        // Stream is still running, we received buffered data
                        // Now listen for new chunks
                        return;
                    }

                    if (msg.chunk) {
                        reconnectedText += msg.chunk;
                        const content = reconnectedText;
                        const responseTime = Date.now() - stream.startTime;
                        updateStreamingAssistant(() => ({ content, responseTime }));
                    } else if (msg.reasoning) {
                        reconnectedReasoning += msg.reasoning;
                        const reasoning = reconnectedReasoning;
                        updateStreamingAssistant(() => ({ reasoning }));
                    } else if (msg.webSearch) {
                        const newEntry = {
                            query: msg.webSearch.query,
                            result: msg.webSearch.result || '',
                            isSearching: msg.webSearch.isSearching,
                            sources: msg.webSearch.sources
                        };
                        // Update existing entry for same query or append
                        updateStreamingAssistant(last => ({ webSearches: upsertWebSearch(last.webSearches, newEntry) }));
                    } else if (msg.image) {
                        const image = msg.image as string;
                        updateStreamingAssistant(last => ({ images: [...(last.images ?? []), image] }));
                    } else if (msg.done) {
                        port.disconnect();
                        setLoading(false);
                        abortControllerRef.current = null;
                        // Save final state so it persists when popup is closed/reopened
                        saveReconnectedState();
                        // Clear the active stream from storage
                        chrome.runtime.sendMessage({ action: 'clear_active_stream', streamId: stream.id }).catch(() => { });
                    } else if (msg.error) {
                        setError(msg.error);
                        port.disconnect();
                        setLoading(false);
                        abortControllerRef.current = null;
                        saveReconnectedState();
                        chrome.runtime.sendMessage({ action: 'clear_active_stream', streamId: stream.id }).catch(() => { });
                    }
                });

                port.onDisconnect.addListener(() => {
                    // Only fires when the background side went away (e.g. the service
                    // worker was terminated), so the stream is lost - stop waiting for it.
                    if (reconnectController.signal.aborted || abortControllerRef.current !== reconnectController) return;
                    setLoading(false);
                    abortControllerRef.current = null;
                    setError('Connection to the background was lost before the response finished. Please try again.');
                    markLastInterrupted();
                    saveReconnectedState();
                    chrome.storage.local.remove('activeStream');
                });
            } catch (e) {
                console.error('Failed to check active stream:', e);
            }
        };

        checkActiveStream();
    }, []);

    // Notify state changes (debounced). Depends only on the data, not on the callback
    // identity, so an idle popup doesn't keep rewriting popupState.
    useEffect(() => {
        if (onStateChangeRef.current) {
            const timer = setTimeout(() => {
                onStateChangeRef.current?.({
                    instruction,
                    messages,
                    selectedText,
                    selectedImage
                });
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [instruction, messages, selectedText, selectedImage]);

    // The initial* props are only read on mount. The parent's state is hydrated before
    // this component mounts (a new context remounts it), and afterwards it only changes
    // by echoing our own onStateChange reports - syncing those back would overwrite
    // newer local state with stale values.

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
    }, []);

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
            const providers = (Object.keys(config.apiKeys) as Provider[]).filter(
                p => config.apiKeys[p] && config.apiKeys[p].length > 0
            );
            // Fetch all providers in parallel, update state per-provider as each responds
            await Promise.all(providers.map(async (provider) => {
                try {
                    const fetched = await fetchModels(provider, config.apiKeys[provider][0], config.customBaseUrls[provider]);
                    if (fetched.length > 0) {
                        setAvailableModels(prev => ({ ...prev, [provider]: fetched }));
                    }
                } catch (e) {
                    console.error(`Failed to fetch models for ${provider}`, e);
                }
            }));
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

            // Auto-refresh models when dropdown opens
            const refreshModels = async () => {
                const providers = (Object.keys(config.apiKeys) as Provider[]).filter(
                    p => config.apiKeys[p] && config.apiKeys[p].length > 0
                );
                // Fetch all providers in parallel, update state per-provider as each responds
                // Existing models remain visible until replaced by fresh data
                await Promise.all(providers.map(async (provider) => {
                    try {
                        const fetched = await fetchModels(provider, config.apiKeys[provider][0], config.customBaseUrls[provider]);
                        if (fetched.length > 0) {
                            setAvailableModels(prev => ({ ...prev, [provider]: fetched }));
                        }
                    } catch (e) {
                        console.error(`Failed to fetch models for ${provider}`, e);
                    }
                }));
            };
            refreshModels();
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
            // Check if any message has active reasoning AND we're still loading
            const hasActiveReasoning = loading && messages.some((msg, idx) =>
                msg.reasoning && !msg.interrupted && reasoningStartTime[idx]
            );
            if (hasActiveReasoning) {
                forceUpdate(prev => prev + 1);
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [messages, reasoningStartTime, loading]);

    // When loading completes, finalize reasoning times for all messages with active timers
    useEffect(() => {
        if (!loading) {
            // Save final reasoning elapsed times for any messages with active timers
            Object.keys(reasoningStartTime).forEach(idxStr => {
                const idx = parseInt(idxStr);
                if (reasoningStartTime[idx] && !reasoningElapsed[idx]) {
                    const finalElapsed = Math.floor((Date.now() - reasoningStartTime[idx]) / 1000);
                    setReasoningElapsed(prev => ({ ...prev, [idx]: finalElapsed }));

                    // Also update the message itself for persistence
                    setMessages(prev => {
                        const target = prev[idx];
                        if (!target || target.role !== 'assistant' || !target.reasoning) return prev;
                        const updated = [...prev];
                        updated[idx] = { ...target, reasoningTime: finalElapsed };
                        return updated;
                    });
                }
            });

            // Clear start times after saving (keep refs clean)
            setReasoningStartTime({});
            reasoningStartTimeRef.current = {};
        }
    }, [loading]);

    // Close the image zoom with Escape
    useEffect(() => {
        if (!imageZoomOpen && !generatedImageZoom) return;
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' && e.key !== 'Esc') return;
            // Don't let Escape also close the popup itself
            e.preventDefault();
            e.stopPropagation();
            setImageZoomOpen(false);
            setGeneratedImageZoom(null);
        };
        window.addEventListener('keydown', handleEscape, true);
        return () => window.removeEventListener('keydown', handleEscape, true);
    }, [imageZoomOpen, generatedImageZoom]);

    // Immutably updates the assistant message at `index` (no-op if it is gone, e.g. after New Chat)
    const updateAssistantAt = (index: number, update: (msg: ChatMessage) => Partial<ChatMessage>) => {
        setMessages(prev => {
            const target = prev[index];
            if (!target || target.role !== 'assistant') return prev;
            const updated = [...prev];
            updated[index] = { ...target, ...update(target) };
            return updated;
        });
    };

    // Drops reasoning timer state for messages at or after `fromIndex`
    const clearReasoningTimersFrom = (fromIndex: number) => {
        const keep = (record: Record<number, number>) => {
            const next: Record<number, number> = {};
            Object.keys(record).forEach(key => {
                const idx = parseInt(key);
                if (idx < fromIndex) next[idx] = record[idx];
            });
            return next;
        };
        reasoningStartTimeRef.current = keep(reasoningStartTimeRef.current);
        setReasoningStartTime(keep);
        setReasoningElapsed(keep);
    };

    // Builds the callApi callbacks for one assistant response whose placeholder is at
    // `firstIndex`. A web search can continue the answer in a follow-up message, so the
    // current assistant index is tracked rather than assumed.
    const createStreamHandlers = (firstIndex: number, startTime: number) => {
        let assistantIndex = firstIndex;
        let accumulatedText = '';
        let accumulatedReasoning = '';
        let reasoningFinalized = false; // Track if we've stopped the reasoning timer

        clearReasoningTimersFrom(firstIndex);

        // Stop the reasoning timer of the current message (when content starts)
        const finalizeReasoningTimer = () => {
            const index = assistantIndex;
            const reasoningStart = reasoningStartTimeRef.current[index];
            if (reasoningFinalized || !accumulatedReasoning || !reasoningStart) return;
            reasoningFinalized = true;
            const finalElapsed = Math.floor((Date.now() - reasoningStart) / 1000);
            setReasoningElapsed(prev => ({ ...prev, [index]: finalElapsed }));
            // Update message with final reasoning time
            updateAssistantAt(index, () => ({ reasoningTime: finalElapsed }));
            // Clear the start time for this message
            delete reasoningStartTimeRef.current[index];
            setReasoningStartTime(prev => {
                const newState = { ...prev };
                delete newState[index];
                return newState;
            });
        };

        const onChunk = (chunk: string) => {
            // Finalize reasoning timer on first content chunk
            finalizeReasoningTimer();
            accumulatedText += chunk;
            const content = accumulatedText;
            const responseTime = Date.now() - startTime;
            updateAssistantAt(assistantIndex, () => ({ content, responseTime }));
        };

        const onWebSearch = (searchStatus: WebSearchStatus) => {
            const searchEntry: WebSearchEntry = {
                query: searchStatus.query,
                result: searchStatus.result || '',
                isSearching: searchStatus.isSearching,
                sources: searchStatus.sources
            };
            const index = assistantIndex;
            if (searchStatus.startNewMessage) {
                // Mark the search done and continue the answer in a new message
                finalizeReasoningTimer();
                setMessages(prev => {
                    const target = prev[index];
                    if (!target || target.role !== 'assistant') return prev;
                    return [
                        ...prev.slice(0, index),
                        { ...target, webSearches: upsertWebSearch(target.webSearches, { ...searchEntry, isSearching: false }) },
                        { role: 'assistant', content: '' }
                    ];
                });
                assistantIndex = index + 1;
                accumulatedText = ''; // Reset for new message
                accumulatedReasoning = ''; // Reset reasoning for new message
                reasoningFinalized = false;
            } else {
                // Update web search info on current message (search in progress or done)
                updateAssistantAt(index, msg => ({ webSearches: upsertWebSearch(msg.webSearches, searchEntry) }));
            }
        };

        // Handle reasoning content (from models like DeepSeek)
        const onReasoning = (reasoningChunk: string) => {
            accumulatedReasoning += reasoningChunk;
            const index = assistantIndex;
            // Start timer when first reasoning chunk arrives
            if (accumulatedReasoning === reasoningChunk) {
                const reasoningStart = Date.now();
                reasoningStartTimeRef.current[index] = reasoningStart;
                setReasoningStartTime(prev => ({ ...prev, [index]: reasoningStart }));
            }
            const reasoning = accumulatedReasoning;
            updateAssistantAt(index, () => ({ reasoning }));
        };

        // Handle images from models that generate images
        const onImage = (imageUrl: string) => {
            updateAssistantAt(assistantIndex, msg => ({ images: [...(msg.images ?? []), imageUrl] }));
        };

        // Discard the partial response before retrying with another model
        const reset = () => {
            clearReasoningTimersFrom(firstIndex);
            assistantIndex = firstIndex;
            accumulatedText = '';
            accumulatedReasoning = '';
            reasoningFinalized = false;
            setMessages(prev => prev.length > firstIndex
                ? [...prev.slice(0, firstIndex), { role: 'assistant', content: '' }]
                : prev);
        };

        // Aborted - still record response time (and reasoning time) for the interrupted message
        const markInterrupted = () => {
            const index = assistantIndex;
            const responseTime = Date.now() - startTime;
            const reasoningStart = reasoningStartTimeRef.current[index];
            const reasoningTime = reasoningStart ? Math.floor((Date.now() - reasoningStart) / 1000) : undefined;
            if (reasoningTime !== undefined) {
                setReasoningElapsed(prev => ({ ...prev, [index]: reasoningTime }));
            }
            updateAssistantAt(index, () => (reasoningTime !== undefined
                ? { interrupted: true, responseTime, reasoningTime }
                : { interrupted: true, responseTime }));
        };

        return { onChunk, onWebSearch, onReasoning, onImage, reset, markInterrupted };
    };

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
        if (provider !== config.selectedProvider || model !== config.selectedModel[config.selectedProvider]) {
            destroyChromeNanoSession();
        }
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
            await setStorage(newConfig).catch(e => console.error('[AI Assistant] Failed to save config:', e));
        }
        setIsModelMenuOpen(false);
    };

    const handleRetryWithModel = async (messageIndex: number, provider: string, model: string) => {
        // Close the retry menu
        setRetryModelMenuOpen(null);

        // Only one request at a time - a second one would race the first over shared state
        if (loading || loadingRef.current) return;

        // Remove the assistant message being retried (keep all messages before it)
        const newMessages = messages.slice(0, messageIndex);

        // Temporarily switch to the backup model
        const previousProvider = config.selectedProvider;
        const previousModelForProvider = config.selectedModel[provider];

        const tempConfig = {
            ...config,
            selectedProvider: provider,
            selectedModel: {
                ...config.selectedModel,
                [provider]: model
            }
        };
        setConfig(tempConfig);

        loadingRef.current = true;
        setLoading(true);
        setError('');

        // Track response time
        const startTime = Date.now();

        // Abort previous if any
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const isCurrent = () => abortControllerRef.current === controller;

        // Add placeholder assistant message
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
        setMessages([...newMessages, assistantMsg]);

        // Scroll to bottom when retrying
        scrollToBottom();

        const handlers = createStreamHandlers(newMessages.length, startTime);

        try {
            const res = await callApi(newMessages, tempConfig, handlers.onChunk, controller.signal,
                handlers.onWebSearch, handlers.onReasoning, handlers.onImage);

            if (res.error && isCurrent()) {
                setError(res.error);
            }
        } catch (err: any) {
            if (isCurrent()) {
                if (err.name === 'AbortError') {
                    handlers.markInterrupted();
                } else {
                    setError(err.message);
                }
            }
        } finally {
            if (isCurrent()) {
                abortControllerRef.current = null;
                loadingRef.current = false;
                setLoading(false);
            }
            // Don't leave the finished stream around to be "restored" later
            if (mountedRef.current) {
                chrome.runtime.sendMessage({ action: 'clear_active_stream', onlyIfDone: true }).catch(() => { });
            }

            // Restore original model selection, unless the user picked another model meanwhile
            setConfig(prev => {
                if (prev.selectedProvider !== provider || prev.selectedModel[provider] !== model) return prev;
                return {
                    ...prev,
                    selectedProvider: previousProvider,
                    selectedModel: {
                        ...prev.selectedModel,
                        [provider]: previousModelForProvider
                    }
                };
            });
        }
    };

    const handleSubmit = async (overrideInstruction?: string, overrideConfig?: AppConfig) => {
        // Only one request at a time - a second one would race the first over shared state
        if (loading || loadingRef.current) return;

        const textToSubmit = overrideInstruction !== undefined ? overrideInstruction : instruction;
        let activeConfig = overrideConfig || config;

        // Context is only attached to the first message of a conversation
        const hasContext = messages.length === 0 && !!(selectedText || selectedImage);
        if (!textToSubmit.trim() && !hasContext) return;

        loadingRef.current = true;
        setLoading(true);
        setError('');

        // Track response time
        const startTime = Date.now();

        // Abort previous if any
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        // One controller for the whole request, fallbacks included, so Stop aborts whatever is running
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const isCurrent = () => abortControllerRef.current === controller;

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
        setInstruction('');

        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }

        // Add placeholder assistant message
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
        // Track which model is used when a prompt overrides the default model
        if (overrideConfig) {
            assistantMsg.modelUsed = activeConfig.selectedModel[activeConfig.selectedProvider];
        }
        setMessages([...newMessages, assistantMsg]);

        // Scroll to bottom when user sends a message
        scrollToBottom();

        const handlers = createStreamHandlers(newMessages.length, startTime);
        const runRequest = (requestConfig: AppConfig) => callApi(newMessages, requestConfig, handlers.onChunk, controller.signal,
            handlers.onWebSearch, handlers.onReasoning, handlers.onImage);

        try {
            let res = await runRequest(activeConfig);

            // Fallback: If the request used a prompt-specific override model and got an error,
            // retry with the primary model before trying other fallbacks
            if (res.error && overrideConfig && isCurrent()) {
                const isSameAsPrimary = config.selectedProvider === activeConfig.selectedProvider &&
                    config.selectedModel[config.selectedProvider] === activeConfig.selectedModel[activeConfig.selectedProvider];

                if (!isSameAsPrimary) {
                    console.log(`Prompt override model failed (${res.error}), retrying with primary model: ${config.selectedProvider}/${config.selectedModel[config.selectedProvider]}`);

                    // Reset the assistant message (no longer using override model)
                    handlers.reset();

                    // Retry with primary config. If it also fails, res feeds the fallbacks below
                    res = await runRequest(config);
                    // Update activeConfig reference for vision fallback check below
                    activeConfig = config;
                }
            }

            // Check for errors when images are present - fall back to vision model
            // This handles cases where the model doesn't support images (various error messages)
            const hasImageInConversation = newMessages.some(m => m.image);
            if (res.error && hasImageInConversation && activeConfig.visionModel && isCurrent()) {
                const visionModel = activeConfig.visionModel;
                // Don't fallback to the same provider+model that just failed
                const isSameModel = visionModel.provider === activeConfig.selectedProvider &&
                    visionModel.model === activeConfig.selectedModel[activeConfig.selectedProvider];

                if (!isSameModel) {
                    console.log(`Image request failed (${res.error}), falling back to vision model: ${visionModel.provider}/${visionModel.model}`);

                    // Build fallback config using the vision model
                    const visionConfig: AppConfig = {
                        ...activeConfig,
                        selectedProvider: visionModel.provider,
                        selectedModel: {
                            ...activeConfig.selectedModel,
                            [visionModel.provider]: visionModel.model
                        }
                    };

                    // Reset the assistant message
                    handlers.reset();

                    // Retry with vision model config
                    const fallbackRes = await runRequest(visionConfig);

                    if (fallbackRes.error && isCurrent()) {
                        setError(fallbackRes.error);
                    }
                    // Don't show fallback notice - just work silently
                    return;
                }
            }

            if (res.error && isCurrent()) {
                setError(res.error);
            }
        } catch (err: any) {
            if (isCurrent()) {
                if (err.name === 'AbortError') {
                    handlers.markInterrupted();
                } else {
                    setError(err.message);
                }
            }
        } finally {
            if (isCurrent()) {
                abortControllerRef.current = null;
                loadingRef.current = false;
                setLoading(false);
            }
            // Don't leave the finished stream around to be "restored" later
            // (e.g. after New Chat). If we unmounted mid-stream, keep it for the restore path.
            if (mountedRef.current) {
                chrome.runtime.sendMessage({ action: 'clear_active_stream', onlyIfDone: true }).catch(() => { });
            }
        }
    };

    const openOptions = () => {
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open(chrome.runtime.getURL('src/options/index.html'), '_blank');
        }
    };

    const keyedProviders = (Object.keys(config.apiKeys) as Provider[]).filter(p => config.apiKeys[p].length > 0);
    const allProviders = chromeNanoAvailable
        ? [CHROME_PROVIDER, ...keyedProviders.filter(provider => provider !== CHROME_PROVIDER)]
        : keyedProviders;

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
                                    <div className="relative flex items-center">
                                        <input
                                            ref={searchInputRef}
                                            type="text"
                                            value={modelSearch}
                                            onChange={(e) => setModelSearch(e.target.value)}
                                            placeholder="Search models..."
                                            className="w-full px-3 py-2 pr-8 text-xs leading-5 bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-slate-900 dark:text-gpt-text placeholder:text-slate-400 transition-colors"
                                            onClick={(e) => e.stopPropagation()}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && modelSearch.trim() && filteredModelGroups.length === 0 && allProviders.length > 0) {
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
                                                className="absolute right-2 inset-y-0 my-auto flex items-center justify-center leading-none w-5 h-5 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-gpt-hover transition-colors"
                                                title="Clear search"
                                            >
                                                <X size={13} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {config.defaultModel && !(
                                    config.selectedProvider === config.defaultModel.provider &&
                                    (config.selectedModel[config.defaultModel.provider] || '') === config.defaultModel.model
                                ) && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleModelChange(config.defaultModel!.provider as Provider, config.defaultModel!.model);
                                        }}
                                        className="mx-2 mt-1.5 flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold rounded-md border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
                                        title={`Reset selection to default (${config.defaultModel.model})`}
                                    >
                                        <RotateCcw size={11} className="shrink-0" />
                                        <span>Reset to Default</span>
                                        <span className="ml-auto font-normal text-amber-600/70 dark:text-amber-400/70 truncate max-w-[100px]">
                                            {config.defaultModel.model}
                                        </span>
                                    </button>
                                )}

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
                            // Stop any in-flight response so it can't come back into the new chat
                            abortControllerRef.current?.abort();
                            destroyChromeNanoSession();
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
                            // Focus the textarea for immediate typing
                            setTimeout(() => {
                                textareaRef.current?.focus();
                            }, 50);
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
                        <div className="flex flex-col max-w-[85%]">
                        <div className={`relative group p-3 rounded-2xl text-sm shadow-sm dark:shadow-none ${msg.role === 'user'
                            ? 'bg-white dark:bg-gpt-input text-slate-800 dark:text-gpt-text border border-slate-200 dark:border-gpt-hover rounded-tr-none'
                            : 'bg-white dark:bg-transparent text-slate-800 dark:text-gpt-text border border-slate-200 dark:border-none rounded-tl-none px-0 py-0'
                            }`}>
                            {msg.role === 'assistant' ? (
                                <div className={clsx("prose prose-sm max-w-none prose-slate dark:prose-invert prose-pre:bg-slate-100 dark:prose-pre:bg-gpt-sidebar prose-pre:p-2 prose-pre:rounded-lg mb-1",
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
                                                        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                                                            {escapeCurrencyDollars(msg.reasoning.replace(/(\*\*[^\*]+\*\*)\n(?!\n)/g, '$1\n\n'))}
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
                                    {!msg.content && msg.webSearches && msg.webSearches.length > 0 ? (
                                        // Message has web searches but no content - show static text
                                        <div className="text-sm text-slate-700 dark:text-gpt-text py-1">
                                            AI is searching the web{msg.webSearches.length > 1 ? ` (${msg.webSearches.length} queries)` : `: "${msg.webSearches[0].query}"`}
                                        </div>
                                    ) : !msg.content && loading && idx === messages.length - 1 && !msg.reasoning ? (
                                        // Empty message at the end while loading (and no reasoning) - show Thinking
                                        <div className="flex items-center gap-2 text-slate-500 dark:text-gpt-secondary py-1">
                                            <Loader2 size={14} className="animate-spin" />
                                            <span className="text-xs font-medium">Thinking...</span>
                                        </div>
                                    ) : (
                                        <ReactMarkdown
                                            remarkPlugins={markdownRemarkPlugins}
                                            rehypePlugins={markdownRehypePlugins}
                                            components={{
                                                pre: CodeBlock,
                                                a: ({ node, ...props }: any) => {
                                                    const href = props.href || '';
                                                    if (href.startsWith('#source-')) {
                                                        const index = parseInt(href.replace('#source-', ''));
                                                        const allSources = msg.webSearches?.flatMap(s => s.sources || []) || [];
                                                        const source = allSources[index - 1];

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
                                            } as any}
                                        >
                                            {/* Preprocess content to convert [^N] to [N](#source-N) */}
                                            {escapeCurrencyDollars(msg.content.replace(/\[\^(\d+)\]/g, '[$1](#source-$1)'))}
                                        </ReactMarkdown>
                                    )}
                                    {/* Web Search Sections - Grouped Card */}
                                    {msg.webSearches && msg.webSearches.length > 0 && (
                                        <div className="mt-3 not-prose">
                                            <div className="border border-slate-200 dark:border-gpt-hover rounded-lg overflow-hidden bg-slate-50 dark:bg-gpt-sidebar transition-all duration-200">
                                                {/* Main Header - Toggles list visibility */}
                                                <button
                                                    onClick={() => setExpandedSearches(prev => ({ ...prev, [`${idx}-main`]: !prev[`${idx}-main`] }))}
                                                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-gpt-hover transition-colors group"
                                                >
                                                    <div className="flex items-center gap-2.5 overflow-hidden flex-1">
                                                        <div className={clsx(
                                                            "flex items-center justify-center w-5 h-5 rounded-full shrink-0 transition-colors",
                                                            msg.webSearches.some(s => s.isSearching)
                                                                ? "bg-blue-100 dark:bg-blue-900/30 text-blue-500"
                                                                : "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-500"
                                                        )}>
                                                            {msg.webSearches.some(s => s.isSearching) ? (
                                                                <Loader2 size={12} className="animate-spin" />
                                                            ) : (
                                                                <Globe size={12} />
                                                            )}
                                                        </div>
                                                        <div className="flex flex-col items-start min-w-0 flex-1">
                                                            <span className="text-xs font-semibold text-slate-700 dark:text-gpt-text truncate w-full">
                                                                {msg.webSearches.some(s => s.isSearching)
                                                                    ? "Searching the web..."
                                                                    : "Web Search Completed"}
                                                            </span>
                                                            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate w-full">
                                                                {msg.webSearches.length} {msg.webSearches.length === 1 ? 'query' : 'queries'}{(() => { const total = msg.webSearches.reduce((acc, s) => acc + (s.sources?.length || 0), 0); return total > 0 ? ` · ${total} sources` : ''; })()}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <ChevronRight
                                                        size={14}
                                                        className={clsx(
                                                            "text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-transform duration-200",
                                                            expandedSearches[`${idx}-main`] && "rotate-90"
                                                        )}
                                                    />
                                                </button>

                                                {/* Expanded List of Queries */}
                                                {expandedSearches[`${idx}-main`] && (
                                                    <div className="border-t border-slate-200 dark:border-gpt-hover bg-white dark:bg-gpt-main divide-y divide-slate-100 dark:divide-gpt-hover">
                                                        {msg.webSearches.map((search, searchIdx) => {
                                                            const searchKey = `${idx}-${searchIdx}`;
                                                            return (
                                                                <div key={searchIdx} className="flex flex-col">
                                                                    <button
                                                                        onClick={() => setExpandedSearches(prev => ({ ...prev, [searchKey]: !prev[searchKey] }))}
                                                                        className="w-full flex items-start gap-3 px-3 py-2 hover:bg-slate-50 dark:hover:bg-gpt-sidebar transition-colors text-left group/item"
                                                                    >
                                                                        <div className="mt-0.5 shrink-0">
                                                                            {search.isSearching ? (
                                                                                <Loader2 size={12} className="animate-spin text-blue-400" />
                                                                            ) : (
                                                                                <Check size={12} className="text-green-500" />
                                                                            )}
                                                                        </div>
                                                                        <span className={clsx(
                                                                            "text-xs flex-1 leading-relaxed transition-colors",
                                                                            expandedSearches[searchKey]
                                                                                ? "text-slate-900 dark:text-slate-200 font-medium"
                                                                                : "text-slate-600 dark:text-gpt-secondary group-hover/item:text-slate-900 dark:group-hover/item:text-slate-300"
                                                                        )}>
                                                                            {search.query}
                                                                        </span>
                                                                        {!search.isSearching && (
                                                                            <ChevronRight
                                                                                size={12}
                                                                                className={clsx(
                                                                                    "text-slate-300 group-hover/item:text-slate-400 mt-0.5 transition-transform duration-200",
                                                                                    expandedSearches[searchKey] && "rotate-90"
                                                                                )}
                                                                            />
                                                                        )}
                                                                    </button>

                                                                    {/* Individual Query Result */}
                                                                    {!search.isSearching && expandedSearches[searchKey] && (
                                                                        <div className="mx-3 mb-2 px-3 py-2 bg-slate-50 dark:bg-gpt-sidebar rounded-md border border-slate-100 dark:border-gpt-hover max-h-60 overflow-y-auto custom-scrollbar shadow-sm">
                                                                            <div className="text-xs text-slate-700 dark:text-gpt-text leading-relaxed">
                                                                                <ReactMarkdown
                                                                                    remarkPlugins={markdownRemarkPlugins}
                                                                                    rehypePlugins={markdownRehypePlugins}
                                                                                    components={{
                                                                                        pre: CodeBlock,
                                                                                        a: ({ node, ...props }: any) => {
                                                                                            const href = props.href || '';
                                                                                            if (href.startsWith('#source-')) {
                                                                                                const index = parseInt(href.replace('#source-', ''));
                                                                                                const source = search.sources?.[index - 1]; // Local source index
                                                                                                if (source) {
                                                                                                    return (
                                                                                                        <span className="inline-flex items-center justify-center align-super text-[9px] mx-0.5 align-middle -mt-2">
                                                                                                            <a
                                                                                                                href={source.url}
                                                                                                                target="_blank"
                                                                                                                rel="noopener noreferrer"
                                                                                                                className="flex items-center justify-center w-3.5 h-3.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 hover:bg-blue-600 hover:text-white dark:hover:bg-blue-500 transition-all no-underline font-semibold shadow-sm ring-1 ring-blue-200 dark:ring-blue-800"
                                                                                                                title={`${source.title}\n${source.url}`}
                                                                                                                onClick={(e) => e.stopPropagation()}
                                                                                                            >
                                                                                                                {index}
                                                                                                            </a>
                                                                                                        </span>
                                                                                                    );
                                                                                                }
                                                                                            }
                                                                                            return <a {...props} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" />;
                                                                                        }
                                                                                    } as any}
                                                                                >
                                                                                    {escapeCurrencyDollars(search.result.replace(/\[\^(\d+)\]/g, '[$1](#source-$1)'))}
                                                                                </ReactMarkdown>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}

                                                        {/* Footer Actions */}
                                                        {(() => {
                                                            const allSources = msg.webSearches?.flatMap(s => s.sources || []) || [];
                                                            return allSources.length > 0 && (
                                                                <div className="px-3 py-2 bg-slate-50/50 dark:bg-gpt-sidebar/50">
                                                                    <button
                                                                        onClick={() => setSourcesModal({ sources: allSources, query: msg.webSearches!.map(s => s.query).join(', ') })}
                                                                        className="flex items-center gap-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                                                                    >
                                                                        <Link2 size={12} />
                                                                        View all {allSources.length} sources
                                                                    </button>
                                                                </div>
                                                            );
                                                        })()}
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
                                    {/* Generated Images Section */}
                                    {msg.images && msg.images.length > 0 && (
                                        <div className="mt-3 not-prose">
                                            <div className="grid grid-cols-2 gap-2">
                                                {msg.images.map((imageUrl, imgIdx) => (
                                                    <button
                                                        key={imgIdx}
                                                        onClick={() => setGeneratedImageZoom(imageUrl)}
                                                        className="relative group rounded-lg overflow-hidden border-2 border-slate-200 dark:border-gpt-hover hover:border-blue-500 dark:hover:border-blue-400 transition-all cursor-zoom-in"
                                                        title="Click to view full size"
                                                    >
                                                        <img
                                                            src={imageUrl}
                                                            alt={`Generated image ${imgIdx + 1}`}
                                                            className="w-full h-auto object-contain bg-slate-100 dark:bg-slate-800"
                                                        />
                                                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                                            <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 text-white text-xs font-medium px-2 py-1 rounded-lg">
                                                                🔍 View Full Size
                                                            </div>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {/* Sources Button - aggregated from all searches */}

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
                                    <div className="whitespace-pre-wrap break-words text-sm">
                                        {msg.content}
                                    </div>
                                </div>
                            )}
                            {/* Copy button - same for both user and assistant */}
                            {!(loading && idx === messages.length - 1) && msg.content && (
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(msg.content);
                                        setCopiedIndex(idx);
                                        setTimeout(() => setCopiedIndex(null), 2000);
                                    }}
                                    className={clsx(
                                        "absolute right-1 p-1 rounded-md transition-all duration-200",
                                        msg.role === 'user' ? "bottom-1" : "-bottom-1",
                                        "opacity-0 group-hover:opacity-100 focus:opacity-100",
                                        "hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                                    )}
                                    title="Copy"
                                >
                                    {copiedIndex === idx ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                </button>
                            )}
                        </div>
                        {/* Status line - outside the message box */}
                        {msg.role === 'assistant' && msg.content && !(loading && idx === messages.length - 1) && (
                            <div className="flex items-center gap-2">
                                {/* Response time */}
                                {msg.responseTime !== undefined && (
                                    <div className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500">
                                        <Clock size={10} />
                                        <span>{(msg.responseTime / 1000).toFixed(1)}s</span>
                                    </div>
                                )}
                                {/* Model used indicator (when prompt override model was used) */}
                                {msg.modelUsed && (
                                    <div className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500">
                                        <Bot size={10} />
                                        <span>{msg.modelUsed}</span>
                                    </div>
                                )}
                                {/* Try with another model button */}
                                <div className="relative" ref={retryModelMenuOpen === idx ? retryModelMenuRef : null}>
                                    <button
                                        onClick={() => setRetryModelMenuOpen(retryModelMenuOpen === idx ? null : idx)}
                                        disabled={loading}
                                        className="p-1 disabled:opacity-40 disabled:pointer-events-none text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
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
                        className="w-full bg-transparent border-none focus:ring-0 p-0 pr-10 text-sm text-slate-900 dark:text-gpt-text placeholder:text-slate-400 dark:placeholder:text-zinc-500 resize-none max-h-[200px] min-h-[20px] overflow-y-auto no-scrollbar outline-none"
                        rows={1}
                        onKeyDown={(e) => {
                            // Ignore Enter while an IME (e.g. Vietnamese/CJK input) is composing
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
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
                                disabled={!instruction.trim() && !(messages.length === 0 && (selectedText || selectedImage))}
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

            {/* Generated Image Zoom Modal */}
            {generatedImageZoom && (
                <div
                    className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={() => setGeneratedImageZoom(null)}
                >
                    <div
                        className="relative max-w-[90vw] max-h-[90vh] bg-white dark:bg-gpt-sidebar rounded-xl shadow-2xl overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/50 to-transparent z-10">
                            <span className="text-white text-sm font-medium drop-shadow-lg">Generated Image</span>
                            <div className="flex items-center gap-2">
                                <a
                                    href={generatedImageZoom}
                                    download={`generated-image-${Date.now()}.png`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="p-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors text-white"
                                    title="Download image"
                                >
                                    <Download size={18} />
                                </a>
                                <button
                                    onClick={() => setGeneratedImageZoom(null)}
                                    className="p-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors text-white"
                                    title="Close"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        {/* Image */}
                        <img
                            src={generatedImageZoom}
                            alt="Generated image full size"
                            className="max-w-full max-h-[90vh] object-contain"
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
