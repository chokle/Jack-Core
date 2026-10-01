export interface SecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** No AsyncStorage fallback. If secure storage fails, authentication fails closed. */
export function createSecureTokenCache(storage: SecureStorage) {
  return {
    getToken: (key: string) => storage.getItemAsync(key),
    saveToken: (key: string, value: string) => storage.setItemAsync(key, value),
    clearToken: (key: string) => storage.deleteItemAsync(key),
  };
}
