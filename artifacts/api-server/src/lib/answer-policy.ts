const NAVIGATION_REFUSAL_PATTERN =
  /\b(?:i\s+(?:can(?:not|['’]?t)|cannot|am\s+unable\s+to|(?:do\s+not|don't|don['’]t)\s+have\s+(?:the\s+)?(?:ability|capability)\s+to|am\s+not\s+able\s+to)|i['’]m\s+(?:unable\s+to|not\s+able\s+to|can(?:not|['’]?t)))\s+(?:navigate|access|open|go\s+to|retrieve|find|locate)\b[\s\S]{0,220}?\b(?:library|libraries|section(?:s)?|source(?:s)?|video(?:s)?|living\s+memory|memory\s+graph|interview|review)\b/i;

const OFFICE_FILLER_PATTERNS = [
  /\b(?:please\s+)?let me know(?:\s+(?:what you need|how i can help|if you need anything|if that helps|when you(?:'re| are) ready))?[.!?]*/gi,
  /\b(?:i can|i['’]m here to|i am here to)\s+(?:help\s+)?(?:answer questions|provide information)(?:\s+or\s+(?:answer questions|provide information))?(?:\s+(?:about|on|with)\s+(?:welding topics|your questions|general information))?[.!?]*/gi,
  /\b(?:i can|i['’]m here to|i am here to)\s+(?:help|assist)(?:\s+(?:you\s+)?(?:with|on)\s+(?:welding topics|your questions|general information))[.!?]*/gi,
  /\b(?:i['’]m|i am)\s+(?:(?:here and ready to\s+)?(?:help|assist)|(?:happy|glad|pleased)\s+to\s+(?:help|assist))(?:\s+you)?[.!?]*/gi,
  /\b(?:i['’]d|i would) be happy to\b[.!?]*/gi,
  /\bhow may i assist(?: you)?[.!?]*/gi,
];

const NAVIGATION_REQUEST_PATTERN =
  /(?:\b(?:can you|do you|are you able to)\s+(?:navigat\w*|access|open|retriev\w*|find|locate|fetch)\b[\s\S]{0,100}?\b(?:library|libraries|section(?:s)?|source(?:s)?|video(?:s)?|living\s+memory|memory\s+graph|interview|review)\b|\b(?:navigat\w*|open|go\s+to|take me(?: to)?|bring me(?: to)?|show me|retriev\w*|find|locate|fetch|get)\b[\s\S]{0,100}?\b(?:library|libraries|section(?:s)?|source(?:s)?|video(?:s)?|living\s+memory|memory\s+graph|interview|review)\b|\b(?:where am i|go back|go up)\b)/i;

const NAVIGATION_RECOVERY =
  'Open Library from Jack\'s workspace menu to choose the video or section. With a selected source, say "show me the source" to open it.';

const FIELD_CONTEXT_RECOVERY =
  "Give me the operation, setup, and what changed.";

/**
 * Keep model output inside Jack's field voice contract at the response
 * boundary. Prompt rules still guide the model, but this last guard prevents a
 * stale or non-compliant completion from being rendered or spoken verbatim.
 */
export function sanitizeJackAnswer(raw: string, request = "") {
  // Preserve the model's useful punctuation and line breaks. The boundary
  // guard removes known filler; it should not rewrite field answers just to
  // normalize their presentation.
  let answer = raw.trim();

  // This failure mode was especially damaging for navigation: stripping the
  // final filler would leave a false claim that Jack cannot use its own app.
  // Replace the complete refusal with the concrete rendered-app next move.
  if (
    NAVIGATION_REQUEST_PATTERN.test(request) &&
    NAVIGATION_REFUSAL_PATTERN.test(answer)
  ) {
    return NAVIGATION_RECOVERY;
  }

  for (const pattern of OFFICE_FILLER_PATTERNS) {
    answer = answer.replace(pattern, " ");
  }

  answer = answer
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[,.;!?-]+\s*/, "")
    .replace(/[,:;]\s*$/, "")
    .trim();

  return answer || FIELD_CONTEXT_RECOVERY;
}
