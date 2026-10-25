# Evidence ledger

## Evidence levels

- **S — direct static inspection:** exact repository/commit/path was read by this research task.
- **H — historical record:** an existing handoff records tests or a business observation; not rerun here.
- **O — source-owner observation:** a coordinating reviewer inspected UI or private artifacts and supplied a sanitized observation. The author of this checkout must not claim to have opened the original.
- **P — directly inspected offline payload:** reserved for original bytes actually inspected by the relevant reviewer, with byte count/hash and source binding. A sanitized report about that inspection remains O for this checkout.
- **I — inference:** a plausible implication or proposed test, explicitly distinguishable from a fact.
- **U — unknown:** missing evidence, not an automatic failure or mismatch.

## Source index

| ID | Evidence | Level / version | Supports | Does not support |
| --- | --- | --- | --- | --- |
| S1 | Original main audit | S, f87403562e8dce0973e615e066e0c9451fdf14a3, 16:54 UTC | Exact feedback wording; helper/native and output-column facts at that revision | Current runtime behavior or later-main regression |
| S2 | Nine-stage audit | S/H, 3f02c76a3bf25e5d2d5f7d1e639eb95908e3256b, 17:11 UTC | Implementation presence and separately recorded validation limits | Full live stage acceptance |
| S3 | Latest baseline and #115 | S, 5c210b626c22ab2f1ecd34836c216b52e197bcd6 | Main quick search, search brief, A/B rules and default changes | Same-role quality improvement or actual prompt adoption |
| S4 | Legacy gateway | S, headhunter-agent 186dacdabb43ecc488b85a140dfebb632ac23dc2 | Codex-only runtime registration and Grok compatibility code | Actual Grokbot provider/model |
| S5 | Legacy mock path | S, headhunter-agent 11ca9c2df226782eee241fc5b36ba15600f4efcb | Mock composition and local scoring path exist | Real Autumn behavior |
| H1 | PLAN archive section | H, exact source links retained in snapshot report | Historical export was reported complete; two CSVs archived to Sourcer messages | Exact archive filenames/IDs, current source coverage, latest Grok session |
| H2 | Development handoff | H, checkpoints including 98e7d490 and 861dba93 | Reported scoped synthetic/PG/browser results and disclosed failures | Current main or production passes |
| H3 | Historical controlled email | H, 2026-10-23 handoff around v123 | First email approved/sent/received; inbound reply read; stop-on-reply | Product-side subsequent reply or current whole-loop completion |
| O1 | Source Grokbot session / Sourcer UI | O, six complete sanitized reports read through Library | Template visible at 12:00:45 PM, zone unknown; separate first round of 11 followed by changed criteria | Provider acceptance, same Dyna run, exact model or UTC time |
| O2 | Existing Dyna offline request/output | O here; full comparison/index/mechanical verification read; original bytes inspected by source owner | Reported Main → Sourcer → native MCP route; accepted timestamp and aggregate output findings | Current production or matched Grok comparison |
| O3 | Grok batch messages | O, owner summary | Batches 6/7 are self-reported sends; 10/14 are copyable drafts | Verified Autumn execution for those messages |
| U1 | Exact paired Grok wire request/result | U | A concrete remaining evidence gap | Permission to start new paid research |
| U2 | Per-run model and cost adoption | U unless original same-run record supplies it | No model winner or budget-efficiency claim yet | Brand, UI title, runtime class or current code as a substitute |

Internal session/task identifiers and private storage references are retained by their owner, not committed. Record labels above are public-safe aliases.

## Evidence that changes earlier conclusions

1. Additional profile columns in S1 invalidate the oversimplified “only seven fields requested” claim, while leaving actual provider return unknown.
2. S2/S3 changed calibration ownership and search defaults; S1's old Sourcer feedback sentence is historical.
3. O1/O2 are different roles/runs. Their numbers or prompt snippets cannot be combined to manufacture a head-to-head comparison.
4. A retained provider row can have contradictory explanation and labels. Preservation proves what was returned; it does not validate that reasoning.
5. A title-matching result, missing source, failed fetch and actual counterevidence are distinct states.

## Six-report transfer and final boundary

The complete text of these owner-authored v0 reports was read: GROK-AUTUMN-LOCAL-FINDINGS, GROK-AUTUMN-EVIDENCE-INDEX, DYNA-GROK-RAKAZO-COMPARISON, DYNA-COMPARISON-SOURCES, DYNA-OFFLINE-VERIFICATION and DYNA-TOOLTRACE-BOUNDARY (all dated 2026-10-25). The two source indexes cover 23 and 33 entries, with overlap; the mechanical verification covers 17 original files. Public-safe digests are in [source-metadata.json](source-metadata.json), and attributed results in [offline-verification.json](offline-verification.json).

Official materialization preparation succeeded, but the first helper download failed and was not retried. Library full-text reads all returned has_more=false; readable local text copies were produced outside the repository. Each rendered copy is one byte smaller than Library's original size, so no original-byte materialization or original-file hash verification is claimed. Source-owner raw candidate files were never transferred to this checkout or published.

O1–O3 now include the complete reports, not only the initial summary. They remain owner-observed evidence for original UI/raw files; this author directly read only the sanitized reports. The final source report records an automatic approval denial for entering batch06 in Grok Search because it could trigger a search. That action is known not to have executed, was not retried and is closed. It supersedes earlier no-blocker language; it is separate from this PR's pending CI publication decision.

Exact underlying LLM models and a matched Grok wire request/raw output pair remain unknown. R1's provider runtime/opaque version, dates and prompt hash are documented in the case report and must not be interpreted as a model/tier identity.
