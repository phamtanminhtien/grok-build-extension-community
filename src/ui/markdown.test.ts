import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToSafeHtml, sanitizeHtml } from "./markdown.ts";

describe("renderMarkdownToSafeHtml", () => {
  it("renders fenced code", () => {
    const html = renderMarkdownToSafeHtml("```ts\nconst x = 1\n```");
    assert.match(html, /<pre>/);
    assert.match(html, /const x = 1/);
  });

  it("default does not soft-break single newlines", () => {
    const html = renderMarkdownToSafeHtml("line1\nline2");
    assert.equal(html.includes("<br>"), false);
  });

  it("breaks:true preserves Shift+Enter line breaks as <br>", () => {
    const html = renderMarkdownToSafeHtml("line1\nline2", { breaks: true });
    assert.match(html, /line1\s*<br\s*\/?>\s*line2/i);
  });

  it("strips script tags", () => {
    const html = sanitizeHtml(`<p>ok</p><script>alert(1)</script>`);
    assert.equal(html.includes("script"), false);
    assert.match(html, /ok/);
  });

  it("strips onerror handlers", () => {
    const html = sanitizeHtml(`<img src=x onerror="alert(1)"><p>x</p>`);
    assert.equal(html.includes("onerror"), false);
  });
});
