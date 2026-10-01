# Jack invitations and access

An authorized organization invitation is sufficient for Jack access after Clerk email-code authentication. Pilot enrollment, recording consent, cohort email lists, and device recognition are not prerequisites.

## Admin flow

Open **Invite people** from Jack's menu or Account & privacy. Choose an organization you administer, the user's email, and **Member** or **Champion / demo**. Platform admins can invite into any active organization; organization admins can invite only into their own active organization. Neither invitation role grants administration, report access, or access to another organization's sites.

The invitation authorizes access before email is sent. For a new user, the backend creates a passwordless Clerk account with a reserved email identifier. Existing accounts, passwords, and sessions are reused. The email opens Jack's email-code sign-in. After the recipient verifies their email, Jack atomically accepts invitations bound to that Clerk subject and verified address. Accepted memberships persist independently of invitation expiry and pilot dates.

Use Champion / demo for an approved demonstrator such as Rob. This labels their role without granting administrative powers. Their permitted content and site access remain constrained by the same server checks as a member. Invite the person's confirmed email; do not infer an account from a similar name or pilot alias.

**Revoke invitation** also disables any current general membership created by that invitation. It does not remove an independent existing pilot grant or a newer invitation's grant. Existing pilot permissions remain governed by their existing administration tools.

## Delivery recovery and security

The browser saves a request ID before sending. Retrying that ID retrieves its saved receipt and never sends another email. An unknown delivery result is not reported as sent. Admins can review and revoke an uncertain or expired invitation, then send a replacement. Provider requests have a finite timeout; a timed-out provisioning call cannot proceed to email afterward. New-account creation may have succeeded even when its receipt was lost; a replacement checks for the existing account before attempting creation.

The database stores tenant/role grants and an atomic invitation audit. Browser database roles have no access. Acceptance requires the authenticated Clerk subject and a verified email; URL tickets, client-supplied identity, and public metadata are not authorization. Member/champion roles cannot create admin grants. Clerk OTP and attack protection, invitation limits, and existing AI/API rate limits remain enforced. The old email-only session-token endpoint returns 410.

Account deletion fences invitation acceptance for the deleted subject, removes its memberships, and scrubs its invitation/audit attribution before deleting the Clerk identity. Former users retain Account & privacy controls even without current app access. Recording and telemetry consent remain optional and separate.

## Release and acceptance

1. Apply `20260927000000_jack_invitation_access.sql` after its isolated database tests and review pass. It adds new tables/functions and does not rewrite existing pilot data.
2. Deploy the reviewed application and record the actual production commit and deployment receipt. No global Clerk password, CAPTCHA, session, or access-mode setting change is required. The installed SDK passes through the supported Backend API reserved-email option; actual production acceptance must confirm this provider behavior.
3. Through the real admin UI, invite a new approved inbox into the intended organization. Verify email receipt, one OTP sign-in, correct member/champion role, Ask Jack answer, browser closure, and unaided return using the same profile. Exercise mobile layout, a separate uninvited account, another tenant, revocation, and an existing account. Do not use an admin-minted session or synthetic test token as OTP acceptance evidence.
4. Preserve the deployed SHA, invitation ID, redacted delivery receipt, membership/audit results, browser evidence, and return-session result. Never record OTPs, session tokens, full invitation URLs, or private answers in public artifacts.

Rollback: restore the previously recorded production application version through the existing deployment lane; leave the additive schema and audit intact. Existing pilot accounts continue under the previous version, while newly invited general members require this version or a reviewed fix-forward. Do not delete new memberships or erase audit evidence as rollback. A successful build, provider email submission, or shallow health check alone does not establish onboarding acceptance.
