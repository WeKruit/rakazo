import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatMarkdown, LinkifiedText } from "./lazy.web";
import { LinkifiedText as FullLinks, ChatMarkdown as FullMarkdown } from "./markdown.web";

it.each(["Hello world.", "中文普通段落。", "1.5 million", " hello, world! ", "Plain text 123"])(
  "renders literal paragraphs identically without a parser: %s",
  (text) => {
    expect(renderToStaticMarkup(<ChatMarkdown>{text}</ChatMarkdown>)).toBe(
      renderToStaticMarkup(<FullMarkdown>{text}</FullMarkdown>),
    );
    expect(renderToStaticMarkup(<ChatMarkdown streaming>{text}</ChatMarkdown>)).toBe(
      renderToStaticMarkup(<FullMarkdown streaming>{text}</FullMarkdown>),
    );
    expect(renderToStaticMarkup(<LinkifiedText>{text}</LinkifiedText>)).toBe(
      renderToStaticMarkup(<FullLinks>{text}</FullLinks>),
    );
  },
);
it.each([
  "**bold**",
  "1. item",
  "    code",
  "www.example.com",
  "first\nsecond",
  "a@example.com",
  "<script>alert</script>",
])("keeps syntax and links on the full parser path: %s", async (text) => {
  renderToStaticMarkup(<ChatMarkdown>{text}</ChatMarkdown>);
  await vi.dynamicImportSettled();
  expect(renderToStaticMarkup(<ChatMarkdown>{text}</ChatMarkdown>)).toBe(
    renderToStaticMarkup(<FullMarkdown>{text}</FullMarkdown>),
  );
});
