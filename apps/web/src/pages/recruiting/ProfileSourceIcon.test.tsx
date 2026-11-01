import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProfileSourceIcon } from "./ProfileSourceIcon";

it("identifies supplied source hosts without branding a deceptive host or changing its URL", () => {
  for (const [href, color] of [
    ["https://www.linkedin.com/in/example", "#0A66C2"],
    ["https://github.com/example", "#181717"],
    ["https://stackoverflow.com/users/123/example", "#F48024"],
    ["https://example.test/portfolio", null],
    ["https://linkedin.com.example.test/in/example", null],
  ] as const) {
    const html = renderToStaticMarkup(
      <a href={href}>
        <ProfileSourceIcon href={href} />
        Profile
      </a>,
    );
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('aria-hidden="true"');
    if (color) expect(html).toContain(`fill="${color}"`);
    else expect(html).toContain("lucide-globe");
  }
});
