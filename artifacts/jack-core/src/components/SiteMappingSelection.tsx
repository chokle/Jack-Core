import { createContext, useContext, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

type Selection = { siteId: string; scanId: string };
const emptySelection: Selection = { siteId: "", scanId: "" };
const SelectionContext = createContext<{
  selection: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
} | null>(null);

function readSelection(key: string): Selection {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (typeof saved?.siteId === "string" && typeof saved?.scanId === "string")
      return { siteId: saved.siteId, scanId: saved.scanId };
  } catch {
    // Storage is optional; authorized sites and scans are always revalidated.
  }
  return emptySelection;
}

/** View intent only. Private spatial data stays in the existing site API/R2 path. */
export function SiteMappingSelectionProvider({
  actorId,
  children,
}: {
  actorId: string;
  children: ReactNode;
}) {
  const key = `jack.site-mapping.selection.v1:${actorId}`;
  const [selection, setSelection] = useState(() => readSelection(key));
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(selection));
    } catch {
      // Navigation still shares selection when browser storage is unavailable.
    }
  }, [key, selection]);
  return (
    <SelectionContext.Provider value={{ selection, setSelection }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSiteMappingSelection() {
  const shared = useContext(SelectionContext);
  const [selection, setSelection] = useState(emptySelection);
  return shared ?? { selection, setSelection };
}
