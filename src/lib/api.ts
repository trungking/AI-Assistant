import type { AppConfig, ChatMessage } from './types';

interface ApiResponse {
  text: string;
  error?: string;
}

// Web Search Tool Definition (OpenAI format)
const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use this when you need up-to-date information, recent news, current events, or facts you are unsure about.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up on the web'
        }
      },
      required: ['query']
    }
  }
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
    // Perplexity can return citations in different places
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];

    // Try root level citations
    const citations = data.citations || data.search_results || [];

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

  // Default to Perplexity
  return executePerplexityWebSearch(query, config, signal);
};

// Check if web search should be enabled for this request
const shouldEnableWebSearch = (config: AppConfig): boolean => {
  // Web search is enabled if:
  // 1. User has enableWebSearch turned on (or undefined, default to true)
  // 2. Either Perplexity API key or Kagi session is configured (depending on selected provider)
  // 3. Current provider is NOT perplexity (no need for tool when using perplexity directly)
  const webSearchProvider = config.webSearchProvider || 'perplexity';
  const hasPerplexityKey = config.apiKeys['perplexity']?.length > 0;
  const hasKagiSession = !!config.kagiSession;
  const hasWebSearchCredentials = webSearchProvider === 'kagi' ? hasKagiSession : hasPerplexityKey;
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
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void
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
        result = await streamGoogle(apiKey, baseUrl, model, messages, onChunk, signal);
        break;
      case 'openai':
      case 'openrouter':
        result = await streamOpenAI(apiKey, baseUrl, model, messages, onChunk, provider === 'openrouter', signal, config, onWebSearch);
        break;
      case 'anthropic':
        result = await streamAnthropic(apiKey, baseUrl, model, messages, onChunk, signal, config);
        break;
      case 'perplexity':
        result = await streamPerplexity(apiKey, baseUrl, model, messages, onChunk, signal);
        break;
      default:
        result = await streamOpenAI(apiKey, baseUrl, model, messages, onChunk, false, signal, config, onWebSearch);
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
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void
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
          } else if (msg.webSearch && onWebSearch) {
            // Handle web search status from background
            onWebSearch(msg.webSearch);
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
    // Extension Context -> Direct Call
    if (onChunk) {
      return executeApiStream(messages, config, onChunk, signal, onWebSearch);
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
      // extract base64
      const [meta, data] = m.image.split(',');
      const mimeType = meta.split(':')[1].split(';')[0];
      parts.push({ inlineData: { mimeType, data } });
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

  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => {
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
    return m;
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

const streamOpenAI = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, isOpenRouter = false, signal?: AbortSignal, config?: AppConfig, onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void): Promise<ApiResponse> => {
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

  const dateContext = `IMPORTANT: Today's date is ${currentDateTime}. The web search tool retrieves real-time information. When searching for current status (e.g. "price now", "latest news"), do NOT unnecessarily append the current month/year to the query, as this may limit results. Trust the search tool to provide the latest data. Only specify dates if searching for historical information or specific future projections. If you decide to use the web search tool, you should briefly explain what you are going to search for before calling the tool.`;

  // Prepend system message with current time if not already present
  const msgsWithTime = msgs[0]?.role === 'system'
    ? [{ ...msgs[0], content: `${dateContext}\n\n${msgs[0].content}` }, ...msgs.slice(1)]
    : [{ role: 'system', content: `${dateContext}\n\nYou are a helpful assistant.` }, ...msgs];

  const requestBody: any = {
    model: model,
    messages: msgsWithTime,
    stream: true
  };

  // Add web search tool if enabled
  const webSearchEnabled = config && shouldEnableWebSearch(config);
  if (webSearchEnabled) {
    requestBody.tools = [WEB_SEARCH_TOOL];
    requestBody.tool_choice = 'auto';
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

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const choice = data.choices?.[0];
    fullText = choice?.message?.content || choice?.text || '';
    if (fullText) onChunk(fullText);

    if (choice?.message?.tool_calls) {
      toolCalls = choice.message.tool_calls;
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

        const content = choice?.delta?.content;
        return content || null;
      } catch (e) {
        return null;
      }
    });
  }

  // Handle tool calls if any
  if (toolCalls.length > 0 && config && webSearchEnabled) {
    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'web_search') {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          const query = args.query;

          // Notify UI that search is starting
          if (onWebSearch) {
            onWebSearch({ query, isSearching: true });
          }

          // Execute web search
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const searchResult = await executeWebSearch(query, config, signal);


          // Notify UI with search results and sources
          if (onWebSearch) {
            onWebSearch({
              query,
              result: searchResult.content,
              isSearching: false,
              sources: searchResult.sources
            });
          }

          // Build follow-up messages with tool result
          // Add explicit instruction to use the search results
          const searchInstruction = `Based on the web search results above, provide an accurate and up-to-date answer. The search results contain current information - use this data to answer the user's question. Do not rely on your training data if it conflicts with the search results.`;

          const followUpMessages: any[] = [
            ...msgsWithTime,
            {
              role: 'assistant',
              content: fullText || null, // Preserve original thought
              tool_calls: [{
                id: toolCall.id,
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: toolCall.function.arguments
                }
              }]
            },
            {
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `[WEB SEARCH RESULTS]\n${searchResult.content}\n\n[INSTRUCTION]\n${searchInstruction}`
            }
          ];

          // Make follow-up call to get final response
          const followUpResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: model,
              messages: followUpMessages,
              stream: true
            }),
            signal
          });

          if (followUpResponse.ok) {
            // Signal that a new message should be created for the follow-up response
            if (onWebSearch) {
              onWebSearch({
                query,
                result: searchResult.content,
                isSearching: false,
                sources: searchResult.sources,
                startNewMessage: true
              });
            }

            // Track the follow-up text separately
            let followUpText = '';
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
                  return json.choices?.[0]?.delta?.content || null;
                } catch {
                  return null;
                }
              });
            }
          }
        } catch (e) {
          console.error('Tool call failed:', e);
          if (onWebSearch) {
            onWebSearch({ query: '', result: 'Search failed', isSearching: false, sources: [] });
          }
        }
      }
    }
  }

  return { text: fullText };
};

const streamAnthropic = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, _config?: AppConfig): Promise<ApiResponse> => {
  const url = `${baseUrl}/messages`;

  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => {
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
    return m;
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
const streamPerplexity = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal): Promise<ApiResponse> => {
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

const streamGoogle = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal): Promise<ApiResponse> => {
  // API: POST https://.../streamGenerateContent?key=...
  const url = `${baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}`;

  const contents = messages.map(m => {
    const parts: any[] = [{ text: m.content }];
    if (m.image) {
      const [meta, data] = m.image.split(',');
      const mimeType = meta.split(':')[1].split(';')[0];
      parts.push({ inlineData: { mimeType, data } });
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
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
    fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (fullText) onChunk(fullText);
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

  return { text: fullText };
};