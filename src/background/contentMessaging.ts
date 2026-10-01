const isWebPage = (url?: string) => !!url && /^https?:\/\//i.test(url);

export const injectContentScript = async (tabId: number): Promise<void> => {
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['assets/content.js'],
    });
};

export const sendToContentScript = async (tabId: number, message: unknown): Promise<void> => {
    let response: { error?: string } | undefined;
    try {
        response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
        // Tabs opened before installation/reload may have no live receiver.
        if (!(error instanceof Error) || !error.message.includes('Receiving end does not exist')) {
            throw error;
        }
        await injectContentScript(tabId);
        response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    }
    if (response?.error) throw new Error(response.error);
};

export const refreshContentScripts = async (): Promise<void> => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter(tab => tab.id !== undefined && isWebPage(tab.url)).map(async tab => {
        try {
            await injectContentScript(tab.id!);
        } catch {
            // A tab can close/navigate, or Chrome can prohibit injection (e.g. Web Store).
        }
    }));
};
