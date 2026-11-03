"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { svgImageSource, svgDataUrl } from "@/lib/svg-image";
import {
  CodeBlock,
  DiagramZoomDialog,
  PreviewFrame,
  PreviewToggleButton,
  SvgDownloadButton,
  downloadSvgFile,
} from "./MermaidBlock";

/**
 * A ```svg fence, shown like a mermaid one. The picture is only ever an <img>:
 * the sanitized source never enters the page’s DOM as markup. Linked resources
 * and active content are removed from both the preview and the download.
 */
export function SvgBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(true);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [unsizedUrl, setUnsizedUrl] = useState<string | null>(null);
  const previewVisible = showPreview && !isStreaming;
  // undefined: not parsed (a server render has no DOMParser).
  const source = useMemo(
    () => (previewVisible && typeof DOMParser !== "undefined" ? svgImageSource(code, new DOMParser()) : undefined),
    [code, previewVisible],
  );
  const url = useMemo(() => (source ? svgDataUrl(source) : null), [source]);

  const previewButton = useMemo(() => (
    <PreviewToggleButton
      isStreaming={isStreaming}
      previewVisible={previewVisible}
      onToggle={() => setShowPreview((v) => !v)}
      title={previewVisible ? t("i18n.showSvgSource") : t("i18n.previewSvg")}
    />
  ), [isStreaming, previewVisible, t]);

  if (!previewVisible) {
    return <CodeBlock code={code} lang="svg" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const ready = url !== null && failedUrl !== url;
  const image = (className: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url ?? undefined}
      alt={t("i18n.svgImage")}
      // Neither a viewBox nor a width and height: the image has no size of its own.
      className={[className, unsizedUrl === url ? "is-unsized" : ""].filter(Boolean).join(" ")}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (!naturalWidth || !naturalHeight) setUnsizedUrl(url);
      }}
      onError={() => setFailedUrl(url)}
    />
  );

  return (
    <PreviewFrame
      lang="svg"
      actions={
        <>
          {ready && source && <SvgDownloadButton onClick={() => downloadSvgFile(source, "image.svg")} />}
          {previewButton}
        </>
      }
    >
      {source === undefined ? (
        <div className="mermaid-block mermaid-block-loading" />
      ) : !ready ? (
        <div className="mermaid-block mermaid-block-error">{t("i18n.invalidSvg")}</div>
      ) : (
        <>
          {!zoomOpen && (
            <button
              type="button"
              className="mermaid-block mermaid-preview-button"
              title={t("i18n.openSvgViewer")}
              aria-label={t("i18n.openSvgViewer")}
              onClick={() => setZoomOpen(true)}
            >
              {image("svg-block-image")}
            </button>
          )}
          {zoomOpen && (
            <DiagramZoomDialog title={t("i18n.svgImage")} label={t("i18n.svgViewer")} onClose={() => setZoomOpen(false)}>
              {image("svg-zoom-image")}
            </DiagramZoomDialog>
          )}
        </>
      )}
    </PreviewFrame>
  );
}
