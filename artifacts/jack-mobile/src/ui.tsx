import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

// Orange: existing Jack index.css --primary (24 100% 50%) / logo.svg flame.
// Black/charcoal: Derek's Oct1 native acceptance direction. Assets copied unchanged from Jack web.
export const theme = {
  background: "#09090B",
  panel: "#151518",
  border: "#2B2B30",
  orange: "#FF6600",
  orangeLight: "#FF9A3D",
  text: "#FAFAFA",
  muted: "#AAAAB2",
};

export function BrandLockup() {
  return (
    <View style={styles.brand}>
      <Image
        source={require("../assets/icon.png")}
        resizeMode="contain"
        style={styles.brandIcon}
        accessibilityLabel="Torch"
      />
      <View>
        <Text style={styles.wordmark}>JACK</Text>
        <Text style={styles.brandCaption}>INSIDE TORCH</Text>
      </View>
    </View>
  );
}

export function JackIdentity({ compact = false }: { compact?: boolean }) {
  return (
    <Image
      source={require("../assets/jack-mascot.webp")}
      resizeMode="contain"
      style={{
        width: compact ? 72 : 132,
        height: compact ? 88 : 164,
        alignSelf: "center",
      }}
      accessibilityLabel="Jack, Torch's field assistant"
    />
  );
}

export function Action({
  title,
  onPress,
  disabled = false,
  variant = "primary",
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "secondary" && styles.secondaryButton,
        pressed && { opacity: 0.8 },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          variant === "secondary" && { color: theme.text },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.background },
  signIn: { flex: 1, justifyContent: "center", gap: 16, padding: 24 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandIcon: { width: 32, height: 40 },
  wordmark: {
    color: theme.text,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 2,
  },
  brandCaption: {
    color: theme.orangeLight,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.7,
  },
  title: { color: theme.text, fontSize: 28, fontWeight: "700" },
  body: { color: "#D4D4D8", fontSize: 16, lineHeight: 24 },
  input: {
    backgroundColor: theme.panel,
    color: theme.text,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    fontSize: 17,
    minHeight: 54,
    maxHeight: 110,
  },
  button: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: theme.orange,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButton: {
    backgroundColor: "#202023",
    borderColor: theme.border,
    borderWidth: 1,
  },
  buttonText: { color: "#09090B", fontSize: 16, fontWeight: "800" },
  error: { color: "#FFB4A8", fontSize: 14, lineHeight: 21 },
});
