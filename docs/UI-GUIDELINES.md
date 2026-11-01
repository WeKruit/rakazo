# UI layout guidelines

All UI threads follow the Vercel **Web Interface Guidelines** (the `web-design-guidelines` agent skill, which fetches the current rules when run): https://vercel.com/changelog/web-interface-guidelines-now-available-as-an-agent-command

Install: `npx skills add vercel-labs/agent-skills --skill web-design-guidelines`. Run it on every changed UI file before opening a PR and fix what it reports.

Rules that matter most here:
- A control placed over a card or dialog (close, download, remove) must have reserved space: pad the text beside it (for example `pr-8`) instead of letting it float over content.
- Text next to controls uses `min-w-0` plus `truncate` or `line-clamp-N`, with the full text in `title`/accessible name; never rely on clipping.
- Titles that can wrap use `leading-snug` or looser, never `leading-none`.
- Native OS and push notifications are laid out by the OS: keep the title short and the body a short plain sentence (see `completionNotificationPreview`).
- Check 320px, 1440px and long CJK/Latin strings before merging.

Small UI fixes can be done with Sonnet or Haiku; they must read this file first.
