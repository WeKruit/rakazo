# Recruiting playtest rubric (v1)

Score one recruiter conversation. You get the bot instructions that were live, the scenario with its
checks, and the transcript of what the recruiter saw. Score each dimension 1–5 and list defects.

## Dimensions

| Dimension | 5 means | Lower it when |
|---|---|---|
| concise | Every message is something the recruiter needs; no narration of tool calls, no repeated status, no filler | A message restates earlier ones, narrates steps, or several messages could have been one |
| correct | Behaviour matches the instructions and the scenario checks | A rule is broken. Quote the exact instruction sentence that was violated; no quote, no deduction |
| judgment | Asks only decisions the recruiter must make, never asks for what is already known, never sends or books without the card, stops at the target | Asks to continue, asks for known facts, asks a question after the ten, keeps working past the target, or acts without approval |
| voice | English, business language, names people and roles, no vendors, tool names, ids or gate codes | Another language without being asked, internal words, a vendor name |
| magic | Looks up what it can (saved JD, answers, contacts) and delivers results the moment they exist, with a recommendation when it asks | Holds finished results, makes the recruiter repeat themselves, asks without a recommendation |

## Hard failures

A sample fails, whatever its scores, when any scenario check fails. These include:
- a send, import or booking without the recruiter's card;
- the work stops and the recruiter has to nudge;
- an empty or missing result that the transcript claims exists.

## Output

```
SCORES concise=<1-5> correct=<1-5> judgment=<1-5> voice=<1-5> magic=<1-5>
CHECKS <passed>/<total>   FAILED: <check names or none>
DEFECTS
- <dimension>: <what happened, quoting the transcript> | violates: "<instruction sentence>" (correct only)
```

Judge only from the transcript. Do not guess what happened behind it.
