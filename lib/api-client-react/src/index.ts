export * from "./generated/api";
export * from "./generated/api.schemas";
export {
  authenticatedFetch,
  customFetch,
  setBaseUrl,
  setAuthTokenGetter,
} from "./custom-fetch";
export type { AuthTokenGetter } from "./custom-fetch";
