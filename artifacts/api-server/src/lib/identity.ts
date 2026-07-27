/**
 * Historical synthetic id used by the retired public presentation mode.
 * Kept only so ownership/privacy code can recognize legacy rows; no request
 * middleware assigns this identity anymore.
 */
export const PRESENTATION_USER_ID = "presentation-demo";

export interface PresentationIdentity {
  userId: string;
  isPresentation?: boolean;
}

/**
 * Presentation access is a server-resolved identity property. The legacy
 * synthetic id remains recognized for historical rows and tests, while current
 * Clerk accounts are designated through private metadata in resolveIdentity.
 */
export function isPresentationIdentity(identity: PresentationIdentity): boolean {
  return identity.isPresentation === true || identity.userId === PRESENTATION_USER_ID;
}
