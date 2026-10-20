import { DEFAULT_CONFIG, type AppConfig, type ChatMessage } from './types';
import { callChromeNano, CHROME_PROVIDER } from './chromeNano';

interface ApiResponse {
  text: string;
  error?: string;
  images?: string[];
}

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Extract a readable message from an error response. Bodies may be JSON in
// several shapes (OpenAI/Anthropic/Gemini/Brave) or HTML from a proxy.
const readErrorMessage = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => '');
  let message = '';
  try {
    let json = JSON.parse(body);
    if (Array.isArray(json)) json = json[0];
    const err = json?.error ?? json;
    message = typeof err === 'string'
      ? err
      : err?.message || err?.detail || json?.message || json?.detail || '';
  } catch { /* not JSON */ }
  return message || body.trim().slice(0, 500) || response.statusText || `HTTP ${response.status}`;
};

const throwApiError = async (response: Response): Promise<never> => {
  throw new ApiError(await readErrorMessage(response), response.status);
};

type ThinkingTag = {
  open: string;
  close: string;
};

const THINKING_TAGS: ThinkingTag[] = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' }
];

const findFirstToken = (text: string, tokens: string[]): { index: number; token: string } | null => {
  const lowerText = text.toLowerCase();
  let first: { index: number; token: string } | null = null;

  for (const token of tokens) {
    const index = lowerText.indexOf(token);
    if (index >= 0 && (!first || index < first.index)) {
      first = { index, token };
    }
  }

  return first;
};

const getPartialTokenSuffixLength = (text: string, tokens: string[]): number => {
  const lowerText = text.toLowerCase();
  let length = 0;

  for (const token of tokens) {
    const maxLength = Math.min(lowerText.length, token.length - 1);
    for (let i = 1; i <= maxLength; i++) {
      if (lowerText.endsWith(token.slice(0, i))) {
        length = Math.max(length, i);
      }
    }
  }

  return length;
};

export const splitThinkingTags = (text: string): { content: string; reasoning: string } => {
  let content = '';
  let reasoning = '';
  const parser = createThinkingTagExtractor(
    (chunk) => { content += chunk; },
    (chunk) => { reasoning += chunk; }
  );

  parser.write(text);
  parser.flush();

  return { content, reasoning };
};

const stripThinkingTags = (text: string): string => splitThinkingTags(text).content;

const createThinkingTagExtractor = (
  onContent: (text: string) => void,
  onReasoning?: (text: string) => void
) => {
  const openTags = THINKING_TAGS.map(tag => tag.open);
  let buffer = '';
  let activeTag: ThinkingTag | null = null;
  // Thinking blocks only appear before the answer. Once real content has been
  // emitted, a literal "<think>" (e.g. in an explanation of XML) is just text.
  let contentStarted = false;

  const emitContent = (text: string) => {
    if (!text) return;
    if (text.trim()) contentStarted = true;
    onContent(text);
  };

  const emitReasoning = (text: string) => {
    if (text && onReasoning) onReasoning(text);
  };

  const processBuffer = (isFinal = false) => {
    while (buffer) {
      if (!activeTag) {
        if (contentStarted) {
          emitContent(buffer);
          buffer = '';
          break;
        }

        const nextOpen = findFirstToken(buffer, openTags);
        if (nextOpen && buffer.slice(0, nextOpen.index).trim()) {
          // Text precedes the tag, so this is part of the answer
          emitContent(buffer);
          buffer = '';
          break;
        }
        if (!nextOpen) {
          const keepLength = isFinal ? 0 : getPartialTokenSuffixLength(buffer, openTags);
          const emitLength = buffer.length - keepLength;
          if (emitLength > 0) {
            emitContent(buffer.slice(0, emitLength));
            buffer = buffer.slice(emitLength);
            continue;
          }
          break;
        }

        const tag = THINKING_TAGS.find(candidate => candidate.open === nextOpen.token);
        if (!tag) break;

        emitContent(buffer.slice(0, nextOpen.index));
        buffer = buffer.slice(nextOpen.index + nextOpen.token.length);
        activeTag = tag;
        continue;
      }

      const closeTags = [activeTag.close];
      const nextClose = findFirstToken(buffer, closeTags);
      if (!nextClose) {
        const keepLength = isFinal ? 0 : getPartialTokenSuffixLength(buffer, closeTags);
        const emitLength = buffer.length - keepLength;
        if (emitLength > 0) {
          emitReasoning(buffer.slice(0, emitLength));
          buffer = buffer.slice(emitLength);
          continue;
        }
        break;
      }

      emitReasoning(buffer.slice(0, nextClose.index));
      buffer = buffer.slice(nextClose.index + nextClose.token.length);
      activeTag = null;
    }
  };

  return {
    write(text: string) {
      if (!text) return;
      buffer += text;
      processBuffer();
    },
    flush() {
      processBuffer(true);
      if (buffer) {
        if (activeTag) {
          emitReasoning(buffer);
        } else {
          emitContent(buffer);
        }
        buffer = '';
      }
    }
  };
};

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

// Merge streamed tool-call deltas into calls. Some OpenAI-compatible servers
// omit `index`; treat those as continuing the last call (or starting the first).
const accumulateToolCallDeltas = (toolCalls: any[], deltas: any[]) => {
  for (const tc of deltas) {
    let index: number = typeof tc.index === 'number' ? tc.index : -1;
    if (index < 0) {
      const last = toolCalls[toolCalls.length - 1];
      index = tc.id && last?.id && last.id !== tc.id
        ? toolCalls.length
        : Math.max(toolCalls.length - 1, 0);
    }
    if (!toolCalls[index]) {
      toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    }
    if (tc.id) toolCalls[index].id = tc.id;
    if (tc.function?.name) toolCalls[index].function.name = tc.function.name;
    if (tc.function?.arguments) toolCalls[index].function.arguments += tc.function.arguments;
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

// Grok Native Search Tool Definitions
const GROK_SEARCH_TOOLS = [
  { type: 'web_search' as const },
  { type: 'x_search' as const }
];

// Text part to send next to an image. Image-only messages have empty text,
// which Anthropic and others reject as an empty content block.
const imageMessageTextPart = (text: string) => text.trim() ? [{ type: 'text' as const, text }] : [];

const ANTHROPIC_MAX_TOKENS = 8192;

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

/**
 * Merge consecutive messages with the same role. Some APIs (Perplexity) require
 * strictly alternating user/assistant turns, which breaks once an empty or
 * failed assistant reply has been filtered out.
 */
const mergeConsecutiveRoles = <T extends { role: string; content: string; image?: string }>(messages: T[]): T[] => {
  const merged: T[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') {
      merged[merged.length - 1] = {
        ...prev,
        content: [prev.content, m.content].filter(Boolean).join('\n\n'),
        image: m.image || prev.image
      };
    } else {
      merged.push(m);
    }
  }
  return merged;
};

const formatDate = (date: Date = new Date()): string => {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
};

const getSystemPrompt = (config: AppConfig): string => {
  const prompt = config.systemPrompt?.trim() || 'You are a helpful assistant.';
  return prompt.replace(/\${date}/g, formatDate());
};

const injectSystemPrompt = (messages: ChatMessage[], config: AppConfig): ChatMessage[] => {
  if (messages.some(m => m.role === 'system')) {
    return messages;
  }
  return [{ role: 'system', content: getSystemPrompt(config) }, ...messages];
};

const shouldUseImageGenerationsEndpoint = (model: string): boolean => {
  const normalizedModel = model.toLowerCase();
  return normalizedModel.includes('image') && !normalizedModel.includes('gemini');
};

const buildImageGenerationPrompt = (messages: ChatMessage[]): string => {
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user' && m.content.trim());
  return lastUserMessage?.content.trim() || '';
};

const extractGeneratedImages = (data: any): string[] => {
  if (!Array.isArray(data?.data)) return [];

  return data.data
    .map((item: any) => {
      if (item?.url) return item.url;
      if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
      return null;
    })
    .filter((url: string | null): url is string => Boolean(url));
};

const callOpenAIImageGeneration = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<ApiResponse> => {
  const prompt = buildImageGenerationPrompt(messages);
  if (!prompt) {
    throw new Error('Image generation prompt is empty.');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1
    }),
    signal
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = await response.json();
  const images = extractGeneratedImages(data);
  const text = data.data
    ?.map((item: any) => item?.revised_prompt)
    .filter(Boolean)
    .join('\n\n') || '';

  return { text, images };
};

// Execute web search using Perplexity or Kagi
interface WebSearchResult {
  content: string;
  sources: Array<{ title: string; url: string; snippet?: string }>;
}

const KAGI_HEADER_RULE_ID = 9001;

// `cookie` and `origin` are forbidden fetch headers, so the browser drops them
// silently. Attach them with a session rule scoped to the extension's own
// (non-tab) requests instead.
const setKagiSessionHeaders = async (kagiSession: string) => {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [KAGI_HEADER_RULE_ID],
    addRules: [{
      id: KAGI_HEADER_RULE_ID,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          { header: 'cookie', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: `kagi_session=${kagiSession}` },
          { header: 'origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagi.com' }
        ]
      },
      condition: {
        urlFilter: '||kagi.com/mother/context',
        tabIds: [-1], // chrome.tabs.TAB_ID_NONE: requests not tied to a tab
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]
      }
    }]
  });
};

// Execute web search using Kagi
const executeKagiWebSearch = async (query: string, kagiSession: string, signal?: AbortSignal): Promise<WebSearchResult> => {
  try {
    // URL encode the query
    const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');

    await setKagiSessionHeaders(kagiSession).catch(e => console.warn('Failed to set Kagi session headers:', e));

    const response = await fetch(`https://kagi.com/mother/context?q=${encodedQuery}`, {
      method: 'POST',
      headers: {
        'accept': 'application/vnd.kagi.stream',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache'
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
      return { content: `Search error: ${await readErrorMessage(response)}`, sources: [] };
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
    baseUrl = config.customBaseUrls[currentProvider] || getDefaultBaseUrl(currentProvider);
    if (!baseUrl) {
      return { content: `Error: No base URL configured for ${currentProvider}.`, sources: [] };
    }
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
      return { content: `Google search error: ${await readErrorMessage(response)}`, sources: [] };
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

// Brave API key round-robin state (persisted so rotation survives restarts)
const BRAVE_RR_STORAGE_KEY = 'braveKeyIndex';

const nextBraveKey = async (allKeys: string[]): Promise<string> => {
  // Skip keys marked exhausted, unless every key is (quotas may have reset)
  const available = await getAvailableKeys(allKeys, 'brave');
  const keys = available.length > 0 ? available : allKeys;
  if (keys.length === 1) return keys[0];
  try {
    const result = await chrome.storage.local.get(BRAVE_RR_STORAGE_KEY) as Record<string, number>;
    const prev = typeof result[BRAVE_RR_STORAGE_KEY] === 'number' ? result[BRAVE_RR_STORAGE_KEY] : -1;
    const next = (prev + 1) % keys.length;
    await chrome.storage.local.set({ [BRAVE_RR_STORAGE_KEY]: next });
    return keys[next];
  } catch {
    // Fallback to in-memory rotation if storage is unavailable
    return keys[Math.floor(Math.random() * keys.length)];
  }
};

// Strip HTML tags from Brave result descriptions
const stripHtml = (html: string): string => html
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&nbsp;/g, ' ');

// Execute web search using Brave Search API (round-robin across multiple keys)
const executeBraveWebSearch = async (query: string, config: AppConfig, signal?: AbortSignal): Promise<WebSearchResult> => {
  const keys = (config.braveApiKeys || []).map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    return { content: 'Error: No Brave Search API key configured for web search.', sources: [] };
  }

  const apiKey = await nextBraveKey(keys);
  const baseUrl = config.customBaseUrls['brave'] || 'https://api.search.brave.com/res/v1';

  try {
    const params = new URLSearchParams({
      q: query,
      count: '10',
      text_decorations: 'false'
    });

    const response = await fetch(`${baseUrl}/web/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey
      },
      signal
    });

    if (!response.ok) {
      const errText = await readErrorMessage(response);
      // Rotate away from an exhausted/rate-limited key
      const expiresAt = getKeyExhaustionExpiry(errText, response.status);
      if (expiresAt) {
        await markKeyExhausted(apiKey, 'brave', expiresAt);
      }
      return { content: `Brave search error: ${errText}`, sources: [] };
    }

    const data = await response.json();

    const results: any[] = data.web?.results || [];
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];
    const lines: string[] = [];

    results.forEach((item: any, index: number) => {
      const title = stripHtml(item.title || `Result ${index + 1}`);
      const url = item.url || '';
      const snippet = stripHtml(item.description || item.extra_snippets?.[0] || '');
      sources.push({ title, url, snippet });
      lines.push(`[${index + 1}] ${title}\n${url}${snippet ? `\n${snippet}` : ''}`);
    });

    if (lines.length === 0) {
      return { content: 'No search results found.', sources: [] };
    }

    return {
      content: `Web search results for "${query}":\n\n${lines.join('\n\n')}`,
      sources
    };
  } catch (e: any) {
    return { content: `Brave search failed: ${e.message}`, sources: [] };
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

  if (provider === 'brave') {
    return executeBraveWebSearch(query, config, signal);
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
  const hasBraveKey = (config.braveApiKeys || []).filter(k => k.trim()).length > 0;

  // Check if current provider has API key
  const currentProvider = config.selectedProvider;
  const hasCurrentProviderKey = config.apiKeys[currentProvider]?.length > 0;

  // Check if using a Gemini model with Google grounding search
  const isGeminiModel = model ? /^gemini-/.test(model) : false;
  const usingGoogleGroundingNatively = webSearchProvider === 'google' && isGeminiModel;

  // Check if using an OpenAI/GPT model with native web search (web_search_options)
  // Works with both the built-in OpenAI provider and custom OpenAI-compatible providers
  const isGPTModel = model ? /^(gpt-|o\d|chatgpt-)/.test(model) : false;
  const isGrokModel = model ? model.toLowerCase().includes('grok') : false;
  const isCustomProvider = config.customProviders?.some(cp => cp.id === currentProvider);
  const usingOpenAINatively = isGPTModel && (currentProvider === 'openai' || !!isCustomProvider);
  const usingGrokNatively = isGrokModel;

  let hasWebSearchCredentials = false;
  if (usingOpenAINatively || usingGrokNatively) {
    // Native search uses the selected model provider's API key.
    hasWebSearchCredentials = true;
  } else if (webSearchProvider === 'kagi') {
    hasWebSearchCredentials = hasKagiSession;
  } else if (webSearchProvider === 'google') {
    hasWebSearchCredentials = usingGoogleGroundingNatively || hasGoogleKey || hasCurrentProviderKey;
  } else if (webSearchProvider === 'brave') {
    // Gemini models always use native google_search grounding (brave never overrides it);
    // brave keys only gate the function-tool path for non-Gemini models.
    hasWebSearchCredentials = isGeminiModel
      ? (hasGoogleKey || hasCurrentProviderKey)
      : hasBraveKey;
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

// Mark a key as exhausted until expiresAt
const markKeyExhausted = async (key: string, provider: string, expiresAt: number): Promise<void> => {
  try {
    const entries = (await getExhaustedKeys())
      .filter(e => !(e.key === key && e.provider === provider));
    entries.push({
      key,
      provider,
      exhaustedAt: Date.now(),
      expiresAt
    });
    await chrome.storage.local.set({ [EXHAUSTED_KEYS_STORAGE_KEY]: entries });
    console.log(`API key marked as exhausted for ${provider} until ${new Date(expiresAt).toLocaleString()}`);
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

// Short cooldown for rate limits, which usually clear within minutes
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

// Decide whether an error means the key should be rested, and until when.
// Returns null for errors unrelated to the key (e.g. context_length_exceeded).
const getKeyExhaustionExpiry = (error: string, status?: number): number | null => {
  const lowerError = error.toLowerCase();

  // Account out of credits: won't recover until the billing period resets
  if (status === 402 || /insufficient_quota|credit balance|out of credits|payment required/.test(lowerError)) {
    return getNextMonthReset();
  }

  if (status === 429 || /rate[ _-]?limit|too many requests|resource_exhausted|resource has been exhausted|\bquota\b/.test(lowerError)) {
    return Date.now() + RATE_LIMIT_COOLDOWN_MS;
  }

  if (/\bbilling\b/.test(lowerError)) {
    return getNextMonthReset();
  }

  return null;
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

// --- Timeout & retry ---

const DEFAULT_REQUEST_TIMEOUT_SECONDS = DEFAULT_CONFIG.requestTimeoutSeconds ?? 30;
const DEFAULT_MAX_RETRIES = DEFAULT_CONFIG.maxRetries ?? 2;
const MAX_RETRIES_LIMIT = 5;
const RETRY_BASE_DELAY_MS = 1000;

const getRequestTimeoutMs = (config: AppConfig): number => {
  const seconds = Number(config.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
};

const getMaxRetries = (config: AppConfig): number => {
  const retries = Math.floor(Number(config.maxRetries ?? DEFAULT_MAX_RETRIES));
  return Number.isFinite(retries) ? Math.min(Math.max(retries, 0), MAX_RETRIES_LIMIT) : DEFAULT_MAX_RETRIES;
};

// readStream reports received bytes here so the idle timeout only fires when
// the server has gone quiet, not while a long answer is still streaming.
const streamActivityListeners = new WeakMap<AbortSignal, () => void>();

const reportStreamActivity = (signal?: AbortSignal) => {
  if (signal) streamActivityListeners.get(signal)?.();
};

// Transient failures worth another attempt: network errors, timeouts, 408/425/429/5xx,
// mid-stream error events and streams that were cut off.
const isRetryableError = (e: any): boolean => {
  if (e instanceof ApiError) {
    return e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  }
  return true;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('Aborted', 'AbortError'));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Sent to the UI before each retry so it can show what's happening. */
export type RetryStatus = {
  attempt: number; // 1-based retry number
  maxRetries: number;
  error: string; // why the previous attempt failed
};

type AttemptContext = {
  apiKey: string;
  signal: AbortSignal;
  // Marks activity so the idle timeout restarts
  touch: () => void;
};

type AttemptOutcome = {
  result: ApiResponse;
  retryable: boolean;
};

/**
 * Run `attempt` with a fresh key, an idle timeout and up to `maxRetries` retries.
 * `canRetry` lets streaming callers refuse a retry once output reached the UI,
 * since a second attempt would duplicate it.
 */
const runWithRetry = async (
  config: AppConfig,
  signal: AbortSignal | undefined,
  attempt: (ctx: AttemptContext) => Promise<ApiResponse>,
  canRetry: () => boolean = () => true,
  onRetry?: (status: RetryStatus) => void
): Promise<ApiResponse> => {
  const provider = config.selectedProvider;
  const apiKeys = config.apiKeys[provider];

  if (!apiKeys || apiKeys.length === 0) {
    return { text: '', error: `No API key found for ${provider}` };
  }

  const timeoutMs = getRequestTimeoutMs(config);
  const maxRetries = getMaxRetries(config);

  const runOnce = async (): Promise<AttemptOutcome> => {
    // Select a random available API key (avoiding exhausted ones). Re-selected on
    // every attempt so a rate-limited key is skipped on retry.
    const keySelection = await selectRandomKey(apiKeys, provider);
    if (!keySelection) {
      return { result: { text: '', error: `No available API keys for ${provider}. All keys may have exhausted quota.` }, retryable: false };
    }
    const apiKey = keySelection.key;

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (!timeoutMs) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    streamActivityListeners.set(controller.signal, touch);
    touch();

    // A key marked exhausted means another key may succeed
    const markIfExhausted = async (message: string, status?: number): Promise<boolean> => {
      const expiry = getKeyExhaustionExpiry(message, status);
      if (!expiry) return false;
      await markKeyExhausted(apiKey, provider, expiry);
      return keySelection.available.length > 1;
    };

    try {
      const result = await attempt({ apiKey, signal: controller.signal, touch });
      if (!result.error) {
        return { result, retryable: false };
      }
      const switchedKey = await markIfExhausted(result.error);
      return { result, retryable: result.error === STREAM_INTERRUPTED_ERROR || switchedKey };
    } catch (e: any) {
      if (signal?.aborted) throw e;
      if (timedOut) {
        return {
          result: { text: '', error: `No response from the server for ${timeoutMs / 1000}s.` },
          retryable: true
        };
      }
      if (e?.name === 'AbortError') throw e;
      const errorMsg = e?.message || 'Request failed';
      const switchedKey = await markIfExhausted(errorMsg, e instanceof ApiError ? e.status : undefined);
      return { result: { text: '', error: errorMsg }, retryable: switchedKey || isRetryableError(e) };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  };

  let outcome = await runOnce();
  for (let retry = 1; retry <= maxRetries && outcome.retryable && canRetry(); retry++) {
    const error = outcome.result.error || 'Request failed';
    console.warn(`[AI Assistant] Request failed (${error}), retrying ${retry}/${maxRetries}`);
    onRetry?.({ attempt: retry, maxRetries, error });
    await sleep(RETRY_BASE_DELAY_MS * retry, signal);
    outcome = await runOnce();
  }

  if (outcome.result.error && outcome.retryable && maxRetries > 0 && canRetry()) {
    return { ...outcome.result, error: `${outcome.result.error} (after ${maxRetries + 1} attempts)` };
  }
  return outcome.result;
};

export const executeApiCall = async (
  messages: ChatMessage[],
  config: AppConfig
): Promise<ApiResponse> => {
  const provider = config.selectedProvider;
  const baseUrl = config.customBaseUrls[provider] || getDefaultBaseUrl(provider);
  const model = config.selectedModel[provider];
  const messagesWithSystem = injectSystemPrompt(messages, config);

  return runWithRetry(config, undefined, ({ apiKey, signal }) => {
    switch (provider) {
      case 'google':
        return callGoogle(apiKey, baseUrl, model, messagesWithSystem, signal);
      case 'openai':
        return callOpenAI(apiKey, baseUrl, model, messagesWithSystem, signal);
      case 'anthropic':
        return callAnthropic(apiKey, baseUrl, model, messagesWithSystem, signal);
      case 'openrouter':
        return callOpenRouter(apiKey, baseUrl, model, messagesWithSystem, signal);
      case 'perplexity':
        return callPerplexity(apiKey, baseUrl, model, messagesWithSystem, signal);
      default:
        return callOpenAI(apiKey, baseUrl, model, messagesWithSystem, signal);
    }
  });
};

export const executeApiStream = async (
  messages: ChatMessage[],
  config: AppConfig,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void,
  onReasoning?: (text: string) => void,
  onImage?: (imageUrl: string) => void,
  onRetry?: (status: RetryStatus) => void
): Promise<ApiResponse> => {
  const provider = config.selectedProvider;
  const baseUrl = config.customBaseUrls[provider] || getDefaultBaseUrl(provider);
  const model = config.selectedModel[provider];
  const messagesWithSystem = injectSystemPrompt(messages, config);

  // Once anything reached the UI a retry would duplicate it, so only retry before that
  let emitted = false;

  return runWithRetry(config, signal, ({ apiKey, signal: attemptSignal, touch }) => {
    const chunk = (text: string) => { emitted = true; touch(); onChunk(text); };
    const webSearch = onWebSearch && ((status: Parameters<typeof onWebSearch>[0]) => { emitted = true; touch(); onWebSearch(status); });
    const reasoning = onReasoning && ((text: string) => { emitted = true; touch(); onReasoning(text); });
    const image = onImage && ((url: string) => { emitted = true; touch(); onImage(url); });

    switch (provider) {
      case 'google':
        return streamGoogle(apiKey, baseUrl, model, messagesWithSystem, chunk, attemptSignal, config, webSearch, reasoning, image);
      case 'openai':
      case 'openrouter':
        return streamOpenAI(apiKey, baseUrl, model, messagesWithSystem, chunk, provider === 'openrouter', attemptSignal, config, webSearch, reasoning, image);
      case 'anthropic':
        return streamAnthropic(apiKey, baseUrl, model, messagesWithSystem, chunk, attemptSignal, config, reasoning);
      case 'perplexity':
        return streamPerplexity(apiKey, baseUrl, model, messagesWithSystem, chunk, attemptSignal, reasoning);
      default:
        return streamOpenAI(apiKey, baseUrl, model, messagesWithSystem, chunk, false, attemptSignal, config, webSearch, reasoning, image);
    }
  }, () => !emitted, onRetry);
};

export const callApi = async (
  messages: ChatMessage[],
  config: AppConfig,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void,
  onReasoning?: (text: string) => void,
  onImage?: (imageUrl: string) => void,
  onRetry?: (status: RetryStatus) => void
): Promise<ApiResponse> => {
  if (config.selectedProvider === CHROME_PROVIDER) {
    return callChromeNano(injectSystemPrompt(messages, config), onChunk, signal);
  }

  // Both content scripts and extension pages stream through the background so
  // the request can continue when the popup closes.
  if (onChunk) {
    return streamViaBackground(messages, config, onChunk, signal, onWebSearch, onReasoning, onImage, onRetry);
  }

  if (window.location.protocol.startsWith('http')) {
    // Content Script -> Proxy to Background
    return chrome.runtime.sendMessage({
      type: 'PROXY_API_CALL',
      data: { messages, config }
    });
  }
  return executeApiCall(messages, config);
};

const streamViaBackground = (
  messages: ChatMessage[],
  config: AppConfig,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void,
  onReasoning?: (text: string) => void,
  onImage?: (imageUrl: string) => void,
  onRetry?: (status: RetryStatus) => void
): Promise<ApiResponse> => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const port = chrome.runtime.connect({ name: 'stream_api' });
    let fullText = '';
    // Generated here so Stop can target this stream even before the background
    // has started it
    const streamId = crypto.randomUUID();
    let settled = false;

    const settle = (result: ApiResponse | DOMException) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try { port.disconnect(); } catch { /* already disconnected */ }
      if (result instanceof DOMException) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    const onAbort = () => {
      // Tell background to stop this specific stream (disconnecting alone keeps it running)
      chrome.runtime.sendMessage({ action: 'abort_stream', streamId }).catch(() => { });
      settle(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);

    // Fires when the background side goes away (e.g. the service worker was
    // terminated mid-stream). Without this the caller would wait forever.
    port.onDisconnect.addListener(() => {
      settle({
        text: fullText,
        error: 'Connection to the background was lost before the response finished. Please try again.'
      });
    });

    port.onMessage.addListener((msg) => {
      if (settled) return;
      if (msg.done) {
        settle({ text: fullText });
      } else if (msg.error) {
        settle({ text: fullText, error: msg.error });
      } else if (msg.chunk) {
        fullText += msg.chunk;
        onChunk(msg.chunk);
      } else if (msg.reasoning && onReasoning) {
        onReasoning(msg.reasoning);
      } else if (msg.webSearch && onWebSearch) {
        onWebSearch(msg.webSearch);
      } else if (msg.retry && onRetry) {
        onRetry(msg.retry);
      } else if (msg.image && onImage) {
        onImage(msg.image);
      }
    });

    port.postMessage({ messages, config, streamId });
  });
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

const callGoogle = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ApiResponse> => {
  const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');

  // Convert standard messages to Gemini format
  const contents = chatMessages.map(m => {
    // Gemini rejects empty text parts, which image-only messages would produce
    const parts: any[] = (m.content.trim() || !m.image) ? [{ text: m.content }] : [];
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

  const requestBody: any = { contents };

  // Add system instruction if present
  if (systemMessages.length > 0) {
    const systemText = systemMessages.map(m => m.content).join('\n\n');
    requestBody.systemInstruction = {
      parts: [{ text: systemText }]
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = await response.json();
  // Extract text from all parts
  const parts = data.candidates?.[0]?.content?.parts;
  const text = parts?.filter((p: any) => p.text).map((p: any) => p.text).join('') || '';
  return { text: stripThinkingTags(text) };
};

const callOpenAI = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ApiResponse> => {
  if (shouldUseImageGenerationsEndpoint(model)) {
    return callOpenAIImageGeneration(apiKey, baseUrl, model, messages, signal);
  }

  const url = `${baseUrl}/chat/completions`;

  const msgs = messages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          ...imageMessageTextPart(m.content),
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
    signal,
    body: JSON.stringify({
      model: model,
      messages: msgs
    })
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = await response.json();
  return { text: stripThinkingTags(data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '') };
};

const callAnthropic = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ApiResponse> => {
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
          ...imageMessageTextPart(m.content)
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const body: any = {
    model: model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
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
    signal,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = await response.json();
  return { text: stripThinkingTags(data.content?.[0]?.text || '') };
};

const callOpenRouter = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ApiResponse> => {
  // OpenRouter is OpenAI compatible
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          ...imageMessageTextPart(m.content),
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
    signal,
    body: JSON.stringify({
      model: model,
      messages: msgs
    })
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = await response.json();
  return { text: stripThinkingTags(data.choices?.[0]?.message?.content || '') };
}

// Perplexity API (OpenAI compatible with web search capabilities)
const callPerplexity = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ApiResponse> => {
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = mergeConsecutiveRoles(sanitizeMessagesForApi(messages));

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          ...imageMessageTextPart(m.content),
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
    signal,
    body: JSON.stringify({
      model: model,
      messages: msgs,
      web_search_options: {
        search_type: 'pro'
      }
    })
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = await response.json();
  return { text: stripThinkingTags(data.choices?.[0]?.message?.content || '') };
}

// Streaming Implementations

const STREAM_INTERRUPTED_ERROR = 'The response stream ended unexpectedly before completion. Please try again.';

// Servers report mid-stream failures (e.g. upstream canceled) as an SSE event
// like `data: {"error": {...}}` instead of an HTTP status, so surface them as errors.
const throwIfStreamError = (line: string) => {
  const trim = line.trim();
  if (!trim.startsWith('data:') || !trim.includes('"error"')) return;

  let json: any;
  try {
    json = JSON.parse(trim.slice(5).trim());
  } catch {
    return;
  }

  const err = json?.error ?? (json?.type === 'error' ? json : undefined);
  if (!err) return;
  const message = typeof err === 'string' ? err : err.message || JSON.stringify(err);
  throw new Error(message);
};

const readStream = async (response: Response, signal: AbortSignal | undefined, onChunk: (text: string) => void, parser: (chunk: string) => string | null) => {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  if (!reader) throw new Error('Response body is unavailable');

  // Make sure a pending read ends on abort (e.g. the idle timeout) even if the
  // body isn't tied to the fetch signal
  const onAbort = () => { reader.cancel().catch(() => { }); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reportStreamActivity(signal);

      buffer += decoder.decode(value, { stream: true });

      // SSE is line based: process complete lines and keep the last partial
      // line in the buffer for the next packet
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        try {
          throwIfStreamError(line);
        } catch (e) {
          reader.cancel().catch(() => { });
          throw e;
        }
        const parsed = parser(line);
        if (parsed) onChunk(parsed);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // A cancelled reader reports done; don't treat that as a finished stream
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Process remaining buffer
  if (buffer) {
    throwIfStreamError(buffer);
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
          ...imageMessageTextPart(m.content),
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

  // OpenRouter has no /images/generations; its image models answer via chat
  // completions with `modalities` and stream images in delta.images.
  if (!isOpenRouter && shouldUseImageGenerationsEndpoint(model)) {
    const result = await callOpenAIImageGeneration(apiKey, baseUrl, model, messages, signal);
    if (result.text) {
      onChunk(result.text);
    }
    if (result.images && onImage) {
      for (const imageUrl of result.images) {
        onImage(imageUrl);
      }
    }
    return result;
  }

  // Detect web search configuration early to conditionally add instructions
  const webSearchEnabled = config && shouldEnableWebSearch(config, model);
  const isGeminiModel = /^gemini-/.test(model);
  // Gemini models keep native google_search grounding; brave must NOT override it.
  // Brave is only used as the search backend for non-Gemini models.
  const useNativeGoogleSearch = webSearchEnabled &&
    (config?.webSearchProvider === 'google' || config?.webSearchProvider === 'brave') &&
    isGeminiModel;

  // Detect OpenAI native web search (GPT models on OpenAI provider)
  const isGPTModel = /^(gpt-|o\d|chatgpt-)/.test(model);
  const useNativeOpenAISearch = webSearchEnabled && !isOpenRouter && isGPTModel;

  // Detect Grok native web and X search for xAI models, including routed model IDs.
  const isGrokModel = model.toLowerCase().includes('grok');
  const useNativeGrokSearch = webSearchEnabled && isGrokModel;

  // Only add web search instructions for OpenAI-format function tool, not for native search
  const webSearchInstruction = (!useNativeGoogleSearch && !useNativeOpenAISearch && !useNativeGrokSearch && webSearchEnabled)
    ? 'The web search tool retrieves real-time information. When searching for current status (e.g. "price now", "latest news"), do NOT unnecessarily append the current month/year to the query, as this may limit results. Trust the search tool to provide the latest data. Only specify dates if searching for historical information or specific future projections. If you decide to use the web search tool, you should briefly explain what you are going to search for before calling the tool. You can call web_search multiple times in parallel if you need to search for different things simultaneously, or pass a "queries" array to search for multiple things in a single call.'
    : '';

  // Append web search instruction to existing system message if needed
  const defaultSystemPrompt = getSystemPrompt(config || {} as AppConfig);
  const msgsWithSystem = msgs[0]?.role === 'system'
    ? [{ ...msgs[0], content: `${msgs[0].content}${webSearchInstruction ? '\n\n' + webSearchInstruction : ''}` }, ...msgs.slice(1)]
    : [{ role: 'system', content: `${defaultSystemPrompt}${webSearchInstruction ? '\n\n' + webSearchInstruction : ''}` }, ...msgs];

  const requestBody: any = {
    model: model,
    messages: msgsWithSystem,
    stream: true
  };

  if (isOpenRouter && model.toLowerCase().includes('image')) {
    requestBody.modalities = ['image', 'text'];
  }


  if (webSearchEnabled) {
    if (useNativeGrokSearch) {
      // Grok has server-side web and X search tools.
      requestBody.tools = GROK_SEARCH_TOOLS;
    } else if (useNativeGoogleSearch) {
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
    await throwApiError(response);
  }

  let fullText = '';
  let toolCalls: any[] = [];
  let groundingSources: Array<{ title: string; url: string; snippet?: string }> = [];
  let nativeSearchAnnotations: Array<any> = [];
  const taggedContent = createThinkingTagExtractor((text) => {
    fullText += text;
    onChunk(text);
  }, onReasoning);

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content || choice?.text || '';
    if (content) {
      taggedContent.write(content);
      taggedContent.flush();
    }

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

    // Extract native search citations exposed as OpenAI-compatible annotations.
    if ((useNativeOpenAISearch || useNativeGrokSearch) && choice?.message?.annotations) {
      nativeSearchAnnotations = choice.message.annotations;
    }
  } else {
    let streamFinished = false;
    await readStream(response, signal, (text) => {
      taggedContent.write(text);
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      if (dataStr === '[DONE]') {
        streamFinished = true;
        return null;
      }

      try {
        const json = JSON.parse(dataStr);
        const choice = json.choices?.[0];
        if (choice?.finish_reason) streamFinished = true;

        // Check for tool calls
        if (choice?.delta?.tool_calls) {
          accumulateToolCallDeltas(toolCalls, choice.delta.tool_calls);
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

        // Extract native search citations exposed as OpenAI-compatible annotations.
        if ((useNativeOpenAISearch || useNativeGrokSearch) && choice?.delta?.annotations) {
          for (const ann of choice.delta.annotations) {
            nativeSearchAnnotations.push(ann);
          }
        }

        // Handle reasoning_content (DeepSeek and others) / reasoning (OpenRouter)
        const reasoningContent = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
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
    taggedContent.flush();

    // Connection closed without [DONE]/finish_reason: the server dropped the
    // request midway, so don't present the partial output as a finished answer.
    if (!streamFinished) {
      return { text: fullText, error: STREAM_INTERRUPTED_ERROR };
    }
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

  // If native search returns annotations, extract sources and notify the UI.
  if ((useNativeOpenAISearch || useNativeGrokSearch) && nativeSearchAnnotations.length > 0 && onWebSearch) {
    const sources = nativeSearchAnnotations
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
  if (toolCalls.some(tc => tc?.function?.name) && config && webSearchEnabled && !useNativeOpenAISearch && !useNativeGrokSearch) {
    let currentToolCalls = toolCalls.filter(tc => tc?.function?.name);
    let currentMessages = msgsWithSystem;
    let currentFullText = fullText;
    const MAX_TOOL_ITERATIONS = 5; // Prevent infinite loops
    let iteration = 0;
    let followUpError: string | null = null;

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
          const followUpTaggedContent = createThinkingTagExtractor((text) => {
            followUpText += text;
            fullText += text;
            onChunk(text);
          }, onReasoning);

          const followUpContentType = followUpResponse.headers.get('content-type') || '';
          if (followUpContentType.includes('application/json')) {
            const data = await followUpResponse.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content || choice?.text || '';
            if (content) {
              followUpTaggedContent.write(content);
              followUpTaggedContent.flush();
            }
            // Check for more tool calls
            if (choice?.message?.tool_calls) {
              followUpToolCalls = choice.message.tool_calls;
            }
          } else {
            let followUpFinished = false;
            await readStream(followUpResponse, signal, (text) => {
              followUpTaggedContent.write(text);
            }, (line) => {
              const trim = line.trim();
              if (!trim || !trim.startsWith('data: ')) return null;
              const dataStr = trim.slice(6);
              if (dataStr === '[DONE]') {
                followUpFinished = true;
                return null;
              }
              try {
                const json = JSON.parse(dataStr);
                const choice = json.choices?.[0];
                if (choice?.finish_reason) followUpFinished = true;

                // Check for tool calls in streaming response
                if (choice?.delta?.tool_calls) {
                  accumulateToolCallDeltas(followUpToolCalls, choice.delta.tool_calls);
                }

                const followUpReasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
                if (followUpReasoning && onReasoning) {
                  onReasoning(followUpReasoning);
                }

                const followUpImages = choice?.delta?.images;
                if (Array.isArray(followUpImages) && onImage) {
                  for (const img of followUpImages) {
                    if (img?.image_url?.url) onImage(img.image_url.url);
                  }
                }

                return choice?.delta?.content || null;
              } catch {
                return null;
              }
            });
            followUpTaggedContent.flush();

            if (!followUpFinished) {
              followUpError = STREAM_INTERRUPTED_ERROR;
              break;
            }
          }

          // Update state for next iteration
          currentMessages = followUpMessages;
          currentFullText = followUpText;
          currentToolCalls = followUpToolCalls.filter(tc => tc?.function?.name === 'web_search');

          // If no more tool calls, we're done
          if (currentToolCalls.length === 0) {
            break;
          }
        } else {
          // Follow-up request failed, stop iteration
          const errText = await followUpResponse.text().catch(() => '');
          let errMessage = errText || followUpResponse.statusText || `HTTP ${followUpResponse.status}`;
          try {
            errMessage = JSON.parse(errText).error?.message || errMessage;
          } catch { /* not JSON */ }
          followUpError = errMessage;
          currentToolCalls = [];
          break;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        console.error('Parallel tool calls failed:', e);
        if (onWebSearch) {
          onWebSearch({ query: '', result: 'Search failed', isSearching: false, sources: [] });
        }
        followUpError = e?.message || 'Follow-up request failed';
        currentToolCalls = [];
        break;
      }

      // Only continue if there are more tool calls to process
      if (currentToolCalls.length === 0) {
        break;
      }
    }

    if (followUpError) {
      return { text: fullText, error: followUpError };
    }
  }

  return { text: fullText };
};

const streamAnthropic = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, _config?: AppConfig, onReasoning?: (text: string) => void): Promise<ApiResponse> => {
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
          ...imageMessageTextPart(m.content)
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const body: any = {
    model: model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
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
    await throwApiError(response);
  }

  let fullText = '';
  const taggedContent = createThinkingTagExtractor((text) => {
    fullText += text;
    onChunk(text);
  }, onReasoning);
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    if (content) {
      taggedContent.write(content);
      taggedContent.flush();
    }
  } else {
    let streamFinished = false;
    let hitMaxTokens = false;
    await readStream(response, signal, (text) => {
      taggedContent.write(text);
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      try {
        const json = JSON.parse(dataStr);
        if (json.type === 'message_stop') {
          streamFinished = true;
        }
        if (json.type === 'message_delta' && json.delta?.stop_reason === 'max_tokens') {
          hitMaxTokens = true;
        }
        if (json.type === 'content_block_delta' && json.delta?.text) {
          return json.delta.text;
        }
        return null;
      } catch {
        return null;
      }
    });
    taggedContent.flush();

    if (!streamFinished) {
      return { text: fullText, error: STREAM_INTERRUPTED_ERROR };
    }
    if (hitMaxTokens) {
      return { text: fullText, error: `The response was cut off at the ${ANTHROPIC_MAX_TOKENS}-token output limit.` };
    }
  }

  return { text: fullText };
};

// Streaming for Perplexity (OpenAI compatible SSE format)
const streamPerplexity = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, onReasoning?: (text: string) => void): Promise<ApiResponse> => {
  const url = `${baseUrl}/chat/completions`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = mergeConsecutiveRoles(sanitizeMessagesForApi(messages));

  const msgs = sanitizedMessages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          ...imageMessageTextPart(m.content),
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
    await throwApiError(response);
  }

  let fullText = '';
  const taggedContent = createThinkingTagExtractor((text) => {
    fullText += text;
    onChunk(text);
  }, onReasoning);
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (content) {
      taggedContent.write(content);
      taggedContent.flush();
    }
  } else {
    let streamFinished = false;
    await readStream(response, signal, (text) => {
      taggedContent.write(text);
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      if (dataStr === '[DONE]') {
        streamFinished = true;
        return null;
      }

      try {
        const json = JSON.parse(dataStr);
        if (json.choices?.[0]?.finish_reason) streamFinished = true;
        const content = json.choices?.[0]?.delta?.content;
        return content || null;
      } catch (e) {
        return null;
      }
    });
    taggedContent.flush();

    if (!streamFinished) {
      return { text: fullText, error: STREAM_INTERRUPTED_ERROR };
    }
  }

  return { text: fullText };
};

const streamGoogle = async (apiKey: string, baseUrl: string, model: string, messages: ChatMessage[], onChunk: (text: string) => void, signal?: AbortSignal, config?: AppConfig, onWebSearch?: (status: { query: string; result?: string; isSearching: boolean; sources?: Array<{ title: string; url: string; snippet?: string }>; startNewMessage?: boolean }) => void, onReasoning?: (text: string) => void, onImage?: (imageUrl: string) => void): Promise<ApiResponse> => {
  // API: POST https://.../streamGenerateContent?key=...&alt=sse
  // Using alt=sse for Server-Sent Events format which is more reliable than JSON array streaming
  const url = `${baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

  // Sanitize messages to remove UI-only fields and filter empty messages
  const sanitizedMessages = sanitizeMessagesForApi(messages);

  // Separate system messages from conversation messages
  // Gemini API uses systemInstruction for system-level context
  const systemMessages = sanitizedMessages.filter(m => m.role === 'system');
  const chatMessages = sanitizedMessages.filter(m => m.role !== 'system');

  const contents = chatMessages.map(m => {
    // Gemini rejects empty text parts, which image-only messages would produce
    const parts: any[] = (m.content.trim() || !m.image) ? [{ text: m.content }] : [];
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
  // Gemini models keep native google_search grounding; brave must NOT override it.
  const useGoogleSearch = config &&
    (config.webSearchProvider === 'google' || config.webSearchProvider === 'brave') &&
    config.enableWebSearch !== false &&
    isGeminiModel &&
    config.apiKeys['google']?.length > 0;

  const requestBody: any = { contents };

  // Add system instruction if present
  if (systemMessages.length > 0) {
    const systemText = systemMessages.map(m => m.content).join('\n\n');
    requestBody.systemInstruction = {
      parts: [{ text: systemText }]
    };
  }

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
    await throwApiError(response);
  }

  let fullText = '';
  let groundingSources: Array<{ title: string; url: string; snippet?: string }> = [];
  const taggedContent = createThinkingTagExtractor((text) => {
    fullText += text;
    onChunk(text);
  }, onReasoning);

  const contentType = response.headers.get('content-type') || '';

  // Helper to process a single Gemini response object (candidate)
  const processGeminiResponse = (json: any) => {
    // Extract text from all parts
    const parts = json.candidates?.[0]?.content?.parts;
    if (parts && Array.isArray(parts)) {
      for (const part of parts) {
        if (part.text) {
          taggedContent.write(part.text);
        }
        // Extract images from inline data
        if (onImage && part.inlineData && part.inlineData.mimeType && part.inlineData.data) {
          const imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          onImage(imageUrl);
        }
      }
    }

    // Extract grounding metadata
    if (useGoogleSearch) {
      const groundingMetadata = json.candidates?.[0]?.groundingMetadata;
      if (groundingMetadata?.groundingChunks) {
        groundingMetadata.groundingChunks.forEach((chunk: any) => {
          if (chunk.web) {
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
  };

  if (contentType.includes('text/event-stream')) {
    // SSE format (alt=sse): each event is "data: {json}\n\n"
    let streamFinished = false;
    let blockReason: string | null = null;
    await readStream(response, signal, (_text) => {
      // onChunk is called inside processGeminiResponse
    }, (line) => {
      const trim = line.trim();
      if (!trim || !trim.startsWith('data: ')) return null;

      const dataStr = trim.slice(6);
      try {
        const json = JSON.parse(dataStr);
        if (json.candidates?.[0]?.finishReason) streamFinished = true;
        if (json.promptFeedback?.blockReason) blockReason = json.promptFeedback.blockReason;
        processGeminiResponse(json);
      } catch (e) {
        // ignore malformed lines
      }
      return null; // We handle onChunk inside processGeminiResponse directly
    });
    taggedContent.flush();

    if (blockReason) {
      return { text: fullText, error: `The prompt was blocked by Gemini (${blockReason}).` };
    }
    if (!streamFinished) {
      return { text: fullText, error: STREAM_INTERRUPTED_ERROR };
    }
  } else if (contentType.includes('application/json')) {
    // JSON response - could be a single object or an array of objects
    const data = await response.json();

    if (Array.isArray(data)) {
      // Array of GenerateContentResponse objects (streamGenerateContent without alt=sse)
      for (const item of data) {
        processGeminiResponse(item);
      }
    } else {
      // Single response object
      processGeminiResponse(data);
    }
    taggedContent.flush();
  } else {
    // Fallback: try to parse as JSON array stream using brace-matching
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    if (!reader) throw new Error('No body');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reportStreamActivity(signal);
      buffer += decoder.decode(value, { stream: true });

      let braceCount = 0;
      let inString = false;
      let escape = false;
      let start = -1;
      let consumedUpTo = 0;

      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\' && inString) {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;

        if (char === '{') {
          if (braceCount === 0) start = i;
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0 && start !== -1) {
            const jsonStr = buffer.substring(start, i + 1);
            try {
              const json = JSON.parse(jsonStr);
              processGeminiResponse(json);
            } catch (e) {
              // ignore malformed
            }
            start = -1;
            consumedUpTo = i + 1;
          }
        }
      }

      if (consumedUpTo > 0) {
        buffer = buffer.substring(consumedUpTo);
      }
    }
    taggedContent.flush();
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
