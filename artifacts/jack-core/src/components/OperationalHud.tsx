import { useOperationalState } from "../lib/operational-state";

const label = (value: string) => value.replaceAll("_", " ");

/** Field projection only, even when the signed-in account is an administrator. */
export function OperationalHud({ userId }: { userId: string }) {
  const { state, unavailable } = useOperationalState(userId);
  return (
    <section
      aria-label="Jack operational state"
      className="shrink-0 border-b border-sidebar-border bg-sidebar/85 px-4 py-2 text-xs"
    >
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap gap-x-4 gap-y-1"
      >
        <strong>Jack</strong>
        {!state ? (
          <span>
            {unavailable
              ? "Operational state unavailable"
              : "Loading operational state…"}
          </span>
        ) : (
          <>
            <span>{label(state.lifecycle)}</span>
            <span>
              Connection:{" "}
              {state.connectivityObserved
                ? state.connectivity
                : "no observation"}
            </span>
            <span>Authority: {label(state.authority)}</span>
            <span>Confidence: {label(state.confidence)}</span>
            <span>
              Crew:{" "}
              {state.crewObserved
                ? label(state.crewAwareness)
                : "no observation"}
            </span>
            <span>Priority: {state.priority}</span>
          </>
        )}
      </div>
      {state?.safetyAlert && (
        <p role="alert" className="mt-1 font-semibold text-destructive">
          Safety alert — attention required.
        </p>
      )}
    </section>
  );
}
