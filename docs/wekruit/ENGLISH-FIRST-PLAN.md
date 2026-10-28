# English-first product language

The recruiting product speaks English. The user asked for the whole product to be English, so English no longer just follows the recruiter's language. Chinese remains available in two ways: a recruiter who picks 简体中文 in the language menu gets the Chinese UI, and a recruiter who explicitly asks the agent to use Chinese gets Chinese replies.

This replaces the earlier project rule "Chinese titles and buttons".

## Behavior

- **UI.** A visitor sees English unless they picked another language in the language menu. A saved choice wins.
- **Agent replies.** Everything the recruiter sees is written in English: replies, cards, questions, progress, summaries, brief labels and emails. This holds even when the recruiter or the JD is written in Chinese. Another language is used only when the recruiter explicitly asks for it. `RECRUITER_LANGUAGE` in `packages/core/src/recruiting-defaults.ts` carries this rule to every recruiting run.
- **Server-written text** is English: auto-continue notes, stop messages, list headers, the next-step card, the send-confirmation card, stage and step labels, connect cards and Dashboard action prompts. No `chinese ?` branches remain that decide output text.
- **Parsers keep accepting Chinese input.** Regexes that read 至今, 符合, 发送, 新岗位: and similar stay. They read human or model text and do not decide output language. The vendor-name filter still writes Chinese plain words inside Chinese model text, so a reply the recruiter asked for in Chinese stays readable.

## Work items

| ID | Area | Status |
| --- | --- | --- |
| L1 | Web default locale | done |
| L2 | Playbook step labels and prompts | done |
| L3 | Auto-continue and stop messages | done |
| L4 | Next-step card and server-suggested prompts | done |
| L5 | Send-approval card body | done |
| L6 | Plain names for vendors in recruiter text and connect cards | done |
| L7 | Default search-filter statement and other `chinese ?` branches | done |
| L8 | Chinese examples inside English prompts and tool schemas | done |
| L9 | Unit tests updated; acceptance harnesses still use their Chinese briefs | partly |
| L10 | Project rules (memory) | done |

### L1 — Web default locale

- `infra/modal/app.py` built the web app with `VITE_DEFAULT_UI_LOCALE=zh-CN`. That forced Chinese on every visitor who had not picked a language, whatever their browser language. It is now `en`.
- A saved choice in `localStorage` (`rakazo.uiLocale`) still wins. The env default is never written to storage. So everyone who did not choose explicitly sees English after the next release, and anyone who picked 简体中文 keeps it.
- Acceptance: a fresh browser profile opens English. Picking 简体中文 in the language menu switches the whole UI, and the choice survives a reload.

### L2 — Playbook step labels and prompts

`packages/core/src/recruiting-playbook.ts`

- `recruitingPlaybookStageLabels` (岗位录入 … 已关闭) should be English. If a label is shown to a recruiter (the Dashboard or progress lines), render it through the web i18n catalog (Lingui `t`) instead of a core constant. Check every caller first.
- `nextPlaybookStep` labels and prompts ("开始校准搜寻", "收集校准反馈", "规模化搜寻" …, and `NEXT_STEP_CARD`) are model instructions. Translate them to English and keep the meaning exactly: order, the ten-person calibration, approve/feedback rules, and the "do not search when the recruiter said only use my list" rule. Add "in the recruiter's language" where the step produces chat text.
- `turn-end-guard.ts` checks `step.label.includes("待确认问题")` to classify the reason. Replace this with a structured field on the step, such as `reason` or `stage === "intake"` with open clarifications, so it does not depend on label text.
- Acceptance: the existing playbook tests are updated, and a Chinese brief still produces Chinese clarifying questions.

### L3 — Auto-continue and stop messages

`packages/adapters/src/turn-end-guard.ts`

- `PROMISE_LABEL`, `AUTO_NOTE`, the continue prompt pieces, and the feedback-save retry prompt go to the model. Make them English.
- The stop messages posted to the recruiter go through `postAssistant` ("我先停在这里：已保存 N 位候选人 … 回复一句「继续」…"). They are visible text, so they follow `language`. English: "I've paused here: N candidates are saved, and "<step>" isn't finished yet. Reply "continue" and I'll pick it up."
- The candidate list header (`本轮 N 位人选`) and `未核实：` line (around line 206) follow `language`.
- Acceptance: unit tests cover both languages for each posted message. An English role never shows Chinese server text.

### L4 — Next-step card and server-suggested prompts

- `packages/core/src/recruiting-defaults.ts` `RECRUITING_ROUND_NEXT_STEP` card: "下一步怎么做？…" with the options 找 100 个类似的人 / 先准备第一封邮件 / 再调一轮. Give English and Chinese variants selected by `language`. English: "What's next? You can also give feedback on anyone or the overall direction." with the options "Find 100 similar people" / "Draft the first email" / "Run another round". Make sure any code that matches the chosen option (for example "find more" → scale) recognizes both languages.
- `apps/api/src/recruiting.ts` around lines 828–868: the `ask_agent` prompts ("为这个岗位准备第一封邮件" …) are sent as the recruiter's message when a button is pressed. Make them English, or build them from the web catalog on the client so they follow the UI locale.
- Acceptance: pressing each Dashboard action in the English UI sends an English request, and the agent answers in English.

### L5 — Send-approval card body

`packages/adapters/src/approval-ask.ts` (around lines 226–249): 岗位 / 发件人 / 收件人 / 发送时间 / 主题 / 正文 / 还没有邮件内容. Follow `language`, English by default: Role / From / To (n) / Send time / Subject / Body / "No email content yet". This card is an exact external-send confirmation, so change only the labels. Recipients, content, time and scope must stay exactly as they are.

### L6 — Plain names for vendors in recruiter text

`packages/core/src/vendor-names.ts` and `RECRUITER_LANGUAGE` in `recruiting-defaults.ts`.

- `RECRUITER_LANGUAGE` lists Chinese plain words (人才搜索, 资料库, 邮件活动, 收件箱, 日历, 候选人, 联系人, 第一封邮件 …). Give English equivalents first (people search, profile data, campaign → "email sequence", inbox, calendar, candidates, contacts, first email, replies, interview), and say "use the recruiter's language".
- `vendor-names.ts` already picks `zh` vs English by CJK. Check that the English path has a plain name for every vendor and never falls back to the vendor name.
- Acceptance: the existing vendor-name tests still pass, and an added English case passes.

### L7 — Default search-filter statement and other `chinese ?` branches

- `packages/adapters/src/executor.ts` around line 5370 already branches on `chinese` for the tenure filter. Make sure `chinese` comes from the same per-turn `language` (see "How the language is chosen"), not a separate guess.
- Grep for other `chinese ?` / CJK tests that pick output text, and route them through the same value.

### L8 — Chinese examples inside English prompts and tool schemas

These are model-facing. Change each example to English, or give both languages:

- `packages/contracts/src/recruiting.ts` ~1107 (「初创公司经历、曾任 Metrology Engineer」)
- `packages/core/src/recruiting-candidates.ts` ~28 (一作)
- `packages/adapters/src/builtin-tools.ts` ~651
- `packages/adapters/src/executor.ts` ~997–1023 doc comments. These are comments only, so change them only if you touch the code.

Keep the Chinese tokens in parsers: `quickOutput.ts`, `profile.ts`, `profileTimelineModel.ts`, `send-instruction.ts`, `match-score.ts`, the role lead-in regex in `executor.ts`, and `DetailPanel.tsx` / `RecruitingPanel.tsx` matchers.

### L9 — Tests, e2e and acceptance harness defaults

- Unit tests that assert Chinese server text should assert English by default, plus one Chinese case per writer.
- `apps/web/e2e/onboarding-conversation.spec.ts` and `ui-locale.spec.ts`: keep the zh-CN picker test, and add an assertion that the default is English.
- `infra/acceptance/recruiting-latency.mjs` and `first10-suite.mjs`: allow an English brief, and make English the default brief. Keep a Chinese brief case.

### L10 — Project rules and docs

- Project memory: replace "Chinese titles and buttons" with "English-first; Chinese when the recruiter writes Chinese or picks 简体中文". The coordinator owns memory.
- `AGENTS.md` does not require Chinese, so no change is needed there. `docs/wekruit/PLAN.md` and `PRODUCT-SCOPE.md` are Chinese planning docs. Leave them; they are not product text.

## Acceptance

1. A fresh browser and a new role: every visible word in chat, cards, Dashboard, progress, stop/continue messages and the send-confirmation card is English, whether the JD and replies are written in English or Chinese.
2. A recruiter who explicitly asks the agent to reply in Chinese gets Chinese replies. Server text stays English.
3. Picking 简体中文 in the language menu still switches the UI chrome.
4. Saved candidates, feedback and approvals are unaffected. The first10 suite still passes.

The item notes above record the original audit. Where they say "follow the recruiter's language", the shipped rule is English.
