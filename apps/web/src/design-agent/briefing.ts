export const DESIGN_BRIEF_ATTACHMENT = 'tastecode://design-brief-v1'
const LEGACY_DESIGN_BRIEF_ATTACHMENT = 'personal-harness://design-brief-v1'

function isDesignBriefAttachment(path: string): boolean {
  return path === DESIGN_BRIEF_ATTACHMENT || path === LEGACY_DESIGN_BRIEF_ATTACHMENT
}

export function addDesignBriefing(attachments: string[]): string[] {
  return [...attachments.filter((path) => !isDesignBriefAttachment(path)), DESIGN_BRIEF_ATTACHMENT]
}
