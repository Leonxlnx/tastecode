/** A phase's final answer as JSON, with or without one surrounding Markdown fence. */
export function parsePhaseJson(text: string): unknown {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim())
  return JSON.parse(fenced?.[1] ?? text)
}
