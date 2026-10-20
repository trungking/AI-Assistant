import { type AppConfig, DEFAULT_CONFIG } from './types';

/*
 * Config storage layout
 * ---------------------
 * chrome.storage.sync allows 8 KB per item and ~100 KB total, so the config is
 * serialized to JSON and split across several items:
 *   sync  'appConfig'            -> ConfigChunkHead { __chunked, count, hash }
 *   sync  'appConfig_0'..'_N-1'  -> consecutive slices of the JSON string
 * The head keeps the legacy key name, so `changes.appConfig` listeners still fire
 * whenever the content changes (the hash changes with it). A legacy head without
 * `__chunked` is a pre-chunking full config; it is read as-is and migrated.
 *
 * If the config would not fit sync's total quota, this device falls back to
 *   local 'appConfig.area' = 'local'  and  local 'appConfig.local' = full config
 * and reads prefer local while that flag is set. The next save that fits sync
 * moves it back. The system prompt always lives in local storage.
 */
const SYSTEM_PROMPT_STORAGE_KEY = 'appConfig.systemPrompt';
export const CONFIG_STORAGE_KEY = 'appConfig';
const CONFIG_CHUNK_PREFIX = 'appConfig_';
const CONFIG_AREA_STORAGE_KEY = 'appConfig.area';
const CONFIG_LOCAL_DATA_STORAGE_KEY = 'appConfig.local';
const CHUNK_FORMAT_VERSION = 1;
// Stay well below QUOTA_BYTES_PER_ITEM (8192); size = key length + JSON value bytes.
const CHUNK_MAX_BYTES = 7 * 1024;
// Leave headroom below QUOTA_BYTES (102400) for other sync items.
const SYNC_TOTAL_BUDGET_BYTES = 100 * 1024;

interface ConfigChunkHead {
  __chunked: number;
  count: number;
  hash: string;
}

type StoredConfig = Omit<AppConfig, 'systemPrompt'>;

const chunkKey = (index: number) => `${CONFIG_CHUNK_PREFIX}${index}`;
const isChunkKey = (key: string) => key.startsWith(CONFIG_CHUNK_PREFIX) && /^\d+$/.test(key.slice(CONFIG_CHUNK_PREFIX.length));
const isConfigSyncKey = (key: string) => key === CONFIG_STORAGE_KEY || isChunkKey(key);

const isChunkHead = (value: unknown): value is ConfigChunkHead =>
  typeof value === 'object' && value !== null
  && (value as ConfigChunkHead).__chunked === CHUNK_FORMAT_VERSION
  && Number.isInteger((value as ConfigChunkHead).count);

// Created lazily so importing this module has no side effects
let textEncoder: TextEncoder | null = null;
const itemBytes = (key: string, value: unknown) => {
  textEncoder ??= new TextEncoder();
  return key.length + textEncoder.encode(JSON.stringify(value)).length;
};

// FNV-1a; only used to detect content changes and torn chunk sets.
const hashString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
};

const splitIntoChunks = (json: string): string[] => {
  const chunks: string[] = [];
  let start = 0;
  while (start < json.length) {
    const key = chunkKey(chunks.length);
    const fits = (len: number) => itemBytes(key, json.slice(start, start + len)) <= CHUNK_MAX_BYTES;
    // Every char costs >= 1 byte, so a chunk never holds more than CHUNK_MAX_BYTES chars.
    let lo = 1;
    let hi = Math.min(json.length - start, CHUNK_MAX_BYTES);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    let end = start + lo;
    // Don't split a surrogate pair across chunks.
    const last = json.charCodeAt(end - 1);
    if (end < json.length && lo > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(json.slice(start, end));
    start = end;
  }
  return chunks;
};

const readChunkedConfig = (syncItems: Record<string, unknown>, head: ConfigChunkHead): Partial<StoredConfig> => {
  let json = '';
  for (let i = 0; i < head.count; i++) {
    const chunk = syncItems[chunkKey(i)];
    if (typeof chunk !== 'string') {
      throw new Error('Stored settings are incomplete (sync may still be in progress).');
    }
    json += chunk;
  }
  if (hashString(json) !== head.hash) {
    throw new Error('Stored settings are inconsistent (sync may still be in progress).');
  }
  return JSON.parse(json) as Partial<StoredConfig>;
};

// Keep long prompt text out of chrome.storage.sync.
const stripLocalOnlyConfig = (config: AppConfig): StoredConfig => {
  const { systemPrompt: _systemPrompt, ...syncConfig } = config;
  return syncConfig;
};

/** True when a storage.onChanged event touches the stored config. */
export const isConfigStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): boolean => {
  const keys = Object.keys(changes);
  if (areaName === 'sync') return keys.some(isConfigSyncKey);
  if (areaName === 'local') {
    return keys.some(key => key === SYSTEM_PROMPT_STORAGE_KEY || key === CONFIG_AREA_STORAGE_KEY || key === CONFIG_LOCAL_DATA_STORAGE_KEY);
  }
  return false;
};

let migrationPromise: Promise<void> | null = null;

export const getStorage = async (): Promise<AppConfig> => {
  const [syncResult, localResult] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get([SYSTEM_PROMPT_STORAGE_KEY, CONFIG_AREA_STORAGE_KEY, CONFIG_LOCAL_DATA_STORAGE_KEY]),
  ]);

  let stored: Partial<AppConfig>;
  let isLegacy = false;
  const localData = localResult[CONFIG_LOCAL_DATA_STORAGE_KEY];
  const head = syncResult[CONFIG_STORAGE_KEY];
  if (localResult[CONFIG_AREA_STORAGE_KEY] === 'local' && typeof localData === 'object' && localData !== null) {
    stored = localData as Partial<AppConfig>;
  } else if (isChunkHead(head)) {
    stored = readChunkedConfig(syncResult, head);
  } else {
    // Legacy single-item layout (or nothing stored yet).
    stored = (head || {}) as Partial<AppConfig>;
    isLegacy = !!head;
  }
  const localSystemPrompt = localResult[SYSTEM_PROMPT_STORAGE_KEY];

  // Deep merge to ensure new providers are included when loading old config
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    systemPrompt: typeof localSystemPrompt === 'string'
      ? localSystemPrompt
      : stored.systemPrompt ?? DEFAULT_CONFIG.systemPrompt,
    // Deep merge nested objects to include new provider defaults
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...stored.apiKeys },
    customBaseUrls: { ...DEFAULT_CONFIG.customBaseUrls, ...stored.customBaseUrls },
    selectedModel: { ...DEFAULT_CONFIG.selectedModel, ...stored.selectedModel },
  };

  if (isLegacy && !migrationPromise) {
    migrationPromise = setStorage(config)
      .catch(error => console.warn('Failed to migrate settings to chunked storage:', error))
      .finally(() => { migrationPromise = null; });
  }

  return config;
};

let writeQueue: Promise<void> = Promise.resolve();

const writeConfig = async (config: AppConfig): Promise<void> => {
  // A reader that still parses sync 'appConfig' as the full config sees the chunk
  // head merged into defaults. Saving that would wipe the real settings.
  if ('__chunked' in config) {
    throw new Error('Refusing to save settings loaded by an outdated reader; reload and try again.');
  }
  const data = stripLocalOnlyConfig(config);
  const json = JSON.stringify(data);
  const chunks = splitIntoChunks(json);
  const head: ConfigChunkHead = { __chunked: CHUNK_FORMAT_VERSION, count: chunks.length, hash: hashString(json) };
  const items: Record<string, unknown> = { [CONFIG_STORAGE_KEY]: head };
  chunks.forEach((chunk, i) => { items[chunkKey(i)] = chunk; });

  const existing = await chrome.storage.sync.get(null);
  const configBytes = Object.entries(items).reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);
  const otherBytes = Object.entries(existing)
    .filter(([key]) => !isConfigSyncKey(key))
    .reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);

  if (configBytes + otherBytes > SYNC_TOTAL_BUDGET_BYTES) {
    // Too large for sync: keep this device working from local storage.
    console.warn(`Settings (${configBytes} bytes) exceed the sync quota; storing them locally on this device only.`);
    await chrome.storage.local.set({
      [CONFIG_LOCAL_DATA_STORAGE_KEY]: data,
      [CONFIG_AREA_STORAGE_KEY]: 'local',
      [SYSTEM_PROMPT_STORAGE_KEY]: config.systemPrompt ?? '',
    });
    return;
  }

  // Write only changed items, all in one call (one write op, applied atomically).
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(items)) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(value)) changed[key] = value;
  }
  const stale = Object.keys(existing).filter(key =>
    isChunkKey(key) && Number(key.slice(CONFIG_CHUNK_PREFIX.length)) >= chunks.length
  );

  // Sync first: it is the write that can fail, and nothing is applied if it does.
  if (Object.keys(changed).length > 0) {
    await chrome.storage.sync.set(changed);
  }
  if (stale.length > 0) {
    // The head's count already excludes these, so a failure here is harmless.
    await chrome.storage.sync.remove(stale).catch(error => console.warn('Failed to remove stale settings chunks:', error));
  }

  await chrome.storage.local.set({ [SYSTEM_PROMPT_STORAGE_KEY]: config.systemPrompt ?? '' });
  await chrome.storage.local.remove([CONFIG_AREA_STORAGE_KEY, CONFIG_LOCAL_DATA_STORAGE_KEY]);
};

/** Persists the config. Rejects if the write fails (e.g. quota or rate limit). */
export const setStorage = (config: AppConfig): Promise<void> => {
  // Serialize writes from this context so chunk sets never interleave.
  const result = writeQueue.then(() => writeConfig(config));
  writeQueue = result.catch(() => undefined);
  return result;
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
