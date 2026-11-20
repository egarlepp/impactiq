// Escape a user-supplied string for inclusion inside a single-quoted SOQL literal.
// Backslash MUST be escaped before the single-quote, otherwise input like `x\`
// closes the string when we naively double the quote: `LIKE '%x\%'` breaks out.
export function safeSoqlLiteral(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
