# Vendored Superpowers skills

These skill folders are copied unmodified from [obra/superpowers](https://github.com/obra/superpowers)
(MIT, see `SUPERPOWERS-LICENSE`) at commit `22f0b463e7a5e579904dd6211a520321035526f7`:

- `writing-plans`
- `test-driven-development`
- `systematic-debugging`
- `verification-before-completion`
- `requesting-code-review`
- `receiving-code-review`

`composio` and `pr-watch` are this repository's own. Project rules that override or add to the
skills live in `AGENTS.md` under "Development standard", never as edits here, so an update is a plain
re-copy:

```bash
git clone --depth 1 https://github.com/obra/superpowers /tmp/superpowers
for s in writing-plans test-driven-development systematic-debugging \
  verification-before-completion requesting-code-review receiving-code-review; do
  rm -rf ".agents/skills/$s" && cp -r "/tmp/superpowers/skills/$s" .agents/skills/
done
```
