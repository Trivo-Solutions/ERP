// Paths whose query string carries personal data (a customer's name / mobile number) and so must never reach the access log.
const REDACTED_QUERY_PATHS = /^\/api\/v\d+\/estimation\/customers\/?$/i; // Express matches case-insensitively and ignores a trailing slash, so must this

/** The URL as it may be logged: the query string of a sensitive path is replaced, every other URL is untouched. */
export function redactUrlForLog(url: string): string {
  const [path, query] = url.split('?', 2);
  return REDACTED_QUERY_PATHS.test(path) && query !== undefined ? `${path}?[redacted]` : url;
}
