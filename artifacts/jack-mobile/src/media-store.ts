import { Directory, File, Paths } from "expo-file-system";
import { isOwnedRecordingName } from "./core/transitions";

export function audioDirectory() {
  const directory = new Directory(Paths.cache, "jack-private-audio");
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/** Before Clerk/private UI mounts, remove crash leftovers. No auth tokens or answers go on disk. */
export function purgePrivateMedia() {
  const audio = audioDirectory();
  for (const item of audio.list()) {
    if (
      item instanceof File &&
      /^jack-speech-[a-f0-9-]{36}\.mp3$/i.test(item.name)
    )
      item.delete();
  }
  // SDK55 Android recorder owns cache/Audio/recording-<UUID>.m4a; no custom path API exists.
  const recordings = new Directory(Paths.cache, "Audio");
  if (recordings.exists) {
    for (const item of recordings.list()) {
      if (item instanceof File && isOwnedRecordingName(item.name))
        item.delete();
    }
  }
}
