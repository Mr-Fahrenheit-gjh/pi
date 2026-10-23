"use client";

import { createContext, memo, useContext, useMemo, type ComponentProps, type MouseEvent } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownAppUrlTransform, markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { InlineVisualBlock, useInlineVisualValues, type VisualValueCache } from "./InlineVisual";
import { INLINE_VISUAL_LANGUAGE, isClosedVisualFence } from "@/lib/inline-visual";

const MarkdownLinkContext = createContext(false);
const MarkdownSourceContext = createContext<{
  markdown: string; offset: number; isStreaming: boolean; allowInlineVisuals: boolean; visualValues: VisualValueCache;
} | null>(null);

function MarkdownCode({ className, children, node, ...props }: ComponentProps<"code"> & ExtraProps) {
  const source = useContext(MarkdownSourceContext);
  const lang = className?.replace("language-", "").toLowerCase() ?? "";
  const raw = String(children);
  if (className?.includes("language-") || raw.includes("\n")) {
    const code = raw.replace(/\n$/, "");
    if (lang === INLINE_VISUAL_LANGUAGE && source?.allowInlineVisuals) {
      const start = node?.position?.start.offset;
      return <InlineVisualBlock source={code}
        ready={isClosedVisualFence(source.markdown, start, node?.position?.end.offset)}
        isStreaming={source.isStreaming} cache={source.visualValues}
        cacheKey={`${source.offset + (start ?? 0)}:${code}`} />;
    }
    if (lang === "mermaid") return <MermaidBlock code={code} isStreaming={source?.isStreaming} defaultPreview />;
    return <CodeBlock code={code} lang={lang} isStreaming={source?.isStreaming} />;
  }
  return <code className="markdown-inline-code" {...props}>{children}</code>;
}

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
  /** Only assistant answer blocks opt in; quoted/user/tool content stays code. */
  allowInlineVisuals?: boolean;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  ...props
}: ComponentProps<"img"> & ExtraProps & { cwd?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const imageSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
    : href;
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!imageSrc || insideLink) return image;
  return (
    <ImagePreview src={imageSrc} alt={alt ?? ""} className="markdown-image">
      {image}
    </ImagePreview>
  );
}

interface MarkdownBlockProps {
  markdown: string;
  remarkPlugins: typeof markdownRemarkPlugins;
  urlTransform: typeof markdownUrlTransform;
  components: Components;
  offset: number;
  isStreaming: boolean;
  allowInlineVisuals: boolean;
  visualValues: VisualValueCache;
}

/** One parse; skipped while its text and renderers stay the same. */
const MarkdownBlock = memo(function MarkdownBlock({ markdown, remarkPlugins, urlTransform, components, offset, isStreaming, allowInlineVisuals, visualValues }: MarkdownBlockProps) {
  const source = useMemo(() => ({ markdown, offset, isStreaming, allowInlineVisuals, visualValues }), [markdown, offset, isStreaming, allowInlineVisuals, visualValues]);
  return (
    <MarkdownSourceContext.Provider value={source}>
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      urlTransform={urlTransform}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
    </MarkdownSourceContext.Provider>
  );
});

export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming = false, cwd, onOpenFile, keepLineBreaks, allowInlineVisuals = false }: MarkdownBodyProps) {
  const visualValues = useInlineVisualValues();
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // A streaming reply grows by a few characters per chunk; parsing all of it
  // each time made a long reply quadratic. Its finished blocks keep their
  // parse and only the last is parsed again. A finished message is one block.
  const blocks = useMemo(
    () => (isStreaming ? splitMarkdownBlocks(normalizedMarkdown) : [normalizedMarkdown]),
    [isStreaming, normalizedMarkdown],
  );
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code: MarkdownCode,
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <MarkdownLinkContext.Provider value={true}>
          <a href={href} {...props} onClick={handleClick}>
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} {...props} />;
    },
    ol({ node, start, style, ...props }) {
      // An outside marker wider than the list's left padding is clipped by
      // .markdown-body's overflow-x, so the padding follows the largest number.
      const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const digits = String(Math.abs((start ?? 1) + Math.max(items, 1) - 1)).length;
      return <ol start={start} style={{ ...style, ["--ol-marker-digits" as string]: Math.max(digits, 2) }} {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, onOpenFile]);

  let offset = 0;
  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => {
        const blockOffset = offset;
        offset += block.length;
        return <MarkdownBlock
          key={index}
          markdown={block}
          offset={blockOffset}
          isStreaming={isStreaming}
          allowInlineVisuals={allowInlineVisuals}
          visualValues={visualValues}
          remarkPlugins={keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins}
          urlTransform={onOpenFile ? markdownUrlTransform : markdownAppUrlTransform}
          components={components}
        />;
      })}
    </div>
  );
});
