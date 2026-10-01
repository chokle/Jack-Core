import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@clerk/react";
import { Link } from "wouter";
import { accessRequest, useJackAccess } from "./JackAccess";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Organization = { id: string; name: string };
type InviteRequest = {
  requestId: string;
  organizationId: string;
  email: string;
  role: "member" | "champion";
};
export type InvitationReceipt = {
  id: string;
  organizationId: string;
  email: string;
  role: "member" | "champion";
  status: "pending" | "accepted" | "revoked";
  deliveryStatus: "pending" | "sent" | "unknown";
  expiresAt: string;
};

export function InviteUsers() {
  const access = useJackAccess();
  const { userId } = useAuth();
  if (!access?.canInvite || !userId)
    return (
      <main className="mx-auto max-w-xl space-y-4 p-6">
        <h1 className="text-xl font-semibold">
          Invitations are available to organization admins
        </h1>
        <Link href="/app" className="text-primary underline">
          Back to Jack
        </Link>
      </main>
    );
  return <InviteManager key={userId} userId={userId} />;
}

function InviteManager({ userId }: { userId: string }) {
  const storageKey = `jack.invitation.pending.v1:${userId}`;
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "champion">("member");
  const [pending, setPending] = useState<InviteRequest | null>(null);
  const [invitations, setInvitations] = useState<InvitationReceipt[]>([]);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void accessRequest<{ organizations: Organization[] }>(
      "/api/access/organizations",
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setOrganizations(data.organizations);
        let saved: InviteRequest | null = null;
        try {
          const candidate = JSON.parse(
            sessionStorage.getItem(storageKey) ?? "null",
          ) as InviteRequest | null;
          if (
            candidate &&
            typeof candidate.requestId === "string" &&
            typeof candidate.email === "string" &&
            ["member", "champion"].includes(candidate.role) &&
            data.organizations.some(
              (org) => org.id === candidate.organizationId,
            )
          )
            saved = candidate;
        } catch {
          /* A new request is persisted before any send, or sending fails closed. */
        }
        setPending(saved);
        setOrganizationId(
          saved?.organizationId ?? data.organizations[0]?.id ?? "",
        );
        if (saved) {
          setEmail(saved.email);
          setRole(saved.role);
          setNotice(
            "An invitation request needs its delivery status checked. Retrying uses the same request.",
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Organizations could not be loaded. Please try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [storageKey, reload]);
  useEffect(() => {
    if (!organizationId) return;
    const controller = new AbortController();
    setInvitations([]);
    void accessRequest<{ invitations: InvitationReceipt[] }>(
      `/api/access/invitations?organizationId=${encodeURIComponent(organizationId)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setInvitations(data.invitations);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Invitation history could not be loaded. Refresh to check its status.",
          );
      });
    return () => controller.abort();
  }, [organizationId, revision]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (
      sending.current ||
      !organizations.some((org) => org.id === organizationId)
    )
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const request = pending ?? {
        requestId: crypto.randomUUID(),
        organizationId,
        email: email.trim().toLowerCase(),
        role,
      };
      // Persist intent before sending. An uncertain result must never create a new send.
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      const receipt = await accessRequest<InvitationReceipt>(
        "/api/access/invitations",
        { method: "POST", body: JSON.stringify(request) },
      );
      setInvitations((current) => [
        receipt,
        ...current.filter((item) => item.id !== receipt.id),
      ]);
      if (receipt.deliveryStatus === "sent" || receipt.status !== "pending") {
        sessionStorage.removeItem(storageKey);
        setPending(null);
        setEmail("");
        setNotice(
          receipt.status === "accepted"
            ? "This invitation has already been accepted."
            : receipt.status === "revoked"
              ? "This invitation has been revoked."
              : "Invitation sent.",
        );
      } else {
        setNotice(
          "Delivery is not confirmed yet. Check delivery using the same request; another invitation will not be sent. If delivery remains unknown, revoke this invitation before sending a replacement.",
        );
      }
    } catch {
      setError(
        "Delivery could not be confirmed. Retry this request to check safely. If browser storage is unavailable, enable it before sending.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function revoke(receipt: InvitationReceipt) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await accessRequest(
        `/api/access/invitations/${encodeURIComponent(receipt.id)}`,
        { method: "DELETE" },
      );
      setInvitations((current) =>
        current.map((item) =>
          item.id === receipt.id ? { ...item, status: "revoked" } : item,
        ),
      );
      if (
        pending?.organizationId === receipt.organizationId &&
        pending.email === receipt.email &&
        pending.role === receipt.role
      ) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
        setEmail("");
      }
      setNotice(
        "Invitation revoked. Any access granted by this invitation has also been removed.",
      );
    } catch {
      setError(
        "Revocation could not be confirmed. Refresh its status before trying again.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto min-h-[100dvh] max-w-3xl space-y-6 p-4 sm:p-8">
      <Link href="/app" className="text-sm text-primary underline">
        Back to Jack
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Invite people to Jack</h1>
        <p className="mt-2 text-muted-foreground">
          Choose their organization and access. They'll receive an email
          invitation.
        </p>
      </header>
      {loading ? (
        <p role="status">Loading organizations...</p>
      ) : organizations.length === 0 ? (
        <p>No organizations are available to invite into.</p>
      ) : (
        <form
          onSubmit={(event) => void send(event)}
          className="space-y-4 rounded-2xl border border-border bg-card p-5"
        >
          <label className="block space-y-2 text-sm font-medium">
            <span>Organization</span>
            <select
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-base"
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
              disabled={busy || !!pending}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-2 text-sm font-medium">
            <span>Email address</span>
            <Input
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy || !!pending}
            />
          </label>
          <label className="block space-y-2 text-sm font-medium">
            <span>Role</span>
            <select
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-base"
              value={role}
              onChange={(event) =>
                setRole(event.target.value as InviteRequest["role"])
              }
              disabled={busy || !!pending}
            >
              <option value="member">Member</option>
              <option value="champion">Champion / demo</option>
            </select>
          </label>
          <p className="text-sm text-muted-foreground">
            Champions can use Jack and demonstrate it with their organization's
            permitted content. They cannot manage invitations or administration.
          </p>
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={busy || !email.trim()}
          >
            {busy
              ? "Checking..."
              : pending
                ? "Check delivery / retry request"
                : "Send invitation"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Invitations</h2>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            organizations.length
              ? setRevision((value) => value + 1)
              : setReload((value) => value + 1)
          }
        >
          Refresh
        </Button>
      </div>
      <ul className="space-y-3">
        {invitations
          .filter((item) => item.organizationId === organizationId)
          .map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
            >
              <div className="min-w-0">
                <p className="break-all font-medium">{item.email}</p>
                <p className="text-sm text-muted-foreground">
                  {item.role} / {item.status} / delivery {item.deliveryStatus}
                </p>
                <p className="text-xs text-muted-foreground">
                  Expires {new Date(item.expiresAt).toLocaleString()}
                </p>
              </div>
              {item.status !== "revoked" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void revoke(item)}
                  aria-label={`Revoke ${item.status === "accepted" ? "access" : "invitation"} for ${item.email}`}
                >
                  {item.status === "accepted"
                    ? "Revoke access"
                    : "Revoke invitation"}
                </Button>
              )}
            </li>
          ))}
      </ul>
    </main>
  );
}
