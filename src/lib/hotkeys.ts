type Hotkey = {
  key: string;
  modifiers: string[];
} | null | undefined;

type KeyboardLikeEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'alt', 'shift', 'meta', 'command']);

const hasModifier = (modifiers: string[], ...names: string[]) => {
  const normalized = modifiers.map(modifier => modifier.toLowerCase());
  return names.some(name => normalized.includes(name));
};

export const matchesHotkey = (event: KeyboardLikeEvent, hotkey: Hotkey): boolean => {
  if (!hotkey) return false;

  const eventKey = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(eventKey)) return false;

  const modifiers = hotkey.modifiers || [];

  return (
    eventKey === hotkey.key.toLowerCase() &&
    event.ctrlKey === hasModifier(modifiers, 'ctrl', 'control') &&
    event.altKey === hasModifier(modifiers, 'alt') &&
    event.shiftKey === hasModifier(modifiers, 'shift') &&
    event.metaKey === hasModifier(modifiers, 'meta', 'command')
  );
};
