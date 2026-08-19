/**
 * Reduces a provider error to the sentence worth reading.
 *
 * Gemini answers a quota refusal with a JSON document carrying help links, four repeated
 * quota-violation objects and retry metadata — around 1,500 characters. Three of those in
 * one cycle report buried every other line, including the request counts that had just
 * been added to make the report legible.
 *
 * The `message` field is the part that says what happened; everything else is structure.
 */
export const MAX_PROVIDER_ERROR_LENGTH = 200;

export function summariseProviderError(
  detail: string,
  maxLength: number = MAX_PROVIDER_ERROR_LENGTH,
): string {
  const message = extractMessage(detail);
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/** Prefers a parsed `error.message`, falls back to a regex, then to the raw text. */
function extractMessage(detail: string): string {
  const start = detail.indexOf("{");
  if (start !== -1) {
    try {
      const parsed: unknown = JSON.parse(detail.slice(start));
      const message = (parsed as { error?: { message?: unknown } })?.error?.message;
      if (typeof message === "string" && message.trim().length > 0) return message;
    } catch {
      // Not JSON, or JSON with a prefix that broke the slice; the regex below still helps.
    }
  }
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail);
  const captured = match?.[1];
  if (captured !== undefined && captured.length > 0) return captured.replace(/\\n/g, " ");
  return detail;
}
