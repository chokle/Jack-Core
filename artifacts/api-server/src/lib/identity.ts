/**
 * Historical synthetic id used by the retired public presentation mode.
 * Kept only so ownership/privacy code can recognize legacy rows; no request
 * middleware assigns this identity anymore.
 */
export const PRESENTATION_USER_ID = "presentation-demo";

export interface PresentationIdentity {
  userId: string;
  isPresentation?: boolean;
  classification?: "resolved" | "restricted" | "unavailable";
}

/**
 * Presentation access is a server-resolved identity property. The legacy
 * synthetic id remains recognized for historical rows and tests, while current
 * Clerk accounts are designated through private metadata in resolveIdentity.
 */
export function isPresentationIdentity(identity: PresentationIdentity): boolean {
  return identity.isPresentation === true || identity.userId === PRESENTATION_USER_ID;
}

export function isUnavailableIdentity(identity: PresentationIdentity): boolean {
  return identity.classification === "unavailable";
}

export function denyRestrictedIdentity(
  res: {
    status: (statusCode: number) => {
      json: (payload: { error: string }) => unknown;
    };
  },
  identity: PresentationIdentity,
  presentationMessage: string,
  unavailableMessage = "Identity verification is temporarily unavailable.",
): boolean {
  if (isUnavailableIdentity(identity)) {
    res.status(503).json({ error: unavailableMessage });
    return true;
  }
  if (isPresentationIdentity(identity)) {
    res.status(403).json({ error: presentationMessage });
    return true;
  }
  return false;
}
