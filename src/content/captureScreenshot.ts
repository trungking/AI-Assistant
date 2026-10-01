export const captureScreenshot = async (): Promise<string> => {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'capture_screenshot' });
            if (!response?.dataUrl) {
                throw new Error(response?.error || 'The extension returned no screenshot.');
            }
            return response.dataUrl;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('Extension context invalidated')) {
                throw new Error('AI Assistant was reloaded. Refresh this page and try again.');
            }
            if (!message.includes('Receiving end does not exist')) throw error;
            if (attempt === 2) {
                throw new Error('Cannot connect to AI Assistant. Reload the extension in chrome://extensions, then refresh this page.');
            }
            // A failed connection has not captured anything; retry only this failure.
            await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        }
    }
    throw new Error('Cannot capture screenshot.');
};
