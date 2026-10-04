export const DESIGN_BRIEF_ATTACHMENT = 'tastecode://design-brief-v1'
const LEGACY_DESIGN_BRIEF_ATTACHMENT = 'personal-harness://design-brief-v1'

export function isDesignBriefAttachment(path: string): boolean {
  return path === DESIGN_BRIEF_ATTACHMENT || path === LEGACY_DESIGN_BRIEF_ATTACHMENT
}
