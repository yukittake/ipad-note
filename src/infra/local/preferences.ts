import Storage from 'expo-sqlite/kv-store';

const KEY = 'editor-preferences-v2';

export const editorPreferencesStorage = {
  getItem: (name: string) => Storage.getItemSync(`${KEY}:${name}`),
  setItem: (name: string, value: string) => Storage.setItemSync(`${KEY}:${name}`, value),
  removeItem: (name: string) => Storage.removeItemSync(`${KEY}:${name}`),
};
