import "./test-css-module.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import { chromium } from "playwright";
import ts from "typescript";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SvgBlock } = await jiti.import("./SvgBlock.tsx");
const { svgDataUrl } = await jiti.import("../lib/svg-image.ts");
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const SVG_NS = "http://www.w3.org/2000/svg";
const svgSrc = `<svg width="200" height="70" xmlns="${SVG_NS}"><rect width="194" height="64" fill="#0ea5e9"/><text x="100" y="42">SVG 中文</text></svg>`;
const render = (component, props, children) => renderToStaticMarkup(
  React.createElement(I18nProvider, null, React.createElement(component, props, children)),
);

test("svgDataUrl percent-encodes the source, # and quotes included", () => {
  const source = '<svg fill="#fff">中</svg>';
  const url = svgDataUrl(source);
  assert.equal(url, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`);
  assert.doesNotMatch(url.slice(url.indexOf(",")), /[#"<]/);
});

test("SvgBlock shows source while streaming and waits for the browser during SSR", () => {
  const streaming = render(SvgBlock, { code: svgSrc, isStreaming: true });
  assert.match(streaming, /disabled/);
  assert.match(streaming, />Preview</);
  assert.match(streaming, /&lt;rect/);
  assert.doesNotMatch(streaming, /<img/);
  const html = render(SvgBlock, { code: svgSrc });
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /<img/);
});

test("only svg fences dispatch to SvgBlock, including upper-case SVG", () => {
  for (const lang of ["svg", "SVG"]) {
    assert.match(render(MarkdownBody, {}, `\`\`\`${lang}\n${svgSrc}\n\`\`\``), /mermaid-block-loading/);
  }
  assert.doesNotMatch(render(MarkdownBody, {}, `\`\`\`xml\n${svgSrc}\n\`\`\``), /mermaid-block-loading/);
});

test("real DOMPurify keeps SVG geometry but removes active and remote content", async () => {
  // A disposable headless browser supplies a real XML DOM and the existing purifier.
  // No Pi Web server, ordinary browser profile or external page is opened.
  const browser = await chromium.launch({ headless: true, channel: process.env.E2E_BROWSER_CHANNEL || "chrome" });
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route("**/*", (route) => { requests.push(route.request().url()); return route.abort(); });
    await page.addScriptTag({ path: join(dirname(require.resolve("dompurify")), "purify.min.js") });
    const source = (await readFile(new URL("../lib/svg-image.ts", import.meta.url), "utf8"))
      .replace('import DOMPurify from "dompurify";', "const DOMPurify = globalThis.DOMPurify;")
      .replace(/export /g, "");
    await page.addScriptTag({ content: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText });
    const result = await page.evaluate(async ({ SVG_NS, svgSrc }) => {
      const sanitize = (code) => svgImageSource(code, new DOMParser());
      const valid = sanitize(svgSrc);
      const implicit = sanitize('<svg viewBox="0 0 20 20"><circle r="8"/></svg>');
      const hostile = sanitize(`<svg xmlns="${SVG_NS}" onload="alert(1)">
        <script>alert(1)</script><foreignObject><iframe src="https://example.invalid/frame"/></foreignObject>
        <style>@import url(https://example.invalid/style);</style>
        <image href="https://example.invalid/image"/><use href="https://example.invalid/use#id"/>
        <rect style="fill:url(https://example.invalid/style)" fill="url(https://example.invalid/fill)" onclick="alert(1)"/>
        <animate attributeName="href" values="https://example.invalid/animated"/>
        <defs><linearGradient id="local"/></defs><path fill="url('#local')" d="M0 0L1 1"/><use href="#local"/>
      </svg>`);
      const image = new Image();
      image.src = svgDataUrl(hostile);
      await image.decode();
      return {
        valid, implicit, hostile,
        invalid: ["just text", "<div/>", '<svg xmlns="http://example.com/x"/>', `<svg xmlns="${SVG_NS}"><rect></svg>`].map(sanitize),
      };
    }, { SVG_NS, svgSrc });
    assert.match(result.valid, /<rect.*fill="#0ea5e9"/);
    assert.match(result.valid, /SVG 中文/);
    assert.match(result.implicit, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.deepEqual(result.invalid, [null, null, null, null]);
    assert.doesNotMatch(result.hostile, /<script|foreignObject|<iframe|<style|onload|onclick|https:|<animate|\sstyle=/);
    assert.match(result.hostile, /fill="url\('#local'\)"/);
    assert.deepEqual(requests, []);
  } finally {
    await browser.close();
  }
});
