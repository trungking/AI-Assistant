import { DEFAULT_CONFIG } from '../lib/types';
import { getStorage, setStorage } from '../lib/storage';
import { refreshContentScripts, sendToContentScript } from './contentMessaging';

/**
 * Convert an image URL to a base64 data URL.
 * For external URLs, fetches the image and converts to base64.
 * For data URLs, returns as-is.
 */
const imageUrlToDataUrl = async (imageUrl: string): Promise<string> => {
    // Already a data URL
    if (imageUrl.startsWith('data:')) {
        return imageUrl;
    }

    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            console.error('Failed to fetch image:', response.statusText);
            return imageUrl; // Return original URL as fallback
        }

        const blob = await response.blob();

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (typeof reader.result === 'string') {
                    resolve(reader.result);
                } else {
                    reject(new Error('Failed to convert blob to data URL'));
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Failed to convert image to data URL:', error);
        return imageUrl; // Return original URL as fallback
    }
};

chrome.runtime.onInstalled.addListener(async () => {
    // Menus persist across updates; recreating them without clearing first
    // fails with duplicate-id errors. Do this before anything that can throw.
    await chrome.contextMenus.removeAll();

    chrome.contextMenus.create({
        id: "ai-ask-context",
        title: "Ask AI Assistant",
        contexts: ["selection"]
    });

    chrome.contextMenus.create({
        id: "ai-ask-image",
        title: "Ask AI about this image",
        contexts: ["image"]
    });

    // Initialize storage with defaults if not present
    try {
        const { appConfig } = await chrome.storage.sync.get('appConfig');
        if (!appConfig) {
            await setStorage(DEFAULT_CONFIG);
        }
    } catch (error) {
        console.error('[AI Assistant] Failed to initialize storage:', error);
    }

    // Chrome leaves already-open tabs without a live content script on update/reload.
    void refreshContentScripts().catch(error => {
        console.error('[AI Assistant] Failed to refresh open tabs:', error);
    });
});

const openUi = async () => {
    // Method 1: Try to open the Browser Action Popup (Preferred)
    try {
        // @ts-ignore - openPopup is available in newer Chrome versions
        await chrome.action.openPopup();
        return;
    } catch (e) {
        console.log("chrome.action.openPopup failed, falling back to window creation.", e);
    }

    // Method 2: Fallback to creating a small popup window
    // Calculate center position
    const width = 450; // Matched popup width
    const height = 600; // Matched popup height
    let left = 100;
    let top = 100;

    try {
        const displays = await chrome.system.display.getInfo();
        const primaryDisplay = displays.find(d => d.isPrimary) || displays[0];
        if (primaryDisplay) {
            left = Math.round(primaryDisplay.workArea.left + (primaryDisplay.workArea.width - width) / 2);
            top = Math.round(primaryDisplay.workArea.top + (primaryDisplay.workArea.height - height) / 2);
        }
    } catch (err) {
        console.error("Failed to get display info:", err);
    }

    await chrome.windows.create({
        url: "src/popup/index.html",
        type: "popup",
        width: width,
        height: height,
        left: left,
        top: top
    });
};

const handleContextMenu = async (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
    const appConfig = await getStorage();
    const mode = appConfig.popupMode || 'extension';

    if (info.menuItemId === "ai-ask-context" && tab?.id) {
        let selectedText = info.selectionText || '';

        // Try to get better text with proper emoji extraction via script
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // Extract text from a DOM node, preserving emoji alt text from img elements
                    const extractTextFromNode = (node: Node): string => {
                        if (node.nodeType === Node.TEXT_NODE) {
                            return node.textContent || '';
                        }

                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const element = node as Element;

                            if (element.tagName === 'IMG') {
                                return (element as HTMLImageElement).alt || '';
                            }

                            if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') {
                                return '';
                            }

                            let text = '';
                            for (const child of Array.from(node.childNodes)) {
                                text += extractTextFromNode(child);
                            }

                            const blockTags = ['DIV', 'P', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
                            if (blockTags.includes(element.tagName)) {
                                text += '\n';
                            }

                            return text;
                        }

                        return '';
                    };

                    const selection = window.getSelection();
                    if (!selection || selection.rangeCount === 0) {
                        return '';
                    }

                    const simpleText = selection.toString();

                    try {
                        const range = selection.getRangeAt(0);
                        const fragment = range.cloneContents();
                        const hasImages = fragment.querySelectorAll('img').length > 0;

                        if (hasImages) {
                            let extractedText = '';
                            for (const child of Array.from(fragment.childNodes)) {
                                extractedText += extractTextFromNode(child);
                            }
                            return extractedText.replace(/\n{3,}/g, '\n\n').trim();
                        }
                    } catch (e) {
                        console.warn('Failed to extract rich text:', e);
                    }

                    return simpleText;
                }
            });
            if (results[0]?.result) {
                selectedText = results[0].result;
            }
        } catch (e) {
            console.error("Failed to retrieve selection via script, falling back to info.selectionText", e);
        }

        if (mode === 'content_script') {
            await sendToContentScript(tab.id, {
                action: 'open_content_popup',
                selection: selectedText,
                image: null
            });
        } else {
            await chrome.storage.local.set({ contextSelection: selectedText, contextImage: null });
            await openUi();
        }
    } else if (info.menuItemId === "ai-ask-image" && info.srcUrl && tab?.id) {
        // Convert external URL to data URL so AI models can always access the image
        const imageDataUrl = await imageUrlToDataUrl(info.srcUrl);

        if (mode === 'content_script') {
            await sendToContentScript(tab.id, {
                action: 'open_content_popup',
                selection: '',
                image: imageDataUrl
            });
        } else {
            await chrome.storage.local.set({ contextSelection: null, contextImage: imageDataUrl });
            await openUi();
        }
    }
};

chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenu(info, tab).catch(error => {
        console.error('[AI Assistant] Failed to open context menu popup:', error);
    });
});

import { executeApiCall, executeFetchModels, executeApiStream } from '../lib/api';

// --- Background Stream Continuation ---
type StreamState = {
    id: string;
    port: chrome.runtime.Port | null;
    controller: AbortController;
    accumulatedText: string;
    accumulatedReasoning: string;
    messages: any[]; // The conversation messages that initiated the stream
    webSearches: any[];
    images: string[];
    done: boolean;
    error: string | null;
    startTime: number;
    lastActivity: number;
    idleTimedOut: boolean;
};

// Keeps track of the latest background stream so it can survive popup disconnects
let activeStreamState: StreamState | null = null;

// Streams that have not finished yet, keyed by id (several UIs can stream at once)
const runningStreams = new Map<string, StreamState>();

// Stop requests that arrived before their stream started
const abortedStreamIds = new Set<string>();

const findStream = (id: string | undefined): StreamState | null => {
    if (!id) return activeStreamState;
    return runningStreams.get(id) ?? (activeStreamState?.id === id ? activeStreamState : null);
};

// Abort streams that receive nothing for this long, so a stalled connection
// can't keep the worker alive forever once nobody is around to press Stop.
const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// Chrome terminates an idle service worker after ~30s, and an in-flight fetch
// does not count as activity. While a model is thinking no chunks arrive, so the
// worker could be killed mid-request (server sees "499 context canceled").
// Calling an extension API periodically resets the idle timer.
const KEEPALIVE_INTERVAL_MS = 20_000;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

const updateKeepAlive = () => {
    if (runningStreams.size > 0 && !keepAliveTimer) {
        keepAliveTimer = setInterval(() => {
            void chrome.runtime.getPlatformInfo().catch(() => { });
            const now = Date.now();
            for (const stream of runningStreams.values()) {
                if (now - stream.lastActivity > STREAM_IDLE_TIMEOUT_MS) {
                    stream.idleTimedOut = true;
                    stream.controller.abort();
                }
            }
        }, KEEPALIVE_INTERVAL_MS);
    } else if (runningStreams.size === 0 && keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
};

// Save active stream state to storage so popup can recover
const saveActiveStreamToStorage = async () => {
    if (!activeStreamState) {
        await chrome.storage.local.remove('activeStream');
        return;
    }
    await chrome.storage.local.set({
        activeStream: {
            id: activeStreamState.id,
            accumulatedText: activeStreamState.accumulatedText,
            accumulatedReasoning: activeStreamState.accumulatedReasoning,
            messages: activeStreamState.messages,
            webSearches: activeStreamState.webSearches,
            images: activeStreamState.images,
            done: activeStreamState.done,
            error: activeStreamState.error,
            startTime: activeStreamState.startTime,
        }
    });
};

const persistActiveStream = () => {
    void saveActiveStreamToStorage().catch(error => {
        console.error('[AI Assistant] Failed to save active stream:', error);
    });
};

// Messages can carry multi-MB image data URLs; saving them on every chunk
// floods storage and its onChanged listeners until the extension crashes.
const ACTIVE_STREAM_SAVE_INTERVAL_MS = 1000;
let activeStreamSaveTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleActiveStreamSave = () => {
    if (activeStreamSaveTimer) return;
    activeStreamSaveTimer = setTimeout(() => {
        activeStreamSaveTimer = null;
        persistActiveStream();
    }, ACTIVE_STREAM_SAVE_INTERVAL_MS);
};

const clearActiveStream = async () => {
    activeStreamState = null;
    await chrome.storage.local.remove('activeStream');
};

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'stream_api') {
        // Each stream keeps its own state so a newer stream can't swallow the
        // final done/error message of an older one that is still running.
        const state: StreamState = {
            // Replaced by the caller-generated id when the request arrives
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            port: port,
            controller: new AbortController(),
            accumulatedText: '',
            accumulatedReasoning: '',
            messages: [],
            webSearches: [],
            images: [],
            done: false,
            error: null,
            startTime: Date.now(),
            lastActivity: Date.now(),
            idleTimedOut: false,
        };
        activeStreamState = state;

        const isActive = () => activeStreamState === state;

        const safeSend = (msg: any) => {
            if (state.port) {
                try {
                    state.port.postMessage(msg);
                } catch (e) {
                    // Port disconnected, stop trying to send
                    state.port = null;
                }
            }
        };

        const onProgress = () => {
            state.lastActivity = Date.now();
            // Periodically save to storage when port is disconnected
            if (!state.port && isActive()) {
                scheduleActiveStreamSave();
            }
        };

        const finish = async () => {
            state.done = true;
            runningStreams.delete(state.id);
            updateKeepAlive();
            if (isActive()) {
                await saveActiveStreamToStorage();
            }
        };

        port.onDisconnect.addListener(() => {
            // DON'T abort the stream - let it continue in background
            if (state.port !== port) return; // a reconnected popup owns it now
            state.port = null;
            if (isActive()) {
                // Save current state so popup can reconnect
                persistActiveStream();
            }
        });

        port.onMessage.addListener(async (msg) => {
            if (msg.messages && msg.config) {
                if (typeof msg.streamId === 'string') {
                    state.id = msg.streamId;
                }
                state.messages = msg.messages;

                if (abortedStreamIds.delete(state.id)) {
                    // Stopped before it started
                    await finish();
                    return;
                }

                runningStreams.set(state.id, state);
                updateKeepAlive();

                try {
                    const res = await executeApiStream(
                        msg.messages,
                        msg.config,
                        (chunk) => {
                            state.accumulatedText += chunk;
                            safeSend({ chunk });
                            onProgress();
                        },
                        state.controller.signal,
                        (webSearch) => {
                            state.webSearches.push(webSearch);
                            safeSend({ webSearch });
                            onProgress();
                        },
                        (reasoning) => {
                            state.accumulatedReasoning += reasoning;
                            safeSend({ reasoning });
                            onProgress();
                        },
                        (image) => {
                            state.images.push(image);
                            safeSend({ image });
                            onProgress();
                        }
                    );

                    if (res.error) {
                        state.error = res.error;
                        safeSend({ error: res.error });
                    } else {
                        safeSend({ done: true });
                    }
                    await finish();
                } catch (e: any) {
                    if (state.idleTimedOut) {
                        state.error = 'No data received from the server for a long time, so the request was stopped. Please try again.';
                        safeSend({ error: state.error });
                    } else if (e.name === 'AbortError') {
                        // Aborted by user (stop button). The caller normally has
                        // already settled; this only matters if its port is still open.
                        safeSend({ error: 'Request was cancelled.' });
                    } else {
                        state.error = e.message;
                        safeSend({ error: e.message });
                    }
                    await finish();
                }
            }
        });
    } else if (port.name === 'stream_reconnect' || port.name.startsWith('stream_reconnect:')) {
        // Handle reconnection from popup that was closed and reopened.
        // The popup passes the stored stream id so it never attaches to another UI's stream.
        const requestedId = port.name.slice('stream_reconnect:'.length) || undefined;
        const target = findStream(requestedId);
        if (target) {
            target.port = port;

            // Send all buffered data
            try {
                if (target.accumulatedText) {
                    port.postMessage({ chunk: target.accumulatedText });
                }
                if (target.accumulatedReasoning) {
                    port.postMessage({ reasoning: target.accumulatedReasoning });
                }
                for (const ws of target.webSearches) {
                    port.postMessage({ webSearch: ws });
                }
                for (const img of target.images) {
                    port.postMessage({ image: img });
                }

                if (target.done) {
                    if (target.error) {
                        port.postMessage({ error: target.error });
                    } else {
                        port.postMessage({ done: true });
                    }
                    // Stream is done, clear it
                    if (target === activeStreamState) {
                        void clearActiveStream();
                    }
                } else {
                    // Stream is still running, send a reconnected signal
                    port.postMessage({ reconnected: true, streaming: true });
                }
            } catch (e) {
                // Port failed
                if (target.port === port) {
                    target.port = null;
                }
            }

            port.onDisconnect.addListener(() => {
                if (target.port !== port) return;
                target.port = null;
                if (target === activeStreamState) {
                    persistActiveStream();
                }
            });
        } else {
            // No such stream (e.g. the service worker restarted and lost it)
            try {
                port.postMessage({ noStream: true });
            } catch (e) { /* ignore */ }
        }
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'abort_stream') {
        // Abort the caller's stream when it identifies one, otherwise the active stream
        const target = findStream(message.streamId);
        if (!target && message.streamId) {
            // The request hasn't reached the background yet; drop it when it does
            abortedStreamIds.add(message.streamId);
            if (abortedStreamIds.size > 50) {
                abortedStreamIds.delete(abortedStreamIds.values().next().value as string);
            }
        }
        if (target && !target.done) {
            target.controller.abort();
            target.done = true;
            runningStreams.delete(target.id);
            updateKeepAlive();
            const save = target === activeStreamState ? saveActiveStreamToStorage() : Promise.resolve();
            save.then(() => {
                sendResponse({ aborted: true });
            });
        } else {
            sendResponse({ aborted: false });
        }
        return true;
    } else if (message.action === 'clear_active_stream') {
        // Only clear the record the caller is talking about, never a newer
        // stream started from another popup
        const matchesId = !message.streamId || !activeStreamState || activeStreamState.id === message.streamId;
        const allowedByState = !message.onlyIfDone || !activeStreamState || activeStreamState.done;
        if (matchesId && allowedByState) {
            clearActiveStream().then(() => {
                sendResponse({ cleared: true });
            });
        } else {
            sendResponse({ cleared: false });
        }
        return true;
    } else if (message.action === 'open_popup_hotkey' || message.action === 'toggle_popup_hotkey') {
        // Store selection if present
        if (message.selection) {
            chrome.storage.local.set({ contextSelection: message.selection }).then(() => {
                openUi();
            });
        } else {
            openUi();
        }
    } else if (message.action === 'execute_prompt_hotkey') {
        const data: any = { autoExecutePromptId: message.promptId };
        if (message.selection) {
            data.contextSelection = message.selection;
        }
        chrome.storage.local.set(data).then(() => {
            openUi();
        });
    } else if (message.action === 'capture_screenshot') {
        // Capture the visible tab as a screenshot
        (async () => {
            try {
                const windowId = sender.tab?.windowId;
                // Use current window if windowId is undefined
                const dataUrl = await chrome.tabs.captureVisibleTab(
                    windowId ?? chrome.windows.WINDOW_ID_CURRENT,
                    { format: 'png' }
                );
                sendResponse({ dataUrl });
            } catch (err: any) {
                sendResponse({ error: err.message });
            }
        })();
        return true; // Keep channel open for async response
    } else if (message.action === 'open_with_image') {
        // Open popup with cropped image
        (async () => {
            const appConfig = await getStorage();
            const mode = appConfig.popupMode || 'extension';
            const tabId = sender.tab?.id;

            if (mode === 'content_script' && tabId) {
                await sendToContentScript(tabId, {
                    action: 'open_content_popup',
                    selection: '',
                    image: message.image
                });
            } else {
                await chrome.storage.local.set({ contextSelection: null, contextImage: message.image });
                await openUi();
            }
        })().catch(error => {
            console.error('[AI Assistant] Failed to open image popup:', error);
        });
    } else if (message.type === 'PROXY_API_CALL') {
        executeApiCall(message.data.messages, message.data.config)
            .then(sendResponse)
            .catch(err => sendResponse({ error: err.message }));
        return true; // Keep channel open for async response
    } else if (message.type === 'PROXY_FETCH_MODELS') {
        executeFetchModels(message.data.provider, message.data.apiKey, message.data.baseUrl)
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ error: err.message }));
        return true; // Keep channel open
    }
});
