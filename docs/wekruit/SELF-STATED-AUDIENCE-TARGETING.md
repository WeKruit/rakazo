# Self-stated audience targeting

Requirements for a marketing or sourcing campaign audience built only from what a person states about themselves on their own public profile. Status: requirements and review notes. No code, no live role changes, no sends.

## Why

Recruiters ask for audiences such as "Asian students and alumni of a school". The product must not guess a person's ethnicity or race. It can match facts a person chose to publish about themselves, quote where each fact came from, and leave everyone else out of the audience without labeling them.

## Scope

An audience is a saved search description attached to a role or campaign. Sourcer forwards it to Autumn as ordinary search context, the same way it forwards a JD. Autumn owns matching and returns the evidence for each person. The product stores the result and the quoted evidence. No local classifier, scorer or rules engine is added (AGENTS.md principles 2 and 4).

## Criteria

A person matches when their own profile shows at least one of the following, and the recruiter chose that criterion for the audience. Each criterion is selectable on its own.

1. **Stated group membership.** The person lists membership, a role or volunteering in an Asian, Asian American or Asian cultural student, alumni, professional or community group. Examples: an Asian American Student Association, a Chinese, Korean, Indian, Vietnamese or Filipino student association, an Asian alumni network, an Asian professional society. The group name must appear in the person's own Experience, Activities, Volunteering or Organizations section.
2. **Stated language.** The person lists a language in their profile's Languages section, such as Mandarin, Cantonese, Korean, Japanese, Hindi, Tamil, Vietnamese, Tagalog or Thai. Language is a skill. It matches on the listing alone and says nothing about heritage.
3. **Stated school or work in Asia.** The person lists a school they attended or an employer location in an Asian country or region, in their own Education or Experience section.

Combining criteria (for example "USC alumni AND criterion 1") uses the recruiter's own wording, reflected back in plain language before the search starts. Hard requirements still apply as written in the role brief.

## Evidence

- Each matched person carries a short quote of the profile text that matched and the section it came from, for example "Languages: Korean (native or bilingual)".
- If the evidence cannot be quoted, the person is not in the audience. "Likely" or "probably" matches are not allowed.
- The audience label shown to recruiters names the criterion ("Lists Korean", "Member of an Asian alumni group"), never an ethnicity or race applied to the person.

## Never

- Infer ethnicity, race, national origin or religion from a name, surname, photo, face, voice, location alone, or any third-party "ethnicity" enrichment field.
- Store an inferred ethnicity or race on a person record, in memory, in a CRM field or in an export.
- Use these criteria to exclude, downgrade or rank anyone in a hiring decision. They decide who receives an invitation, not who is qualified.
- Tag people who did not match as "not Asian" or any similar negative label. They are simply not in this audience.

When a recruiter asks for name or photo based guessing, the agent explains in one line that it matches only what people state about themselves and offers the three criteria above.

## Acceptance

- A real request such as "USC Asian alumni" yields an up-front scope question offering the three criteria, then a result where every person has a quoted, section-labeled match.
- A spot check of returned people finds no match justified only by a name or photo.
- No inferred ethnicity or race field exists in stored results, CRM writes or exports.
- Outreach to the audience still goes through the existing send card with the exact recipients and content.

## Compliance review before use

Each item needs an owner's sign-off before an audience built this way is used for outreach. This list is not legal advice; counsel should review it.

1. **Anti-discrimination.** Language and school or work in a country can act as proxies for national origin, and group membership for race or ethnicity. In the US, Title VII and state laws (for example California FEHA) bar using these in hiring decisions. Confirm the campaign is an additive outreach or affinity invitation, that the role is open to all applicants, and that sourcing for the same role is not limited to this audience. Review the plan with counsel, especially for employers subject to OFCCP or similar rules, and keep a record of the campaign's purpose.
2. **Sensitive data.** Group membership can reveal racial or ethnic origin, which is special-category data under GDPR and sensitive personal information under CPRA. Confirm the lawful basis, whether the derived audience label may be stored at all, its retention period, and the notice owed to people contacted. Do not process EU or UK residents this way without a documented basis.
3. **Consent and notice.** Confirm what notice people receive about where their data came from, and that opt-out and deletion requests are honored across stored results, CRM and campaign tools.
4. **Outreach rules.** Follow CAN-SPAM, and for any recipient outside the US the applicable rules (CASL, GDPR/ePrivacy, PDPA). Each message needs an accurate sender, a physical address where required, and a working unsubscribe. Sends require the user's exact approval of recipients and content (AGENTS.md principle 6).
5. **Data source terms.** Confirm that the profile source and each enrichment provider permit this use, including targeting on profile sections and storage of quotes. Do not scrape where the terms forbid it. Respect each provider's rules on sensitive attributes.
6. **School and partner rules.** If the campaign uses a school or group name, confirm the school's or group's rules on use of its name and on contacting its students and alumni.
