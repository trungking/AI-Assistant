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

/**
 * Extract text from a DOM node, preserving emoji alt text from img elements.
 * This handles sites like Twitter that render emojis as <img> tags.
 */
const extractTextFromNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;

    // Handle img elements - use alt text (often contains emoji)
    if (element.tagName === 'IMG') {
      return (element as HTMLImageElement).alt || '';
    }

    // Skip hidden elements
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') {
      return '';
    }

    // Recursively process child nodes
    let text = '';
    for (const child of Array.from(node.childNodes)) {
      text += extractTextFromNode(child);
    }

    // Add line breaks for block elements
    const blockTags = ['DIV', 'P', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
    if (blockTags.includes(element.tagName)) {
      text += '\n';
    }

    return text;
  }

  return '';
};

/**
 * Extract text from the current selection, preserving emojis rendered as images.
 */
export const extractTextFromSelection = (): string => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return '';
  }

  // First try the simple approach - if it contains emojis, it should work
  const simpleText = selection.toString();

  // Check if we might be missing emojis by looking at the selection contents
  try {
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();

    // Check if there are any img elements in the selection
    const hasImages = fragment.querySelectorAll('img').length > 0;

    if (hasImages) {
      // Extract text with alt text from images
      let extractedText = '';
      for (const child of Array.from(fragment.childNodes)) {
        extractedText += extractTextFromNode(child);
      }
      // Clean up extra whitespace while preserving intentional line breaks
      return extractedText
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } catch (e) {
    // Fall back to simple text if DOM manipulation fails
    console.warn('Failed to extract rich text:', e);
  }

  return simpleText;
};

export const getSelectedText = async (): Promise<string> => {
  // If we're in a content script, chrome.tabs won't be available (or full API won't be).
  // We can just use window.getSelection() directly.
  if (!chrome.tabs) {
    return extractTextFromSelection();
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return '';

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Inline the extraction logic for scripting.executeScript
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
      },
    });
    return result[0].result || '';
  } catch (e) {
    console.error('Failed to get selection:', e);
    return '';
  }
};
