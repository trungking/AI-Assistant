import type { AppConfig, ChatMessage } from './types';

interface ApiResponse {
  text: string;
  error?: string;
}

export const callApi = async (
  messages: ChatMessage[],
  config: AppConfig
): Promise<ApiResponse> => {
  const provider = config.selectedProvider;
  const apiKeys = config.apiKeys[provider];

  if (!apiKeys || apiKeys.length === 0) {
    return { text: '', error: `No API key found for ${provider}` };
  }

  // Randomly select an API key
  const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
  const baseUrl = config.customBaseUrls[provider] || getDefaultBaseUrl(provider);
  const model = config.selectedModel[provider];

  try {
    switch (provider) {
      case 'google':
        return await callGoogle(apiKey, baseUrl, model, messages);
      case 'openai':
        return await callOpenAI(apiKey, baseUrl, model, messages);
      case 'anthropic':
        return await callAnthropic(apiKey, baseUrl, model, messages);
      case 'openrouter':
        return await callOpenRouter(apiKey, baseUrl, model, messages);
      default:
        // Assume custom providers are OpenAI compatible
        return await callOpenAI(apiKey, baseUrl, model, messages);
    }
  } catch (e: any) {
    return { text: '', error: e.message || 'API call failed' };
  }
};

export const fetchModels = async (
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
    return [];
  } catch (e) {
    console.error("Failed to fetch models", e);
    throw e;
  }
};

const getDefaultBaseUrl = (provider: string) => {
  switch (provider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'google': return 'https://generativelanguage.googleapis.com/v1beta';
    case 'anthropic': return 'https://api.anthropic.com/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
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
  return { text: data.choices?.[0]?.message?.content || '' };
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