import { useEffect, useState } from "react";

type Site = {
  id: string;
  organization_id: string;
  name: string;
  status: "active" | "archived";
  role: "manager" | "contributor" | "viewer";
};
type Organization = { id: string; name: string };
type Scan = {
  id: string;
  point_count: number;
  byte_size: number;
  uploaded_at: string;
};

async function jsonRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...options });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

/** Explicitly shared site captures. Local AR coordinates are not registered to a site map. */
export function SiteMappingHub({
  capturedCount,
  captureBlob,
}: {
  capturedCount: number;
  captureBlob: () => Blob | null;
}) {
  const [sites, setSites] = useState<Site[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [siteId, setSiteId] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteOrg, setNewSiteOrg] = useState("");
  const [loading, setLoading] = useState(true);
  const [scansLoading, setScansLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      jsonRequest<{ sites: Site[] }>("/api/site-mapping/sites"),
      jsonRequest<{ organizations: Organization[] }>(
        "/api/site-mapping/organizations",
      ),
    ])
      .then(([siteList, organizationList]) => {
        if (!active) return;
        setSites(siteList.sites);
        setOrganizations(organizationList.organizations);
        setSiteId((previous) => previous || siteList.sites[0]?.id || "");
        setNewSiteOrg(
          (previous) => previous || organizationList.organizations[0]?.id || "",
        );
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Could not load sites.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refreshScans(selectedId: string) {
    const result = await jsonRequest<{ scans: Scan[] }>(
      `/api/site-mapping/sites/${selectedId}/scans`,
    );
    setScans(result.scans);
  }

  useEffect(() => {
    if (!siteId) {
      setScans([]);
      return;
    }
    let active = true;
    setScans([]);
    setScansLoading(true);
    jsonRequest<{ scans: Scan[] }>(`/api/site-mapping/sites/${siteId}/scans`)
      .then((result) => {
        if (active) setScans(result.scans);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load site scans.",
          );
      })
      .finally(() => {
        if (active) setScansLoading(false);
      });
    return () => {
      active = false;
    };
  }, [siteId]);

  const site = sites.find((item) => item.id === siteId);

  async function createSite() {
    if (!newSiteName.trim() || !newSiteOrg || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await jsonRequest<{ site: Site }>(
        "/api/site-mapping/sites",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: newSiteOrg,
            name: newSiteName.trim(),
          }),
        },
      );
      setSites((previous) => [...previous, result.site]);
      setSiteId(result.site.id);
      setNewSiteName("");
      setNotice(`Site ${result.site.name} is ready for authorized scans.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create site.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadScan() {
    const file = captureBlob();
    if (!site || !file || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await jsonRequest<{ scanId: string }>(
        `/api/site-mapping/sites/${site.id}/scans/upload`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        },
      );
      await refreshScans(site.id);
      setNotice(
        `Scan uploaded to ${site.name}. Capture ${result.scanId.slice(0, 8)} is private to site members.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not upload scan.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="site-hud-entry site-hud-entry--location site-mapping-hub"
      aria-label="Shared site mapping"
    >
      <div>
        <strong>Shared site scans</strong>
        <p>
          Choose an authorized site to upload measured depth points. Captures
          stay separate until they can be aligned and reviewed. No combined 3D
          map is published yet.
        </p>
        {loading && <p role="status">Loading sites…</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!loading && (
          <>
            {sites.length ? (
              <label>
                Site{" "}
                <select
                  value={siteId}
                  onChange={(event) => {
                    setError("");
                    setSiteId(event.target.value);
                  }}
                >
                  {sites.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : !error ? (
              <p>No site is connected to your account.</p>
            ) : null}
            {organizations.length > 0 && (
              <div>
                <label>
                  New site name{" "}
                  <input
                    value={newSiteName}
                    maxLength={160}
                    onChange={(event) => setNewSiteName(event.target.value)}
                  />
                </label>
                <label>
                  Organization{" "}
                  <select
                    value={newSiteOrg}
                    onChange={(event) => setNewSiteOrg(event.target.value)}
                  >
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || !newSiteName.trim()}
                  onClick={() => void createSite()}
                >
                  Create site
                </button>
              </div>
            )}
            {site && (
              <>
                <p>
                  Access: {site.role}. Upload only scans you intend to share
                  with this site.
                </p>
                {site.status === "archived" && (
                  <p>This site is archived and cannot accept new scans.</p>
                )}
                <button
                  type="button"
                  disabled={
                    busy ||
                    site.status !== "active" ||
                    site.role === "viewer" ||
                    capturedCount === 0
                  }
                  onClick={() => void uploadScan()}
                >
                  {busy
                    ? "Uploading scan…"
                    : `Upload this scan to ${site.name} (${capturedCount} points)`}
                </button>
                <h3>Site captures</h3>
                {scansLoading ? (
                  <p role="status">Loading captures…</p>
                ) : scans.length ? (
                  <ul>
                    {scans.map((scan) => (
                      <li key={scan.id}>
                        {scan.point_count.toLocaleString()} points ·{" "}
                        {new Date(scan.uploaded_at).toLocaleString()} ·{" "}
                        <a
                          href={`/api/site-mapping/sites/${site.id}/scans/${scan.id}/download`}
                        >
                          Download PLY
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : !error ? (
                  <p>No scans uploaded to this site yet.</p>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
