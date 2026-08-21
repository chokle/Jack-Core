import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface Citation {
  videoTitle?: string;
  title?: string;
  text?: string;
  startTime?: number;
  sourceType?: string;
}

export interface PilotConversationExchange {
  participantId: string;
  askedAt: string;
  respondedAt: string | null;
  question: string;
  response: string | null;
  citations: Citation[];
}

interface PilotConversationReviewProps {
  organizationId: string;
  pilotId: string;
}

async function loadConversationReview(
  organizationId: string,
  pilotId: string,
): Promise<{ conversations: PilotConversationExchange[]; truncated: boolean }> {
  const query = new URLSearchParams({ organizationId, pilotId });
  const response = await fetch(`/api/testing/conversation-review?${query}`, {
    credentials: "include",
  });
  const body = (await response.json().catch(() => ({}))) as {
    conversations?: PilotConversationExchange[];
    truncated?: boolean;
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error || "Conversation review is unavailable.");
  return {
    conversations: body.conversations ?? [],
    truncated: body.truncated ?? false,
  };
}

export function PilotConversationReview({
  organizationId,
  pilotId,
}: PilotConversationReviewProps) {
  const [result, setResult] = useState<{
    conversations: PilotConversationExchange[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void loadConversationReview(organizationId, pilotId)
      .then((next) => active && setResult(next))
      .catch((reason) => {
        if (active) {
          setResult(null);
          setError(
            reason instanceof Error
              ? reason.message
              : "Conversation review is unavailable.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId, pilotId, refresh]);

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Consented conversation review
          </h2>
          <p className="text-sm text-muted-foreground">
            Canonical Ask Jack history for currently consented participants in
            this pilot only.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh conversations
        </Button>
      </header>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!error && result?.conversations.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No participants currently consent to review.
        </p>
      )}
      {result?.truncated && (
        <p className="text-sm text-amber-700">
          Only the first 1,000 canonical messages are shown.
        </p>
      )}

      <div className="space-y-3">
        {result?.conversations.map((exchange, index) => (
          <article
            key={`${exchange.participantId}:${exchange.askedAt}:${index}`}
            className="rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Participant: {exchange.participantId}</span>
              <time dateTime={exchange.askedAt}>
                Asked: {new Date(exchange.askedAt).toLocaleString()}
              </time>
              {exchange.respondedAt && (
                <time dateTime={exchange.respondedAt}>
                  Responded: {new Date(exchange.respondedAt).toLocaleString()}
                </time>
              )}
            </div>
            <p className="mt-3 text-sm font-medium">Question</p>
            <p className="whitespace-pre-wrap text-sm">{exchange.question}</p>
            <p className="mt-3 text-sm font-medium">Response</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {exchange.response ?? "No response was stored."}
            </p>
            {exchange.citations.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium">Citations</p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {exchange.citations.map((citation, citationIndex) => (
                    <li key={citationIndex}>
                      {citation.videoTitle ??
                        citation.title ??
                        citation.sourceType ??
                        "Source"}
                      {typeof citation.startTime === "number"
                        ? ` at ${Math.round(citation.startTime)}s`
                        : ""}
                      {citation.text ? ` — ${citation.text}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
