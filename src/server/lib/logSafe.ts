// Text for a log line that came from outside the server (a request, a header,
// an upstream error message). Line breaks are removed so a value can't start a
// forged log entry, and long values are cut off. An Error logs as its message.
const MAX_LOG_VALUE_LENGTH = 1000

export function logSafe(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/\n/g, '').replace(/\r/g, '').slice(0, MAX_LOG_VALUE_LENGTH)
}
