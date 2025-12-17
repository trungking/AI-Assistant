import { DEFAULT_CONFIG } from '../lib/types';

chrome.runtime.onInstalled.addListener(async () => {
    // Initialize storage with defaults if not present
    const { appConfig } = await chrome.storage.sync.get('appConfig');
    if (!appConfig) {
        await chrome.storage.sync.set({ appConfig: DEFAULT_CONFIG });
    }

    // Create context menu
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const { appConfig } = await chrome.storage.sync.get('appConfig');
    const mode = (appConfig as any)?.popupMode || 'extension';

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
            chrome.tabs.sendMessage(tab.id, {
                action: 'open_content_popup',
                selection: selectedText,
                image: null
            });
        } else {
            await chrome.storage.local.set({ contextSelection: selectedText, contextImage: null });
            await openUi();
        }
    } else if (info.menuItemId === "ai-ask-image" && info.srcUrl && tab?.id) {
        if (mode === 'content_script') {
            chrome.tabs.sendMessage(tab.id, {
                action: 'open_content_popup',
                selection: '',
                image: info.srcUrl
            });
        } else {
            await chrome.storage.local.set({ contextSelection: null, contextImage: info.srcUrl });
            await openUi();
        }
    }
});

import { executeApiCall, executeFetchModels, executeApiStream } from '../lib/api';

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'stream_api') {
        const controller = new AbortController();

        port.onDisconnect.addListener(() => {
            controller.abort();
        });

        port.onMessage.addListener(async (msg) => {
            if (msg.messages && msg.config) {
                try {
                    const res = await executeApiStream(
                        msg.messages,
                        msg.config,
                        (chunk) => {
                            port.postMessage({ chunk });
                        },
                        controller.signal,
                        (webSearch) => {
                            // Send web search status to content script
                            try {
                                port.postMessage({ webSearch });
                            } catch (e) { /* ignore if disconnected */ }
                        }
                    );

                    if (res.error) {
                        // Check if still connected before posting?
                        // Abort might have happened.
                        try {
                            port.postMessage({ error: res.error });
                        } catch (e) { /* ignore */ }
                    } else {
                        try {
                            port.postMessage({ done: true });
                        } catch (e) { /* ignore */ }
                    }
                } catch (e: any) {
                    if (e.name === 'AbortError') return; // Ignore aborts
                    try {
                        port.postMessage({ error: e.message });
                        port.postMessage({ done: true });
                    } catch (err) { /* ignore */ }
                }
            }
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'open_popup_hotkey' || message.action === 'toggle_popup_hotkey') {
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
            const { appConfig } = await chrome.storage.sync.get('appConfig');
            const mode = (appConfig as any)?.popupMode || 'extension';
            const tabId = sender.tab?.id;

            if (mode === 'content_script' && tabId) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'open_content_popup',
                    selection: '',
                    image: message.image
                });
            } else {
                await chrome.storage.local.set({ contextSelection: null, contextImage: message.image });
                await openUi();
            }
        })();
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
