// Removes every trailing `char` from `value` in linear time. A regex such as
// /\/+$/ backtracks quadratically on a long run of that character that isn't
// at the end, which code scanning reports as ReDoS on user-supplied input.
export function stripTrailing(value: string, char: string): string {
  if (char.length !== 1) throw new Error('stripTrailing expects a single character')
  let end = value.length
  while (end > 0 && value[end - 1] === char) end--
  return value.slice(0, end)
}

// Removes every leading and trailing `char` from `value`, in linear time.
export function trimChar(value: string, char: string): string {
  const tail = stripTrailing(value, char)
  let start = 0
  while (start < tail.length && tail[start] === char) start++
  return tail.slice(start)
}
