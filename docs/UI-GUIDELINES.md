# UI layout guidelines

All UI threads follow the Vercel **Web Interface Guidelines** (the `web-design-guidelines` agent skill, which fetches the current rules when run): https://vercel.com/changelog/web-interface-guidelines-now-available-as-an-agent-command

Install: `npx skills add vercel-labs/agent-skills --skill web-design-guidelines`. Run it on every changed UI file before opening a PR and fix what it reports.

Rules that matter most here:
- A control placed over a card or dialog (close, download, remove) must have reserved space: pad the text beside it (for example `pr-8`) instead of letting it float over content.
- Text next to controls uses `min-w-0` plus `truncate` or `line-clamp-N`, with the full text in `title`/accessible name; never rely on clipping.
- Titles that can wrap use `leading-snug` or looser, never `leading-none`.
- Native OS and push notifications are laid out by the OS: keep the title short and the body a short plain sentence (see `completionNotificationPreview`).
- Check 320px, 1440px and long CJK/Latin strings before merging.

## Composition and motion

Adapted from the craft rules of Stageshow (MIT, github.com/benjitaylor/skills/tree/main/stageshow). They are written for marketing demos; these are the parts that hold for a real product screen.

- One subject per screen. The heaviest weight (size, ink, the one large number) sits on what the user acts on; everything else steps back.
- Say it once. A status, count or warning appears in one place, not in the header, the card and every row.
- Hierarchy comes from spacing and one weight step, not more cards, borders or badges. Add a border or badge only where it earns its place.
- Whitespace groups: a title sits closer to its own metadata than to the next item. Never spread rows evenly to fill a pane.
- Words keep at least a 12px inset from card and panel edges, and an 8 to 12px gap from neighbouring boxes. Edges that end 1 to 3px apart read as a mistake: align them exactly or separate them by at least 8px.
- A nested shape pads evenly, and its outer radius equals the inner radius plus that padding.
- Every motion has a cause. Content that changes moves or rolls instead of swapping; a new row pushes the rows below it; exits animate; data never jumps back without a visible reason.
- Loading shows a skeleton at the content's own size and position, resolving top to bottom, so nothing shifts when it arrives.
- An error sits on the field or item that caused it and clears when that is fixed. A confirmation appears on the control that was pressed.
- An answered question card stays in the thread as the record of the decision.
- AI work gets no sparkles, wands or purple. Show what the assistant did (found 12 people, verified 3 emails) instead of decorating it.
- Icons come from one set, at one size and one stroke weight per screen. Emoji are content, never icons.

Small UI fixes can be done with Sonnet or Haiku; they must read this file first.
