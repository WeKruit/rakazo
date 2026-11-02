import { JSDOM } from "jsdom";

export function htmlToPlainText(html: string): string {
  const content = JSDOM.fragment(html);
  for (const node of content.querySelectorAll("script,style,noscript,template,title"))
    node.remove();
  for (const node of content.querySelectorAll("a[href]")) {
    const url = URL.parse(node.getAttribute("href") ?? "");
    if (
      url &&
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      URL.parse(node.textContent?.trim() ?? "")?.href !== url.href
    )
      node.append(` (${url.href})`);
  }
  for (const node of content.querySelectorAll("br")) node.replaceWith("\n");
  for (const node of content.querySelectorAll("p,li,div,h1,h2,h3,h4,h5,h6,blockquote,tr")) {
    node.prepend("\n");
    node.append("\n");
  }
  for (const node of content.querySelectorAll("td,th")) node.append("\t");
  return normalizeArticleText(content.textContent ?? "");
}

export function normalizeArticleText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
