export const DESIGN_BRIEF_ATTACHMENT = 'personal-harness://design-brief-v1'

export function addDesignBriefing(attachments: string[]): string[] {
  return attachments.includes(DESIGN_BRIEF_ATTACHMENT)
    ? attachments
    : [...attachments, DESIGN_BRIEF_ATTACHMENT]
}
