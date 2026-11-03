import DOMPurify from "dompurify";

const SVG_NS = "http://www.w3.org/2000/svg";

function parsedRoot(source: string, parser: DOMParser): Element | null {
  const doc = parser.parseFromString(source, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc.documentElement;
}

/** A valid, sanitized SVG image. The source never enters the document as markup. */
export function svgImageSource(code: string, parser: DOMParser): string | null {
  let source = code;
  let root = parsedRoot(source, parser);
  if (root?.localName === "svg" && root.namespaceURI === null && !root.hasAttribute("xmlns")) {
    source = code.replace(/<svg(?=[\s/>])/, `<svg xmlns="${SVG_NS}"`);
    root = parsedRoot(source, parser);
  }
  if (root?.localName !== "svg" || root.namespaceURI !== SVG_NS || !DOMPurify.isSupported) return null;

  // No active content, CSS or linked resources, including in the downloaded file.
  // Presentation attributes (fill, stroke, etc.) and local fragment references remain.
  const clean = DOMPurify.sanitize(root, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "style", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["style", "src"],
  });
  root = parsedRoot(clean, parser);
  if (root?.localName !== "svg" || root.namespaceURI !== SVG_NS) return null;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const value = attribute.value.trim();
      const isLink = attribute.localName.toLowerCase() === "href";
      // DOMPurify removes script URLs, but ordinarily permits safe remote URLs.
      const urls = [...value.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi)];
      const externalUrl = /url\s*\(/i.test(value) && (urls.length === 0 || urls.some((match) => !/^#[^\s]+$/.test(match[2].trim())));
      if ((isLink && !/^#[^\s]+$/.test(value)) || externalUrl || value.includes("\\")) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

export function svgDataUrl(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}
