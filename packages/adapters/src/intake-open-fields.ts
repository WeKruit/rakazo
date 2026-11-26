/**
 * What the role's team is told before its first step (11-15 card tap 「先出前十个，再问」: search
 * first, then ask). Which facts the JD and the recruiter's words settle is the model's reading,
 * not a keyword list: branch d78fdeb7 asked again about "中文+英文工作语言" because no listed word
 * marked it as required.
 */
export const INTAKE_FIRST_STEP_NOTE =
  "The recruiter sees the first ten before any question: issue the calibration people searches now, in this first step, from the JD and their words as written, with no question, role read or assessment first, and beside them in that same step one recruiting_role update whose brief.fields hold each stated requirement in their wording, so every person found is checked on it. Whatever the JD and their words state (place and work mode, years, languages, skills) is settled: search for it as stated, never ask about it or ask them to confirm it, and keep anyone who plainly misses it out of the ten. After the ten are recorded, the card beside them may ask the one fact still open that would change who is searched for, if there is one; never before.";
