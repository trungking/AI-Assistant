import type { ChatMessage } from './types';

export const CHROME_PROVIDER = 'chrome';
export const CHROME_NANO_MODEL = 'Gemini Nano';

type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LanguageModelSession {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface LanguageModelApi {
  availability(): Promise<LanguageModelAvailability>;
  create(options?: {
    initialPrompts?: Array<{
      role: ChatMessage['role'];
      content: string;
    }>;
  }): Promise<LanguageModelSession>;
}

let activeSession: LanguageModelSession | undefined;
let sessionHistory: Array<Pick<ChatMessage, 'role' | 'content'>> = [];

const getLanguageModel = (): LanguageModelApi | undefined => {
  return (globalThis as typeof globalThis & { LanguageModel?: LanguageModelApi }).LanguageModel;
};

export const getChromeNanoAvailability = async (): Promise<LanguageModelAvailability> => {
  const languageModel = getLanguageModel();
  if (!languageModel) return 'unavailable';

  try {
    return await languageModel.availability();
  } catch {
    return 'unavailable';
  }
};

const sameHistory = (
  left: Array<Pick<ChatMessage, 'role' | 'content'>>,
  right: Array<Pick<ChatMessage, 'role' | 'content'>>
): boolean => left.length === right.length && left.every((message, index) =>
  message.role === right[index]?.role && message.content === right[index]?.content
);

export const destroyChromeNanoSession = (): void => {
  try {
    activeSession?.destroy();
  } finally {
    activeSession = undefined;
    sessionHistory = [];
  }
};

export const callChromeNano = async (
  messages: ChatMessage[],
  onChunk?: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; error?: string }> => {
  if (messages.some(message => message.image)) {
    return { text: '', error: 'Gemini Nano currently supports text-only conversations in AI Ask.' };
  }

  const languageModel = getLanguageModel();
  if (!languageModel || await getChromeNanoAvailability() !== 'available') {
    return { text: '', error: 'Gemini Nano is not available in this Chrome context.' };
  }

  const latestMessage = messages.at(-1);
  if (!latestMessage || latestMessage.role !== 'user') {
    return { text: '', error: 'Gemini Nano requires a user message.' };
  }

  const priorHistory = messages.slice(0, -1).map(({ role, content }) => ({ role, content }));

  try {
    if (!activeSession || !sameHistory(sessionHistory, priorHistory)) {
      destroyChromeNanoSession();
      activeSession = await languageModel.create({ initialPrompts: priorHistory });
      sessionHistory = priorHistory;
    }

    const answer = await activeSession.prompt(latestMessage.content, { signal });
    sessionHistory = [
      ...priorHistory,
      { role: 'user', content: latestMessage.content },
      { role: 'assistant', content: answer }
    ];
    onChunk?.(answer);
    return { text: answer };
  } catch (error: unknown) {
    destroyChromeNanoSession();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { text: '', error: error instanceof Error ? error.message : 'Gemini Nano request failed.' };
  }
};
