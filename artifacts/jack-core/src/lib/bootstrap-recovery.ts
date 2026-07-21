const APP_STORAGE_VERSION = "2026-07-16.1";
const VERSION_KEY = "jack.browserStateVersion";

const JSON_KEYS = [
  "jack.interview.resumeNote",
  "jack.userTesting.pendingRecordings",
];

const JSON_PREFIXES = [
  "jack.interview.draft.",
  "floating-panel:",
];

function isJsonKey(key: string): boolean {
  return JSON_KEYS.includes(key) || JSON_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function removeInvalidJsonValues(storage: Storage): string[] {
  const removed: string[] = [];

  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || !isJsonKey(key)) continue;

    const value = storage.getItem(key);
    if (!value) continue;

    try {
      JSON.parse(value);
    } catch {
      storage.removeItem(key);
      removed.push(key);
    }
  }

  return removed;
}

async function unregisterServiceWorkers(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

async function clearJackCaches(): Promise<void> {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith("jack-"))
      .map((key) => caches.delete(key)),
  );
}

export async function prepareBrowserUpgrade(): Promise<void> {
  removeInvalidJsonValues(localStorage);
  removeInvalidJsonValues(sessionStorage);

  if (localStorage.getItem(VERSION_KEY) === APP_STORAGE_VERSION) return;

  await Promise.allSettled([
    unregisterServiceWorkers(),
    clearJackCaches(),
  ]);
  localStorage.setItem(VERSION_KEY, APP_STORAGE_VERSION);
}

