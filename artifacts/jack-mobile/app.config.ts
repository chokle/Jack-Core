import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Jack",
  icon: "./assets/icon.png",
  slug: "jack-field",
  version: "0.1.0",
  scheme: "jack",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  android: {
    package: "ca.torchlabs.jack",
    adaptiveIcon: {
      foregroundImage: "./assets/icon.png",
      backgroundColor: "#050914",
    },
    versionCode: 1,
    permissions: ["RECORD_AUDIO"],
    blockedPermissions: [
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ],
    allowBackup: false,
  },
  plugins: [
    [
      "expo-audio",
      {
        microphonePermission:
          "Allow Jack to hear your question when you start the microphone.",
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
      },
    ],
    ["expo-secure-store", { configureAndroidBackup: true }],
    "expo-video",
  ],
};
export default config;
