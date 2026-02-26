import type { AppConfig, ChatMessage } from './types';

interface ApiResponse {
  text: string;
  error?: string;
}

/**
 * Parse image URL for Gemini API format.
 * Expects a data URL (base64). External URLs should be converted to data URLs
 * by the background script before reaching here.
 */
const parseImageForGemini = (imageUrl: string): { inlineData: { mimeType: string; data: string } } | null => {
  if (!imageUrl) return null;

  // Check if it's a data URL (base64)
  if (imageUrl.startsWith('data:')) {
    const [meta, data] = imageUrl.split(',');
    if (!meta || !data) return null;

    const mimeType = meta.split(':')[1]?.split(';')[0];
    if (!mimeType) return null;

    return { inlineData: { mimeType, data } };
  }

  // External URLs should have been converted to data URLs by the background script
  // Log a warning if we somehow get here with an external URL
  console.warn('parseImageForGemini received external URL instead of data URL:', imageUrl.substring(0, 100));
  return null;
};

// Web Search Tool Definition (OpenAI format)
const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use this when you need up-to-date information, recent news, current events, or facts you are unsure about. You can call this tool multiple times in parallel for different queries, or pass a "queries" array to search for multiple things in a single call.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A single search query to look up on the web'
        },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple search queries to execute in parallel. Use this when you need to search for several different things at once.'
        }
      },
      required: []
    }
  }
};

// Google Search Tool Definition (Gemini native format)
const GOOGLE_SEARCH_TOOL = {
  google_search: {}
};

// OpenAI Native Web Search Tool Definition
const OPENAI_WEB_SEARCH_TOOL = {
  type: 'web_search' as const
};

/**
 * Sanitize ChatMessage array for API consumption.
 * Removes UI-only fields and filters out empty assistant messages.
 */
const sanitizeMessagesForApi = (messages: ChatMessage[]): Array<{ role: string; content: string; image?: string }> => {
  return messages
    // Filter out empty assistant messages (created during web search flow)
    .filter(m => !(m.role === 'assistant' && !m.content))
    // Keep only API-relevant fields
    .map(m => {
      const sanitized: { role: string; content: string; image?: string } = {
        role: m.role,
        content: m.content
      };
      if (m.image) {
        sanitized.image = m.image;
      }
      return sanitized;
    });
};

// Execute web search using Perplexity or Kagi
interface WebSearchResult {
  content: string;
  sources: Array<{ title: string; url: string; snippet?: string }>;
}

// Execute web search using Kagi
const executeKagiWebSearch = async (query: string, kagiSession: string, signal?: AbortSignal): Promise<WebSearchResult> => {
  try {
    // URL encode the query
    const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');

    const response = await fetch(`https://kagi.com/mother/context?q=${encodedQuery}`, {
      method: 'POST',
      headers: {
        'accept': 'application/vnd.kagi.stream',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'content-length': '0',
        'origin': 'https://kagi.com',
        'pragma': 'no-cache',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'cookie': `kagi_session=${kagiSession}`
      },
      signal
    });

    if (!response.ok) {
      return { content: `Kagi search error: ${response.statusText}`, sources: [] };
    }

    // Kagi returns raw text with JSON-like structure
    const rawText = await response.text();
    let content = '';
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];

    try {
      // Parse Kagi response
      // Format is typically lines of JSON objects prefixed with type
      const lines = rawText.split(/\r?\n/);
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('new_message.json:')) {
          const jsonStr = trimmedLine.substring('new_message.json:'.length);
          try {
            // Attempt to clean trailing garbage if simple parse fails
            let data;
            try {
              data = JSON.parse(jsonStr);
            } catch (e) {
              // Try to find the last closing brace
              const lastBrace = jsonStr.lastIndexOf('}');
              if (lastBrace !== -1) {
                data = JSON.parse(jsonStr.substring(0, lastBrace + 1));
              } else {
                throw e;
              }
            }

            if (data.md) {
              content = data.md;
            }

            if (data.references_md) {
              // Format: [^1]: [Title](url) (percentage)
              const regex = /\[\^(\d+)\]:\s*\[(.*?)\]\((.*?)\)/g;
              let match;
              while ((match = regex.exec(data.references_md)) !== null) {
                sources.push({
                  title: match[2],
                  url: match[3]
                });
              }
            }
          } catch (parseError) {
            console.error('Error parsing Kagi JSON payload:', parseError);
          }
          // We found the message, breaks out of loop.
          // Note: In case of multiple messages, we might want the last one,
          // but Kagi usually sends one final 'done' state message.
          if (content) break;
        }
      }
    } catch (e) {
      console.warn('Failed to parse Kagi structured response', e);
    }

    // Fallback parsing if structured parse failed
    if (!content) {
      const mdMatch = rawText.match(/"md":"([\s\S]*?)","metadata"/);
      if (mdMatch && mdMatch[1]) {
        // Unescape the JSON string content
        content = mdMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      } else {
        content = rawText;
      }
    }

    return { content: content || 'No search results found.', sources };
  } catch (e: any) {
    return { content: `Kagi search failed: ${e.message}`, sources: [] };
  }
};

// Execute web search using Perplexity
const executePerplexityWebSearch = async (query: string, config: AppConfig, signal?: AbortSignal): Promise<WebSearchResult> => {
  const perplexityKeys = config.apiKeys['perplexity'];
  if (!perplexityKeys || perplexityKeys.length === 0) {
    return { content: 'Error: No Perplexity API key configured for web search.', sources: [] };
  }

  const apiKey = perplexityKeys[Math.floor(Math.random() * perplexityKeys.length)];
  const baseUrl = config.customBaseUrls['perplexity'] || 'https://api.perplexity.ai';
  const model = 'sonar-pro'; // Use sonar-pro for comprehensive web search

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: 'You are a web search assistant. Provide concise, factual answers based on current web information. Include relevant sources when possible.' },
          { role: 'user', content: query }
        ],
        web_search_options: {
          search_type: 'pro'
        }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return { content: `Search error: ${err.error?.message || response.statusText}`, sources: [] };
    }

    const data = await response.json();

    const content = data.choices?.[0]?.message?.content || 'No search results found.';

    // Extract citations from Perplexity response
    // Perplexity can return citations in different places:
    // - data.citations (older/current root-level)
    // - data.choices[0].message.citations (newer per-message level)
    // - data.search_results (alternative format)
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];

    // Try multiple possible locations for citations
    const citations = data.citations
      || data.choices?.[0]?.message?.citations
      || data.search_results
      || [];

    if (Array.isArray(citations)) {
      citations.forEach((item: any, index: number) => {
        if (typeof item === 'string') {
          // Simple URL string
          sources.push({
            title: `Source ${index + 1}`,
            url: item
          });
        } else if (item && typeof item === 'object') {
          // Object with url/title
          sources.push({
            title: item.title || item.name || `Source ${index + 1}`,
            url: item.url || item.link || '',
            snippet: item.snippet || item.description
          });
        }
      });
    }


    return { content, sources };
  } catch (e: any) {
    return { content: `Search failed: ${e.message}`, sources: [] };
  }
};

// Execute web search using Google Grounding Search (via Gemini API)
const executeGoogleWebSearch = async (query: string, config: AppConfig, signal?: AbortSignal): Promise<WebSearchResult> => {
  // Try to use Google API key first, otherwise use current provider's key
  const currentProvider = config.selectedProvider;
  const googleKeys = config.apiKeys['google'];
  const currentProviderKeys = config.apiKeys[currentProvider];

  let apiKey: string;
  let baseUrl: string;
  let useOpenAIFormat = false;

  if (googleKeys && googleKeys.length > 0) {
    // Use Google API
    apiKey = googleKeys[Math.floor(Math.random() * googleKeys.length)];
    baseUrl = config.customBaseUrls['google'] || 'https://generativelanguage.googleapis.com/v1beta';
  } else if (currentProviderKeys && currentProviderKeys.length > 0) {
    // Use current provider (likely supports Gemini models)
    apiKey = currentProviderKeys[Math.floor(Math.random() * currentProviderKeys.length)];
    baseUrl = config.customBaseUrls[currentProvider] || '';
    useOpenAIFormat = currentProvider !== 'google'; // Custom providers use OpenAI format
  } else {
    return { content: 'Error: No API key available for web search.', sources: [] };
  }

  // Use gemini-3-flash-preview for Google grounding search
  const model = 'gemini-3-flash-preview';

  try {
    let url: string;
    let requestBody: any;
    let headers: any = { 'Content-Type': 'application/json' };

    if (useOpenAIFormat) {
      // OpenAI-compatible format for custom providers  
      url = `${baseUrl}/chat/completions`;
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = {
        model: model,
        messages: [{ role: 'user', content: query }],
        tools: [GOOGLE_SEARCH_TOOL]
      };
    } else {
      // Gemini API format
      url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;
      requestBody = {
        contents: [{
          role: 'user',
          parts: [{ text: query }]
        }],
        tools: [GOOGLE_SEARCH_TOOL]
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const err = await response.json();
      return { content: `Google search error: ${err.error?.message || response.statusText}`, sources: [] };
    }

    const data = await response.json();

    // Extract content and grounding metadata - handle both Gemini and OpenAI response formats
    let content: string;
    let groundingMetadata: any;

    if (data.candidates) {
      // Gemini format
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No search results found.';
      groundingMetadata = data.candidates?.[0]?.groundingMetadata;
    } else if (data.choices) {
      // OpenAI format
      content = data.choices?.[0]?.message?.content || 'No search results found.';
      groundingMetadata = data.choices?.[0]?.message?.groundingMetadata;
    } else {
      content = 'No search results found.';
    }

    // Extract grounding metadata for sources
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];

    if (groundingMetadata?.groundingChunks) {
      groundingMetadata.groundingChunks.forEach((chunk: any) => {
        if (chunk.web) {
          sources.push({
            title: chunk.web.title || 'Source',
            url: chunk.web.uri || '',
            snippet: chunk.web.snippet
          });
        }
      });
    }

    // Also check webSearchQueries if available
    if (groundingMetadata?.webSearchQueries) {
      // Store the queries used (optional, for debugging)
      console.log('Google search queries used:', groundingMetadata.webSearchQueries);
    }

    return { content, sources };
  } catch (e: any) {
    return { content: `Google search failed: ${e.message}`, sources: [] };
  }
};

// Main web search dispatcher
const executeWebSearch = async (query: string, config: AppConfig, signal?: AbortSignal): Promise<WebSearchResult> => {
  const provider = config.webSearchProvider || 'perplexity';

  if (provider === 'kagi') {
    if (config.kagiSession) {
      return executeKagiWebSearch(query, config.kagiSession, signal);
    }
    // Fallback if session missing
    return { content: 'Error: Kagi session cookie is missing.', sources: [] };
  }

  if (provider === 'google') {
    return executeGoogleWebSearch(query, config, signal);
  }

  // Default to Perplexity
  return executePerplexityWebSearch(query, config, signal);
};

// Check if web search should be enabled for this request
const shouldEnableWebSearch = (config: AppConfig, model?: string): boolean => {
  // Web search is enabled if:
  // 1. User has enableWebSearch turned on (or undefined, default to true)
  // 2. Either Perplexity API key, Kagi session, or Google API key is configured (depending on selected provider)
  //    OR using a Gemini model with Google grounding search (native support via custom provider)
  // 3. Current provider is NOT perplexity (no need for tool when using perplexity directly)
  const webSearchProvider = config.webSearchProvider || 'perplexity';
  const hasPerplexityKey = config.apiKeys['perplexity']?.length > 0;
  const hasKagiSession = !!config.kagiSession;
  const hasGoogleKey = config.apiKeys['google']?.length > 0;

  // Check if current provider has API key
  const currentProvider = config.selectedProvider;
  const hasCurrentProviderKey = config.apiKeys[currentProvider]?.length > 0;

  // Check if using a Gemini model with Google grounding search
  const isGeminiModel = model ? /^gemini-\d+/.test(model) : false;
  const usingGoogleGroundingNatively = webSearchProvider === 'google' && isGeminiModel;

  // Check if using an OpenAI/GPT model with native web search (web_search_options)
  // Works with both the built-in OpenAI provider and custom OpenAI-compatible providers
  const isGPTModel = model ? /^(gpt-|o\d|chatgpt-)/.test(model) : false;
  const isCustomProvider = config.customProviders?.some(cp => cp.id === currentProvider);
  const usingOpenAINatively = isGPTModel && (currentProvider === 'openai' || !!isCustomProvider);

  let hasWebSearchCredentials = false;
  if (usingOpenAINatively) {
    // OpenAI native search: just needs an OpenAI API key (already have it)
    hasWebSearchCredentials = true;
  } else if (webSearchProvider === 'kagi') {
    hasWebSearchCredentials = hasKagiSession;
  } else if (webSearchProvider === 'google') {
    hasWebSearchCredentials = usingGoogleGroundingNatively || hasGoogleKey || hasCurrentProviderKey;
  } else {
    hasWebSearchCredentials = hasPerplexityKey;
  }

  const webSearchEnabled = config.enableWebSearch !== false; // Default to true
  const notUsingPerplexity = config.selectedProvider !== 'perplexity';

  return hasWebSearchCredentials && webSearchEnabled && notUsingPerplexity;
};

// API Key Quota Management
interface ExhaustedKeyEntry {
  key: string;
  provider: string;
  exhaustedAt: number;
  expiresAt: number; // First day of next month
}

const EXHAUSTED_KEYS_STORAGE_KEY = 'exhaustedApiKeys';

// Get first day of next month (when quotas reset)
const getNextMonthReset = (): number => {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.getTime();
};

// Get exhausted keys from storage
const getExhaustedKeys = async (): Promise<ExhaustedKeyEntry[]> => {
  try {
    const result = await chrome.storage.local.get(EXHAUSTED_KEYS_STORAGE_KEY) as Record<string, ExhaustedKeyEntry[]>;
    const entries: ExhaustedKeyEntry[] = result[EXHAUSTED_KEYS_STORAGE_KEY] || [];
    // Filter out expired entries (past their reset date)
    const now = Date.now();
    return entries.filter(e => e.expiresAt > now);
  } catch {
    return [];
  }
};

// Mark a key as exhausted
const markKeyExhausted = async (key: string, provider: string): Promise<void> => {
  try {
    const entries = await getExhaustedKeys();
    // Check if already marked
    if (entries.some(e => e.key === key && e.provider === provider)) {
      return;
    }
    entries.push({
      key,
      provider,
      exhaustedAt: Date.now(),
      expiresAt: getNextMonthReset()
    });
    await chrome.storage.local.set({ [EXHAUSTED_KEYS_STORAGE_KEY]: entries });
    console.log(`API key marked as exhausted for ${provider}, will reset on next month`);
  } catch (e) {
    console.error('Failed to mark key as exhausted:', e);
  }
};

// Get available (non-exhausted) keys for a provider
const getAvailableKeys = async (allKeys: string[], provider: string): Promise<string[]> => {
  const exhaustedEntries = await getExhaustedKeys();
  const exhaustedForProvider = new Set(
    exhaustedEntries.filter(e => e.provider === provider).map(e => e.key)
  );
  return allKeys.filter(k => !exhaustedForProvider.has(k));
};

// Check if error indicates quota exhaustion
const isQuotaError = (error: string): boolean => {
  const quotaPatterns = [
    'quota',
    'rate limit',
    'rate_limit',
    'too many requests',
    'exceeded',
    'insufficient_quota',
    'billing',
    'credits',
    '429',
    'resource_exhausted'
  ];
  const lowerError = error.toLowerCase();
  return quotaPatterns.some(p => lowerError.includes(p));
};

// Select a random available key
const selectRandomKey = async (allKeys: string[], provider: string): Promise<{ key: string; available: string[] } | null> => {
  const available = await getAvailableKeys(allKeys, provider);
  if (available.length === 0) {
    // All keys exhausted, try using any key anyway (maybe quotas reset)
    if (allKeys.length > 0) {
      return { key: allKeys[Math.floor(Math.random() * allKeys.length)], available: [] };
    }
    return null;
  }
  return { key: available[Math.floor(Math.random() * available.length)], available };
};

export const executeApiCall = async (
  messages: ChatMessage[],
  config: AppConfig
): Promise<ApiResponse> => {
  const provider = config.selectedProvider;
  const apiKeys = config.apiKeys[provider];

  if (!apiKeys || apiKeys.length === 0) {
    return { text: '', error: `No API key found for ${provider}` };
  }

  // Select a random available API key (avoiding exhausted ones)
  const keySelection = await selectRandomKey(apiKeys, provider);
  if (!keySelection) {
    return { text: '', error: `No available API keys for ${provider}. All keys may have exhausted quota.` };
  }

  const apiKey = keySelection.key;
  const baseUrl = config.customBaseUrls[provider] || getDefaultBaseUrl(provider);
  const model = config.selectedModel[provider];

  try {
    let result: ApiResponse;
    switch (provider) {
      case 'google':
        result = await callGoogle(apiKey, baseUrl, model, messages);
        break;
      case 'openai':
        result = await callOpenAI(apiKey, baseUrl, model, messages);
        break;
      case 'anthropic':
        result = await callAnthropic(apiKey, baseUrl, model, messages);
        break;
      case 'openrouter':
        result = await callOpenRouter(apiKey, baseUrl, model, messages);
        break;
      case 'perplexity':
        result = await callPerplexity(apiKey, baseUrl, model, messages);
        break;
      default:
        result = await callOpenAI(apiKey, baseUrl, model, messages);
    }

    // Check if response indicates quota exhaustion
    if (result.error && isQuotaError(result.error)) {
      await markKeyExhausted(apiKey, provider);
    }

    return result;
  } catch (e: any) {
    const errorMsg = e.message || 'API call failed';
    // Check if error indicates quota exhaustion
    if (isQuotaError(errorMsg)) {
      await markKeyExhausted(apiKey, provider);
    }
    return { text: '', error: errorMsg };
  }
};

export const executeApiStream = async (
  messages: ChatMessage[],
  config: AppConfig,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void,
  onReasoning?: (text: string) => void,
  onImage?: (imageUrl: string) => void
): Promise<ApiResponse> => {
  const provider = config.selectedProvider;
  const apiKeys = config.apiKeys[provider];

  if (!apiKeys || apiKeys.length === 0) {
    return { text: '', error: `No API key found for ${provider}` };
  }

  // Select a random available API key (avoiding exhausted ones)
  const keySelection = await selectRandomKey(apiKeys, provider);
  if (!keySelection) {
    return { text: '', error: `No available API keys for ${provider}. All keys may have exhausted quota.` };
  }

  const apiKey = keySelection.key;
  const baseUrl = config.customBaseUrls[provider] || getDefaultBaseUrl(provider);
  const model = config.selectedModel[provider];

  try {
    let result: ApiResponse;
    switch (provider) {
      case 'google':
        result = await streamGoogle(apiKey, baseUrl, model, messages, onChunk, signal, config, onWebSearch, onReasoning, onImage);
        break;
      case 'openai':
      case 'openrouter':
        result = await streamOpenAI(apiKey, baseUrl, model, messages, onChunk, provider === 'openrouter', signal, config, onWebSearch, onReasoning, onImage);
        break;
      case 'anthropic':
        result = await streamAnthropic(apiKey, baseUrl, model, messages, onChunk, signal, config, onReasoning);
        break;
      case 'perplexity':
        result = await streamPerplexity(apiKey, baseUrl, model, messages, onChunk, signal, onReasoning);
        break;
      default:
        result = await streamOpenAI(apiKey, baseUrl, model, messages, onChunk, false, signal, config, onWebSearch, onReasoning, onImage);
    }

    // Check if response indicates quota exhaustion
    if (result.error && isQuotaError(result.error)) {
      await markKeyExhausted(apiKey, provider);
    }

    return result;
  } catch (e: any) {
    if (e.name === 'AbortError') throw e;
    const errorMsg = e.message || 'Stream failed';
    // Check if error indicates quota exhaustion
    if (isQuotaError(errorMsg)) {
      await markKeyExhausted(apiKey, provider);
    }
    return { text: '', error: errorMsg };
  }
};

export const callApi = async (
  messages: ChatMessage[],
  config: AppConfig,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void,
  onReasoning?: (text: string) => void,
  onImage?: (imageUrl: string) => void
): Promise<ApiResponse> => {
  // Check context
  if (window.location.protocol.startsWith('http')) {
    // Content Script -> Proxy to Background
    if (onChunk) {
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'stream_api' });
        let fullText = '';

        if (signal) {
          signal.addEventListener('abort', () => {
            // Send abort message to background instead of just disconnecting
            // This tells background to actually stop the stream
            chrome.runtime.sendMessage({ action: 'abort_stream' }).catch(() => { });
            port.disconnect();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }

        port.onMessage.addListener((msg) => {
          if (msg.done) {
            port.disconnect();
            resolve({ text: fullText });
          } else if (msg.error) {
            port.disconnect();
            resolve({ text: fullText, error: msg.error });
          } else if (msg.chunk) {
            fullText += msg.chunk;
            onChunk(msg.chunk);
          } else if (msg.reasoning && onReasoning) {
            // Handle reasoning content from background
            onReasoning(msg.reasoning);
          } else if (msg.webSearch && onWebSearch) {
            // Handle web search status from background
            onWebSearch(msg.webSearch);
          } else if (msg.image && onImage) {
            // Handle image from background
            onImage(msg.image);
          }
        });

        port.postMessage({ messages, config });
      });
    } else {
      return chrome.runtime.sendMessage({
        type: 'PROXY_API_CALL',
        data: { messages, config }
      });
    }
  } else {
    // Extension Context -> Also use port-based streaming for background continuation
    if (onChunk) {
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'stream_api' });
        let fullText = '';

        if (signal) {
          signal.addEventListener('abort', () => {
            chrome.runtime.sendMessage({ action: 'abort_stream' }).catch(() => { });
            port.disconnect();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }

        port.onMessage.addListener((msg) => {
          if (msg.done) {
            port.disconnect();
            resolve({ text: fullText });
          } else if (msg.error) {
            port.disconnect();
            resolve({ text: fullText, error: msg.error });
          } else if (msg.chunk) {
            fullText += msg.chunk;
            onChunk(msg.chunk);
          } else if (msg.reasoning && onReasoning) {
            onReasoning(msg.reasoning);
          } else if (msg.webSearch && onWebSearch) {
            onWebSearch(msg.webSearch);
          } else if (msg.image && onImage) {
            onImage(msg.image);
          }
        });

        port.postMessage({ messages, config });
      });
    } else {
      return executeApiCall(messages, config);
    }
  }
};

export const executeFetchModels = async (
  provider: string,
  apiKey: string,
  baseUrl?: string
): Promise<string[]> => {
  const url = baseUrl || getDefaultBaseUrl(provider);

  try {
    if (provider === 'google') {
      const res = await fetch(`${url}/models?key=${apiKey}`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      return (data.models || [])
        .map((m: any) => m.name.replace('models/', ''))
        .sort();
    } else if (provider === 'perplexity') {
      // Perplexity doesn't have a /models endpoint, return known models
      return [
        'sonar-pro',
        'sonar',
        'sonar-reasoning-pro',
        'sonar-reasoning'
      ];
    } else {
      // OpenAI compatible (OpenAI, OpenRouter, Custom)
      // Always send API key if available
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(`${url}/models`, {
        headers
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      return (data.data || []).map((m: any) => m.id).sort();
    }
  } catch (e) {
    console.error("Failed to fetch models", e);
    throw e;
  }
};

export const fetchModels = async (
  provider: string,
  apiKey: string,
  baseUrl?: string
): Promise<string[]> => {
  if (window.location.protocol.startsWith('http')) {
    return chrome.runtime.sendMessage({
      type: 'PROXY_FETCH_MODELS',
      data: { provider, apiKey, baseUrl }
    });
  } else {
    return executeFetchModels(provider, apiKey, baseUrl);
  }
};

const getDefaultBaseUrl = (provider: string) => {
  switch (provider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'google': return 'https://generativelanguage.googleapis.com/v1beta';
    case 'anthropic': return 'https://api.anthropic.com/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'perplexity': return 'https://api.perplexity.ai';
    default: return '';
  }
}

const callGoogle = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[]): Promise<ApiResponse> => {
  const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;

  // Convert standard messages to Gemini format
  const contents = messages.map(m => {
    const parts: any[] = [{ text: m.content }];
    if (m.image) {
      const imagePart = parseImageForGemini(m.image);
      if (imagePart) {
        parts.push(imagePart);
      }
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: contents
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || '' };
};

const callOpenAI = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[]): Promise<ApiResponse> => {
  const url = `${baseUrl}/chat/completions`;

  const msgs = messages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: m.image } }
        ]
      };
    }
    return m;
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: msgs
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  return { text: data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '' };
};

const callAnthropic = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[]): Promise<ApiResponse> => {
  const url = `${baseUrl}/messages`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const systemMessage = sanitizedMessages.find(m => m.role === 'system');
  const chatMessages = sanitizedMessages.filter(m => m.role !== 'system').map(m => {
    if (m.image) {
      const [meta, data] = m.image.split(',');
      const mimeType = meta.split(':')[1].split(';')[0];
      return {
        role: m.role,
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data } },
          { type: "text", text: m.content }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const body: any = {
    model: model,
    max_tokens: 1024,
    messages: chatMessages
  };

  if (systemMessage) {
    body.system = systemMessage.content;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  return { text: data.content?.[0]?.text || '' };
};

const callOpenRouter = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[]): Promise<ApiResponse> => {
  // OpenRouter is OpenAI compatible
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: m.image } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // Optional headers for OpenRouter
      'HTTP-Referer': 'https://github.com/your/repo',
      'X-Title': 'AI Ask Extension',
    },
    body: JSON.stringify({
      model: model,
      messages: msgs
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  return { text: data.choices?.[0]?.message?.content || '' };
}

// Perplexity API (OpenAI compatible with web search capabilities)
const callPerplexity = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[]): Promise<ApiResponse> => {
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: m.image } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: msgs,
      web_search_options: {
        search_type: 'pro'
      }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  return { text: data.choices?.[0]?.message?.content || '' };
}

// Streaming Implementations

const readStream = async (response: Response, onChunk: (text: string) => void, parser: (chunk: string) => string | null) => {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  if (!reader) throw new Error('Response body is unavailable');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process buffer lines
    // We split by newlines but keep the buffer if it doesn't end with one to handle split packets
    // However, generic logic:

    // Strategy: Process one valid unit at a time.
    // For SSE, usually split by \n\n or \n.
    // For Google JSON array, it's tricker.

    // Let's implement provider-specific buffering in the parser or just pass raw chunk?
    // Better: pass raw chunk to parser or handle buffering here.
    // For simplicity for now: assume parser handles string chunks or we do simple line splitting.
    // SSE is based on lines.

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep the last partial line

    for (const line of lines) {
      const parsed = parser(line);
      if (parsed) onChunk(parsed);
    }
  }

  // Process remaining buffer
  if (buffer) {
    const parsed = parser(buffer);
    if (parsed) onChunk(parsed);
  }
};

const streamOpenAI = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, isOpenRouter = false, signal?: AbortSignal, config?: AppConfig, onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void, onReasoning?: (text: string) => void, onImage?: (imageUrl: string) => void): Promise<ApiResponse> => {
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: m.image } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://github.com/your/repo';
    headers['X-Title'] = 'AI Ask Extension';
  }

  // Build request body
  // Add current date/time context for time-sensitive queries
  const now = new Date();

  const currentDateTime = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  // Detect web search configuration early to conditionally add instructions
  const webSearchEnabled = config && shouldEnableWebSearch(config, model);
  const isGeminiModel = /^gemini-\d+/.test(model);
  const useNativeGoogleSearch = webSearchEnabled &&
    config?.webSearchProvider === 'google' &&
    isGeminiModel;

  // Detect OpenAI native web search (GPT models on OpenAI provider)
  const isGPTModel = /^(gpt-|o\d|chatgpt-)/.test(model);
  const useNativeOpenAISearch = webSearchEnabled && !isOpenRouter && isGPTModel;

  // Only add web search instructions for OpenAI-format function tool, not for native search
  const webSearchInstruction = (!useNativeGoogleSearch && !useNativeOpenAISearch && webSearchEnabled)
    ? ' The web search tool retrieves real-time information. When searching for current status (e.g. "price now", "latest news"), do NOT unnecessarily append the current month/year to the query, as this may limit results. Trust the search tool to provide the latest data. Only specify dates if searching for historical information or specific future projections. If you decide to use the web search tool, you should briefly explain what you are going to search for before calling the tool. You can call web_search multiple times in parallel if you need to search for different things simultaneously, or pass a "queries" array to search for multiple things in a single call.'
    : '';

  const dateContext = `IMPORTANT: Today's date is ${currentDateTime}.${webSearchInstruction}`;

  // Prepend system message with current time if not already present
  const msgsWithTime = msgs[0]?.role === 'system'
    ? [{ ...msgs[0], content: `${dateContext}\n\n${msgs[0].content}` }, ...msgs.slice(1)]
    : [{ role: 'system', content: `${dateContext}\n\nYou are a helpful assistant.` }, ...msgs];

  const requestBody: any = {
    model: model,
    messages: msgsWithTime,
    stream: true
  };


  if (webSearchEnabled) {
    if (useNativeGoogleSearch) {
      // Use native Google grounding search for Gemini models
      requestBody.tools = [GOOGLE_SEARCH_TOOL];
    } else if (useNativeOpenAISearch) {
      // Use OpenAI native web search tool
      requestBody.tools = [OPENAI_WEB_SEARCH_TOOL];
    } else {
      // Use OpenAI-format web search function tool for other models
      requestBody.tools = [WEB_SEARCH_TOOL];
      requestBody.tool_choice = 'auto';
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const err = await response.text();
    try {
      const jsonErr = JSON.parse(err);
      throw new Error(jsonErr.error?.message || response.statusText);
    } catch {
      throw new Error(err || response.statusText);
    }
  }

  let fullText = '';
  let toolCalls: any[] = [];
  let groundingSources: Array<{ title: string; url: string; snippet?: string }> = [];
  let openAISearchAnnotations: Array<any> = [];

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const choice = data.choices?.[0];
    fullText = choice?.message?.content || choice?.text || '';
    if (fullText) onChunk(fullText);

    if (choice?.message?.tool_calls) {
      toolCalls = choice.message.tool_calls;
    }

    // Extract grounding metadata for Gemini models with native search
    if (useNativeGoogleSearch && choice?.message?.groundingMetadata) {
      const groundingMetadata = choice.message.groundingMetadata;
      if (groundingMetadata?.groundingChunks) {
        groundingMetadata.groundingChunks.forEach((chunk: any) => {
          if (chunk.web) {
            groundingSources.push({
              title: chunk.web.title || 'Source',
              url: chunk.web.uri || '',
              snippet: chunk.web.snippet
            });
          }
        });
      }
    }

    // Extract annotations for OpenAI native web search
    if (useNativeOpenAISearch && choice?.message?.annotations) {
      openAISearchAnnotations = choice.message.annotations;
    }
  } else {
    await readStream(response, (text) => {
      fullText += text;
      onChunk(text);
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      if (dataStr === '[DONE]') return null;

      try {
        const json = JSON.parse(dataStr);
        const choice = json.choices?.[0];

        // Check for tool calls
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        }

        // Extract grounding metadata for Gemini models in streaming
        if (useNativeGoogleSearch && choice?.delta?.groundingMetadata) {
          const groundingMetadata = choice.delta.groundingMetadata;
          if (groundingMetadata?.groundingChunks) {
            groundingMetadata.groundingChunks.forEach((chunk: any) => {
              if (chunk.web) {
                // Check if we already have this source to avoid duplicates
                const exists = groundingSources.some(s => s.url === chunk.web.uri);
                if (!exists) {
                  groundingSources.push({
                    title: chunk.web.title || 'Source',
                    url: chunk.web.uri || '',
                    snippet: chunk.web.snippet
                  });
                }
              }
            });
          }
        }

        // Extract annotations for OpenAI native web search in streaming
        if (useNativeOpenAISearch && choice?.delta?.annotations) {
          for (const ann of choice.delta.annotations) {
            openAISearchAnnotations.push(ann);
          }
        }

        // Handle reasoning_content (used by models like DeepSeek)
        const reasoningContent = choice?.delta?.reasoning_content;
        if (reasoningContent && onReasoning) {
          onReasoning(reasoningContent);
        }

        // Handle images (used by models that return generated images)
        const images = choice?.delta?.images;
        if (images && Array.isArray(images) && onImage) {
          for (const img of images) {
            if (img?.image_url?.url) {
              onImage(img.image_url.url);
            }
          }
        }

        const content = choice?.delta?.content;
        return content || null;
      } catch (e) {
        return null;
      }
    });
  }

  // If we have grounding sources from native Google search, notify the UI
  if (useNativeGoogleSearch && groundingSources.length > 0 && onWebSearch) {
    onWebSearch({
      query: messages[messages.length - 1]?.content || '',
      result: fullText,
      isSearching: false,
      sources: groundingSources
    });
  }

  // If we have annotations from native OpenAI search, extract sources and notify UI
  if (useNativeOpenAISearch && openAISearchAnnotations.length > 0 && onWebSearch) {
    const sources = openAISearchAnnotations
      .filter((a: any) => a.type === 'url_citation' && (a.url_citation || a.url))
      .map((a: any) => {
        const citation = a.url_citation || {};
        return {
          title: citation.title || 'Source',
          url: citation.url || a.url || '',
        };
      })
      // Deduplicate by URL
      .filter((s: { title: string; url: string }, i: number, arr: { title: string; url: string }[]) => arr.findIndex(x => x.url === s.url) === i);

    if (sources.length > 0) {
      onWebSearch({
        query: messages[messages.length - 1]?.content || '',
        result: fullText,
        isSearching: false,
        sources: sources
      });
    }
  }

  // Handle tool calls recursively - AI may request multiple web searches in sequence
  // Skip for native OpenAI search since it handles web search internally via web_search_options
  if (toolCalls.length > 0 && config && webSearchEnabled && !useNativeOpenAISearch) {
    let currentToolCalls = toolCalls;
    let currentMessages = msgsWithTime;
    let currentFullText = fullText;
    const MAX_TOOL_ITERATIONS = 5; // Prevent infinite loops
    let iteration = 0;

    while (currentToolCalls.length > 0 && iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      try {
        // Collect all search tasks from current tool calls
        const searchTasks: Array<{ toolCall: any; query: string }> = [];

        for (const toolCall of currentToolCalls) {
          if (toolCall.function.name === 'web_search') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              if (args.queries && Array.isArray(args.queries) && args.queries.length > 0) {
                // Multiple queries in one tool call - create tasks for each
                for (const q of args.queries) {
                  if (typeof q === 'string' && q.trim()) {
                    searchTasks.push({ toolCall, query: q.trim() });
                  }
                }
              } else if (args.query && typeof args.query === 'string') {
                searchTasks.push({ toolCall, query: args.query });
              } else {
                console.warn('web_search tool call missing query:', args);
              }
            } catch {
              console.warn('Failed to parse web_search arguments');
            }
          }
        }

        if (searchTasks.length === 0) {
          break;
        }

        // Notify UI for all searches starting
        for (const task of searchTasks) {
          if (onWebSearch) {
            onWebSearch({ query: task.query, isSearching: true });
          }
        }

        // Execute all searches in parallel
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const searchResults = await Promise.allSettled(
          searchTasks.map(task => executeWebSearch(task.query, config, signal))
        );

        // Notify UI with all search results
        const resolvedResults: Array<{ task: typeof searchTasks[0]; result: WebSearchResult }> = [];
        for (let i = 0; i < searchTasks.length; i++) {
          const task = searchTasks[i];
          const outcome = searchResults[i];
          const result: WebSearchResult = outcome.status === 'fulfilled'
            ? outcome.value
            : { content: `Search failed: ${outcome.reason?.message || 'Unknown error'}`, sources: [] };

          resolvedResults.push({ task, result });

          if (onWebSearch) {
            onWebSearch({
              query: task.query,
              result: result.content,
              isSearching: false,
              sources: result.sources,
              startNewMessage: i === searchTasks.length - 1 // start new message on last result
            });
          }
        }

        // Build follow-up messages with ALL tool results
        const searchInstruction = `Based on the web search results above, provide an accurate and up-to-date answer. The search results contain current information - use this data to answer the user's question. Do not rely on your training data if it conflicts with the search results.`;

        // Group results by tool call (a single tool call with queries[] may have multiple results)
        const toolCallIds = new Set(currentToolCalls.map((tc: any) => tc.id));
        const assistantToolCalls: any[] = [];
        const toolMessages: any[] = [];

        for (const tc of currentToolCalls) {
          if (!toolCallIds.has(tc.id)) continue;

          assistantToolCalls.push({
            id: tc.id,
            type: 'function',
            function: {
              name: 'web_search',
              arguments: tc.function.arguments
            }
          });

          // Combine all results for this tool call
          const resultsForCall = resolvedResults
            .filter(r => r.task.toolCall.id === tc.id)
            .map(r => `[Query: ${r.task.query}]\n${r.result.content}`)
            .join('\n\n---\n\n');

          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `[WEB SEARCH RESULTS]\n${resultsForCall}\n\n[INSTRUCTION]\n${searchInstruction}`
          });
        }

        const followUpMessages: any[] = [
          ...currentMessages,
          {
            role: 'assistant',
            content: currentFullText || null,
            tool_calls: assistantToolCalls
          },
          ...toolMessages
        ];

        // Make follow-up call - INCLUDE TOOLS so AI can request more searches if needed
        const followUpRequestBody: any = {
          model: model,
          messages: followUpMessages,
          stream: true
        };

        // Include tools definition so AI can request more searches
        if (useNativeGoogleSearch) {
          followUpRequestBody.tools = [GOOGLE_SEARCH_TOOL];
        } else {
          followUpRequestBody.tools = [WEB_SEARCH_TOOL];
          followUpRequestBody.tool_choice = 'auto';
        }

        const followUpResponse = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(followUpRequestBody),
          signal
        });

        if (followUpResponse.ok) {
          // Reset for next iteration
          let followUpText = '';
          let followUpToolCalls: any[] = [];

          const followUpContentType = followUpResponse.headers.get('content-type') || '';
          if (followUpContentType.includes('application/json')) {
            const data = await followUpResponse.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content || choice?.text || '';
            if (content) {
              followUpText = content;
              fullText += content;
              onChunk(content);
            }
            // Check for more tool calls
            if (choice?.message?.tool_calls) {
              followUpToolCalls = choice.message.tool_calls;
            }
          } else {
            await readStream(followUpResponse, (text) => {
              followUpText += text;
              fullText += text;
              onChunk(text);
            }, (line) => {
              const trim = line.trim();
              if (!trim || !trim.startsWith('data: ')) return null;
              const dataStr = trim.slice(6);
              if (dataStr === '[DONE]') return null;
              try {
                const json = JSON.parse(dataStr);
                const choice = json.choices?.[0];

                // Check for tool calls in streaming response
                if (choice?.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    if (tc.index !== undefined) {
                      if (!followUpToolCalls[tc.index]) {
                        followUpToolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                      }
                      if (tc.id) followUpToolCalls[tc.index].id = tc.id;
                      if (tc.function?.name) followUpToolCalls[tc.index].function.name = tc.function.name;
                      if (tc.function?.arguments) followUpToolCalls[tc.index].function.arguments += tc.function.arguments;
                    }
                  }
                }

                return choice?.delta?.content || null;
              } catch {
                return null;
              }
            });
          }

          // Update state for next iteration
          currentMessages = followUpMessages;
          currentFullText = followUpText;
          currentToolCalls = followUpToolCalls.filter(tc => tc.function?.name === 'web_search');

          // If no more tool calls, we're done
          if (currentToolCalls.length === 0) {
            break;
          }
        } else {
          // Follow-up request failed, stop iteration
          currentToolCalls = [];
          break;
        }
      } catch (e) {
        console.error('Parallel tool calls failed:', e);
        if (onWebSearch) {
          onWebSearch({ query: '', result: 'Search failed', isSearching: false, sources: [] });
        }
        currentToolCalls = [];
        break;
      }

      // Only continue if there are more tool calls to process
      if (currentToolCalls.length === 0) {
        break;
      }
    }
  }

  return { text: fullText };
};

const streamAnthropic = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, _config?: AppConfig, _onReasoning?: (text: string) => void): Promise<ApiResponse> => {
  const url = `${baseUrl}/messages`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const systemMessage = sanitizedMessages.find(m => m.role === 'system');
  const chatMessages = sanitizedMessages.filter(m => m.role !== 'system').map(m => {
    if (m.image) {
      const [meta, data] = m.image.split(',');
      const mimeType = meta.split(':')[1].split(';')[0];
      return {
        role: m.role,
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data } },
          { type: "text", text: m.content }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const body: any = {
    model: model,
    max_tokens: 1024,
    messages: chatMessages,
    stream: true
  };

  if (systemMessage) {
    body.system = systemMessage.content;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  let fullText = '';
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await response.json();
    fullText = data.content?.[0]?.text || '';
    if (fullText) onChunk(fullText);
  } else {
    await readStream(response, (text) => {
      fullText += text;
      onChunk(text);
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      try {
        const json = JSON.parse(dataStr);
        if (json.type === 'content_block_delta' && json.delta?.text) {
          return json.delta.text;
        }
        return null;
      } catch {
        return null;
      }
    });
  }

  return { text: fullText };
};

// Streaming for Perplexity (OpenAI compatible SSE format)
const streamPerplexity = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, _onReasoning?: (text: string) => void): Promise<ApiResponse> => {
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: m.image } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: msgs,
      stream: true,
      web_search_options: {
        search_type: 'pro'
      }
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.text();
    try {
      const jsonErr = JSON.parse(err);
      throw new Error(jsonErr.error?.message || response.statusText);
    } catch {
      throw new Error(err || response.statusText);
    }
  }

  let fullText = '';
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await response.json();
    fullText = data.choices?.[0]?.message?.content || '';
    if (fullText) onChunk(fullText);
  } else {
    await readStream(response, (text) => {
      fullText += text;
      onChunk(text);
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      if (dataStr === '[DONE]') return null;

      try {
        const json = JSON.parse(dataStr);
        const content = json.choices?.[0]?.delta?.content;
        return content || null;
      } catch (e) {
        return null;
      }
    });
  }

  return { text: fullText };
};

const streamGoogle = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, config?: AppConfig, onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void, _onReasoning?: (text: string) => void, onImage?: (imageUrl: string) => void): Promise<ApiResponse> => {
  // API: POST https://.../streamGenerateContent?key=...
  const url = `${baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const contents = sanitizedMessages.map(m => {
    const parts: any[] = [{ text: m.content }];
    if (m.image) {
      const imagePart = parseImageForGemini(m.image);
      if (imagePart) {
        parts.push(imagePart);
      }
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });

  // Check if we should enable Google Grounding Search for Gemini models
  // Native support for models like gemini-2.0-flash-exp, gemini-1.5-pro, etc.
  const isGeminiModel = /^gemini-\d+/.test(model);
  const useGoogleSearch = config &&
    config.webSearchProvider === 'google' &&
    config.enableWebSearch !== false &&
    isGeminiModel &&
    config.apiKeys['google']?.length > 0;

  const requestBody: any = { contents };

  // Add google_search tool for native grounding
  if (useGoogleSearch) {
    requestBody.tools = [GOOGLE_SEARCH_TOOL];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || response.statusText);
  }

  let fullText = '';
  let groundingSources: Array<{ title: string; url: string; snippet?: string }> = [];

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (fullText) onChunk(fullText);

    // Extract grounding metadata if available
    if (useGoogleSearch) {
      const groundingMetadata = data.candidates?.[0]?.groundingMetadata;
      if (groundingMetadata?.groundingChunks) {
        groundingMetadata.groundingChunks.forEach((chunk: any) => {
          if (chunk.web) {
            groundingSources.push({
              title: chunk.web.title || 'Source',
              url: chunk.web.uri || '',
              snippet: chunk.web.snippet
            });
          }
        });
      }

      // Notify about grounding sources if we have onWebSearch callback
      if (onWebSearch && groundingSources.length > 0) {
        onWebSearch({
          query: messages[messages.length - 1]?.content || '',
          result: fullText,
          isSearching: false,
          sources: groundingSources
        });
      }
    }

    return { text: fullText };
  }

  // Google returns a JSON array: [ {...}, {...} ] but streamed.
  // It's not SSE. It's just a broken up JSON array.
  // However, usually each chunk (candidate) is a valid JSON object surrounded by commas/brackets.
  // Simple parser: accumulate text, look for "text": "..."
  // Or simpler: The chunks are actually usually well-behaved valid JSON if we strip the outer array structure or handle it.
  // Actually, `response.body` will deliver bytes.
  // Let's use a simpler heuristic for Google since proper JSON stream parsing is complex.
  // We can regex for `"text": "..."` in the full buffer or chunks? No, that's unsafe.

  // Better approach: Google's stream sends distinct JSON objects corresponding to `GenerateContentResponse`,
  // possibly separated by commas and enclosed in brackets.
  // Format:
  // [
  // { ... },
  // { ... }
  // ]

  // We can accumulate buffer, find matching braces { }, parse, and move forward.

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  if (!reader) throw new Error('No body');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let braceCount = 0;
    let start = -1;
    let consumedUpTo = 0;

    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char === '{') {
        if (braceCount === 0) start = i;
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && start !== -1) {
          // Process object
          const jsonStr = buffer.substring(start, i + 1);
          try {
            const json = JSON.parse(jsonStr);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              fullText += text;
              onChunk(text);
            }

            // Extract images from parts if present
            if (onImage) {
              const parts = json.candidates?.[0]?.content?.parts;
              if (parts && Array.isArray(parts)) {
                for (const part of parts) {
                  if (part.inlineData && part.inlineData.mimeType && part.inlineData.data) {
                    // Convert base64 image to data URL
                    const imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                    onImage(imageUrl);
                  }
                }
              }
            }

            // Extract grounding metadata from streaming response
            if (useGoogleSearch) {
              const groundingMetadata = json.candidates?.[0]?.groundingMetadata;
              if (groundingMetadata?.groundingChunks) {
                groundingMetadata.groundingChunks.forEach((chunk: any) => {
                  if (chunk.web) {
                    // Check if we already have this source to avoid duplicates
                    const exists = groundingSources.some(s => s.url === chunk.web.uri);
                    if (!exists) {
                      groundingSources.push({
                        title: chunk.web.title || 'Source',
                        url: chunk.web.uri || '',
                        snippet: chunk.web.snippet
                      });
                    }
                  }
                });
              }
            }
          } catch (e) {
            // ignore malformed
          }
          start = -1;
          consumedUpTo = i + 1;
        }
      }
    }

    // Remove processed parts
    if (consumedUpTo > 0) {
      buffer = buffer.substring(consumedUpTo);
    }
  }

  // Notify about grounding sources at the end of streaming
  if (useGoogleSearch && onWebSearch && groundingSources.length > 0) {
    onWebSearch({
      query: messages[messages.length - 1]?.content || '',
      result: fullText,
      isSearching: false,
      sources: groundingSources
    });
  }

  return { text: fullText };
};