import { marked } from "marked";

/**
 * Allowlist of tags kept after markdown HTML generation.
 * Production chat uses this host-side sanitizer so the webview never
 * runs unsanitized agent HTML.
 */
const ALLOWED = new Set([
  "a",
  "p",
  "br",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "code",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "span",
  "div",
]);

marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Render markdown to sanitized HTML safe for webview innerHTML.
 */
export function renderMarkdownToSafeHtml(md: string): string {
  if (!md) {
    return "";
  }
  const raw = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(raw);
}

/**
 * Strip scripts/styles/handlers and drop tags outside the allowlist.
 */
export function sanitizeHtml(html: string): string {
  let out = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(
    /<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g,
    (full, tag: string, attrs = "") => {
      const name = tag.toLowerCase();
      const closing = full.startsWith("</");
      if (!ALLOWED.has(name)) {
        return "";
      }
      if (name === "a") {
        if (closing) {
          return "</a>";
        }
        const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
          attrs || "",
        );
        const url = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
        if (!/^(https?:|vscode:|file:|#|mailto:)/i.test(url)) {
          return "<a>";
        }
        const safe = url.replace(/"/g, "");
        return `<a href="${safe}" rel="noreferrer">`;
      }
      if (closing) {
        return `</${name}>`;
      }
      // Drop attributes on other tags (prevents javascript: urls on residual attrs)
      if (name === "br" || name === "hr") {
        return `<${name}>`;
      }
      return `<${name}>`;
    },
  );
  return out;
}
