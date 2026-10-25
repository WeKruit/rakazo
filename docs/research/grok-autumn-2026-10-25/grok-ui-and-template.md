# Grok UI and user template

## Observed source boundary

The coordinating reviewer located the real session titled **Connect frontend to Grok agent** and reported inspecting its Sourcer UI. This is the user's project, not an unrelated public bot with the same name. This checkout has the owner's summary so far; it has not viewed those UI pixels or opened the original private export.

Owner-reported observations:
- A Sourcer template was visible with the UI time **12:00:45 PM**. The display timezone is unknown; do not convert it to UTC.
- A separate role's first round contained **11 people**, followed by criteria changes. It is **not the Dyna offline run**.
- Messages for batches **6/7** self-report that requests were sent. Messages for **10/14** provide copyable drafts. Neither type alone proves a completed provider execution.
- No supplied evidence currently establishes a hidden OR → AND change or a single-person feedback silently requesting additional people in the Dyna run.

## Template: do not merge three different things

1. The original user-provided template, to be transcribed only from the transferred sanitized source.
2. A template visible in Grokbot's UI, with its date/timezone and “draft vs sent” status.
3. Rakazo's template merged in #115 at `5c210b626c22ab2f1ecd34836c216b52e197bcd6`.

The third is directly inspectable in [current source](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/core/src/recruiting-defaults.ts#L19): titles, core-duty quotes, years, ordered locations, language evidence, exclusions and A/B output. That proves what this code instructs. It does not prove byte-identical adoption from the user's original template, successful execution in Grokbot, or improved quality.

The exact sanitized user template and its source-owner report are pending transfer. Do not reconstruct them from #115's implementation, old playbook descriptions, or a different role.

## What comparison becomes possible

Once the authorized source is supplied, compare:
- original human wording and confirmed hard/preferred/excluded scope;
- tool instructions versus the actual provider request bytes;
- title/company matching versus explicit duty evidence;
- calibration size versus requested provider output count;
- what feedback changed, what stayed unchanged, and whether the same task was continued;
- requested grade/output fields versus raw returned values and display.

This is an offline comparison plan, not authorization for a new search or modifying the upstream bot.
