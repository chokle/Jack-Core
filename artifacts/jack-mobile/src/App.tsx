import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ClerkProvider, useAuth, useSignIn } from "@clerk/clerk-expo";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { createSecureTokenCache } from "./core/secure-token-cache";
import { FieldClient } from "./FieldClient";
import { purgePrivateMedia } from "./media-store";

const tokenCache = createSecureTokenCache(SecureStore);
const publicKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

export function Action({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.45 }]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function SignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  async function submit() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!sent) {
        const attempt = await signIn.create({ identifier: email.trim() });
        const factor = attempt.supportedFirstFactors?.find(
          (factor) => factor.strategy === "email_code",
        );
        if (!factor || factor.strategy !== "email_code")
          throw new Error(
            "This account does not offer email code sign-in. Contact your Jack administrator.",
          );
        await signIn.prepareFirstFactor({
          strategy: "email_code",
          emailAddressId: factor.emailAddressId,
        });
        setSent(true);
      } else {
        const result = await signIn.attemptFirstFactor({
          strategy: "email_code",
          code: code.trim(),
        });
        if (result.status !== "complete")
          throw new Error(
            "Your account requires additional verification. Contact your Jack administrator.",
          );
        setCode("");
        await setActive({ session: result.createdSessionId });
      }
    } catch (cause) {
      // Do not expose Clerk/provider payloads or log addresses/codes.
      setError(
        cause instanceof Error && !("errors" in cause)
          ? cause.message
          : sent
            ? "The code could not be verified. Check it or request a new code."
            : "Sign-in could not start. Check your email and connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.fill}
    >
      <View key={generation} style={styles.signIn}>
        <Text style={styles.title}>Jack</Text>
        <Text style={styles.body}>
          Sign in with your existing Jack account.
        </Text>
        <TextInput
          accessibilityLabel={
            sent ? "Email verification code" : "Email address"
          }
          placeholder={sent ? "Email code" : "Email address"}
          placeholderTextColor="#92a4ac"
          value={sent ? code : email}
          onChangeText={sent ? setCode : setEmail}
          keyboardType={sent ? "number-pad" : "email-address"}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType={sent ? "oneTimeCode" : "emailAddress"}
          autoComplete={sent ? "one-time-code" : "email"}
          secureTextEntry={sent}
          style={styles.input}
        />
        {sent && (
          <Text style={styles.body}>Enter the code sent to your email.</Text>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Action
          title={busy ? "Please wait…" : sent ? "Sign in" : "Send email code"}
          onPress={() => void submit()}
          disabled={!isLoaded || busy || !(sent ? code.trim() : email.trim())}
        />
        {sent && (
          <Action
            title="Use another email / resend"
            disabled={busy}
            onPress={() => {
              setSent(false);
              setCode("");
              setError("");
              setGeneration((value) => value + 1);
            }}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function Session() {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  if (!isLoaded)
    return (
      <ActivityIndicator
        accessibilityLabel="Restoring secure session"
        color="#64dae5"
      />
    );
  // Remount all private state across users AND sessions. No answer/history persisted on device.
  return isSignedIn ? (
    <FieldClient key={`${userId}:${sessionId}`} />
  ) : (
    <SignIn />
  );
}

export default function App() {
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => {
    try {
      purgePrivateMedia();
      setMediaReady(true);
    } catch {
      setMediaError(true);
    }
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.fill}>
        <StatusBar style="light" />
        {mediaError ? (
          <View style={styles.signIn}>
            <Text style={styles.title}>Private audio cleanup failed</Text>
            <Text style={styles.body}>
              Restart Jack before signing in. If this continues, clear Jack's
              app data in Android Settings.
            </Text>
          </View>
        ) : !mediaReady ? (
          <ActivityIndicator color="#64dae5" />
        ) : !publicKey ? (
          <View style={styles.signIn}>
            <Text style={styles.title}>Jack configuration required</Text>
            <Text style={styles.body}>
              This build needs the existing Jack Clerk public key. Ask the
              release owner to rebuild it.
            </Text>
          </View>
        ) : (
          <ClerkProvider publishableKey={publicKey} tokenCache={tokenCache}>
            <Session />
          </ClerkProvider>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#10191e" },
  signIn: { flex: 1, justifyContent: "center", gap: 16, padding: 24 },
  title: { color: "#f1f7f8", fontSize: 28, fontWeight: "700" },
  body: { color: "#c7d6dc", fontSize: 16, lineHeight: 23 },
  input: {
    backgroundColor: "#203139",
    color: "#f1f7f8",
    borderColor: "#49616b",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 17,
    minHeight: 54,
  },
  button: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#64dae5",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: "#092126", fontSize: 16, fontWeight: "700" },
  error: { color: "#ffb6ad", fontSize: 16, lineHeight: 23 },
});
