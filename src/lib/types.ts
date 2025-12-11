export type Provider = string;

export interface CustomProvider {
  id: string; // internal id (e.g. 'custom-1')
  name: string; // display name (e.g. 'Local Mistral')
  baseUrl: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  immediate?: boolean;
  onlyImage?: boolean;
  hotkey?: {
    key: string;
    modifiers: string[];
  } | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  image?: string; // Data URL
  interrupted?: boolean;
  responseTime?: number; // Response time in milliseconds
}

export interface ApiConfig {
  provider: Provider;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface AppConfig {
  apiKeys: Record<string, string[]>; // Allow multiple keys per provider
  selectedProvider: string;
  customBaseUrls: Record<string, string>;
  prompts: PromptTemplate[];
  selectedModel: Record<string, string>;
  customProviders: CustomProvider[];
  customHotkey: {
    key: string;
    modifiers: string[];
  } | null;
  cropHotkey: {
    key: string;
    modifiers: string[];
  } | null;
  theme: 'system' | 'light' | 'dark';
  popupMode?: 'extension' | 'content_script';
  popupSize?: { width: number; height: number };
}

export const DEFAULT_PROMPTS: PromptTemplate[] = [
  { id: '1', name: 'Summarize', content: 'Summarize the following text:\n\n${text}' },
  { id: '2', name: 'Explain', content: 'Explain this text in simple terms:\n\n${text}' },
  { id: '3', name: 'Translate to English', content: 'Translate the following text to English:\n\n${text}' },
  { id: '4', name: 'Fix Grammar', content: 'Fix the grammar and improve the writing of the following text:\n\n${text}' },
];

export const DEFAULT_CONFIG: AppConfig = {
  apiKeys: {
    openai: [],
    google: [],
    anthropic: [],
    openrouter: [],
  },
  selectedProvider: 'google',
  customBaseUrls: {
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    anthropic: 'https://api.anthropic.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
  },
  prompts: DEFAULT_PROMPTS,
  selectedModel: {
    openai: 'gpt-4o-mini',
    google: 'gemini-1.5-flash',
    anthropic: 'claude-3-haiku-20240307',
    openrouter: 'google/gemini-2.0-flash-exp:free',
  },
  customProviders: [],
  customHotkey: null,
  cropHotkey: null,
  theme: 'system',
  popupMode: 'content_script',
  popupSize: { width: 450, height: 600 }
};
