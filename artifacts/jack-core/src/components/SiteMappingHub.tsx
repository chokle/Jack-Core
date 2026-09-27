import { useEffect, useRef, useState } from "react";
import {
  createSiteMappingSite,
  getDownloadSiteMappingScanUrl,
  listSiteMappingOrganizations,
  listSiteMappingScans,
  listSiteMappingSites,
  recoverSiteMappingManager,
  uploadSiteMappingScan,
  type SiteMappingOrganization,
  type SiteMappingScan,
  type SiteMappingSite,
  type SiteMappingSiteRecord,
} from "@workspace/api-client-react";
import { SiteScanViewer } from "./SiteScanViewer";

function requestError(cause: unknown, fallback: string): string {
  const responseError = (cause as { data?: { error?: unknown } } | null)?.data
    ?.error;
  return typeof responseError === "string" && responseError.trim()
    ? responseError
    : cause instanceof Error
      ? cause.message
      : fallback;
}

/** Explicitly shared site captures. Local AR coordinates are not registered to a site map. */
export function SiteMappingHub({
  capturedCount = 0,
  captureBlob,
  showPreview = true,
}: {
  capturedCount?: number;
  captureBlob?: () => Blob | null;
  showPreview?: boolean;
}) {
  const [sites, setSites] = useState<SiteMappingSite[]>([]);
  const [recoverableSites, setRecoverableSites] = useState<
    SiteMappingSiteRecord[]
  >([]);
  const [organizations, setOrganizations] = useState<SiteMappingOrganization[]>(
    [],
  );
  const [siteId, setSiteId] = useState("");
  const selectedSiteId = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scans, setScans] = useState<SiteMappingScan[]>([]);
  const [scansSiteId, setScansSiteId] = useState("");
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteOrg, setNewSiteOrg] = useState("");
  const [loading, setLoading] = useState(true);
  const [scansLoading, setScansLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selectedScanId, setSelectedScanId] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([listSiteMappingSites(), listSiteMappingOrganizations()])
      .then(([siteList, organizationList]) => {
        if (!active) return;
        setSites(siteList.sites);
        setRecoverableSites(siteList.recoverableSites ?? []);
        setOrganizations(organizationList.organizations);
        setSiteId((previous) => previous || siteList.sites[0]?.id || "");
        setNewSiteOrg(
          (previous) => previous || organizationList.organizations[0]?.id || "",
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(requestError(cause, "Could not load sites."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refreshScans(selectedId: string) {
    const result = await listSiteMappingScans(selectedId);
    if (selectedSiteId.current === selectedId) {
      setScansSiteId(selectedId);
      setScans(result.scans);
    }
  }

  useEffect(() => {
    selectedSiteId.current = siteId;
    if (!siteId) {
      setScans([]);
      setScansSiteId("");
      return;
    }
    let active = true;
    setScans([]);
    setScansSiteId("");
    setSelectedScanId("");
    setScansLoading(true);
    listSiteMappingScans(siteId)
      .then((result) => {
        if (active) {
          setScansSiteId(siteId);
          setScans(result.scans);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setScansSiteId(siteId);
          setError(requestError(cause, "Could not load site scans."));
        }
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
      const result = await createSiteMappingSite({
        organizationId: newSiteOrg,
        name: newSiteName.trim(),
      });
      setSites((previous) => [...previous, result.site]);
      selectedSiteId.current = result.site.id;
      setSiteId(result.site.id);
      setNewSiteName("");
      setNotice(`Site ${result.site.name} is ready for authorized scans.`);
    } catch (cause) {
      setError(requestError(cause, "Could not create site."));
    } finally {
      setBusy(false);
    }
  }

  async function uploadScan(source: Blob) {
    if (!site || !source || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await uploadSiteMappingScan(site.id, source);
      if (selectedSiteId.current === site.id)
        setNotice(
          `Scan uploaded to ${site.name}. Capture ${result.scanId.slice(0, 8)} is private to site members.`,
        );
      if (selectedSiteId.current === site.id) setSelectedScanId(result.scanId);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      try {
        await refreshScans(site.id);
      } catch {
        if (selectedSiteId.current === site.id)
          setError(
            "Scan uploaded, but the site capture list could not refresh. Reload this page to see it.",
          );
      }
    } catch (cause) {
      setError(requestError(cause, "Could not upload scan."));
    } finally {
      setBusy(false);
    }
  }

  const visibleScans = scansSiteId === siteId ? scans : [];
  const scansPending = !!siteId && (scansLoading || scansSiteId !== siteId);
  const selectedScan =
    visibleScans.find((scan) => scan.id === selectedScanId) ?? visibleScans[0];

  async function recoverManager(site: SiteMappingSiteRecord) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await recoverSiteMappingManager(site.id);
      setSites((previous) =>
        previous.some((item) => item.id === result.site.id)
          ? previous.map((item) =>
              item.id === result.site.id ? result.site : item,
            )
          : [...previous, result.site],
      );
      setRecoverableSites((previous) =>
        previous.filter((item) => item.id !== site.id),
      );
      selectedSiteId.current = site.id;
      setSiteId(site.id);
      setNotice(`Manager access restored for ${site.name}.`);
    } catch (cause) {
      setError(requestError(cause, "Could not restore site access."));
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
          Choose an authorized site to upload measured depth points. The 3D view
          shows one private, unaligned capture. It is not a surveyed site map.
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
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                    selectedSiteId.current = event.target.value;
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
            {recoverableSites.length > 0 && (
              <div>
                <strong>Sites needing a manager</strong>
                <ul>
                  {recoverableSites.map((item) => (
                    <li key={item.id}>
                      {item.name}{" "}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void recoverManager(item)}
                      >
                        Restore manager access
                      </button>
                    </li>
                  ))}
                </ul>
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
                {captureBlob && (
                  <button
                    type="button"
                    disabled={
                      busy ||
                      site.status !== "active" ||
                      site.role === "viewer" ||
                      capturedCount === 0
                    }
                    onClick={() => {
                      const source = captureBlob?.();
                      if (source) void uploadScan(source);
                    }}
                  >
                    {busy
                      ? "Uploading scan…"
                      : `Upload this scan to ${site.name} (${capturedCount} points)`}
                  </button>
                )}
                {site.status === "active" && site.role !== "viewer" && (
                  <div>
                    <label>
                      Upload a saved PLY
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".ply,application/octet-stream"
                        disabled={busy}
                        onChange={(event) =>
                          setFile(event.target.files?.[0] ?? null)
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !file || file.size > 25 * 1024 * 1024}
                      onClick={() => file && void uploadScan(file)}
                    >
                      {busy ? "Uploading scan…" : "Upload selected PLY"}
                    </button>
                    {file && file.size > 25 * 1024 * 1024 && (
                      <p role="alert">PLY exceeds the 25 MB limit.</p>
                    )}
                  </div>
                )}
                <h3>Site captures</h3>
                {scansPending ? (
                  <p role="status">Loading captures…</p>
                ) : visibleScans.length ? (
                  <ul>
                    {visibleScans.map((scan) => (
                      <li key={scan.id}>
                        {scan.point_count.toLocaleString()} points ·{" "}
                        {new Date(scan.uploaded_at).toLocaleString()} ·{" "}
                        <button
                          type="button"
                          aria-pressed={selectedScan?.id === scan.id}
                          disabled={!showPreview}
                          onClick={() => setSelectedScanId(scan.id)}
                        >
                          {showPreview ? "View 3D" : "Stop AR to view 3D"}
                        </button>{" "}
                        <a
                          href={getDownloadSiteMappingScanUrl(site.id, scan.id)}
                        >
                          Download PLY
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : !error ? (
                  <p>No scans uploaded to this site yet.</p>
                ) : null}
                {selectedScan && showPreview && (
                  <SiteScanViewer
                    key={`${site.id}:${selectedScan.id}`}
                    siteId={site.id}
                    scan={selectedScan}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
