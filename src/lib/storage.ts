import { type AppConfig, DEFAULT_CONFIG } from './types';

export const getStorage = async (): Promise<AppConfig> => {
  const result = await chrome.storage.sync.get('appConfig');
  if (!result.appConfig) {
    return DEFAULT_CONFIG;
  }

  // Deep merge to ensure new providers are included when loading old config
  const stored = result.appConfig as Partial<AppConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    // Deep merge nested objects to include new provider defaults
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...stored.apiKeys },
    customBaseUrls: { ...DEFAULT_CONFIG.customBaseUrls, ...stored.customBaseUrls },
    selectedModel: { ...DEFAULT_CONFIG.selectedModel, ...stored.selectedModel },
  };
};

export const setStorage = async (config: AppConfig): Promise<void> => {
  await chrome.storage.sync.set({ appConfig: config });
};

export const getSelectedText = async (): Promise<string> => {
  // If we're in a content script, chrome.tabs won't be available (or full API won't be).
  // We can just use window.getSelection() directly.
  if (!chrome.tabs) {
    return window.getSelection()?.toString() || '';
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return '';

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() || '',
    });
    return result[0].result || '';
  } catch (e) {
    console.error('Failed to get selection:', e);
    return '';
  }
};
