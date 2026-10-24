// Kept apart from services.ts so listing eval cases never loads runtime adapters.
/** Synthetic English intake material, not retained production JD content. */
export const RECRUITING_INTAKE_FIXTURES = {
  complete:
    "Example Labs needs a backend engineer with 5+ years of production experience. Remote within the UK. The approved outreach salary range is GBP 90,000 to 120,000. Distributed systems are preferred. The hiring company can be named. No deck is available. Replies remain drafts.",
  vague:
    "Example Labs needs a great engineer. Work setup and the outreach salary range have not been decided.",
  conflicting:
    "JD: Work in the London office five days per week. Recruiter: We discussed remote within the UK. That conflict has not been resolved. The outreach range is GBP 90,000 to 120,000.",
  answered:
    "Prior question: What location and salary should be used? Human answer: Remote within the UK; GBP 90,000 to 120,000 may be stated. Reuse this answer. Example Labs needs a backend engineer. Distributed systems are a preference, not a rejection rule.",
} as const;
