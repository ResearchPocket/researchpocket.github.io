import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownImage {
  alt: string;
  src: string;
  title?: string;
}

function inertImage(
  alt: string | undefined,
  title: string | undefined,
  canLoad: boolean,
  onLoadImages: (() => void) | undefined,
) {
  return (
    <span
      className="reader-markdown-image-placeholder"
      title={title}
    >
      <span aria-label={alt || "Referenced image"} role="img">
        [Image: {alt || "unlabeled"}]
      </span>
      {canLoad && onLoadImages ? (
        <span className="reader-markdown-image-consent">
          <span>Remote · shares IP when loaded</span>
          <button
            aria-label="Load images for this item. Loading contacts their hosts and can reveal your IP address."
            onClick={onLoadImages}
            title="Loading contacts image hosts and can reveal your IP address."
            type="button"
          >
            Load item images
          </button>
        </span>
      ) : null}
    </span>
  );
}

function safeImageUrl(
  source: string | undefined,
  baseUrl: string | undefined,
): string | null {
  if (!source || !baseUrl) return null;
  try {
    const url = new URL(source, baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export const MarkdownDocument = memo(function MarkdownDocument({
  className = "reader-markdown",
  components,
  imageBaseUrl,
  imagesAllowed = false,
  onLoadImages,
  onOpenImage,
  source,
}: {
  className?: string;
  components?: Components;
  imageBaseUrl?: string;
  imagesAllowed?: boolean;
  onLoadImages?: () => void;
  onOpenImage?: (image: MarkdownImage, opener: HTMLButtonElement) => void;
  source: string;
}) {
  const safeMarkdownComponents: Components = {
    a: ({ children, href, title }) => (
      <a href={href} rel="noreferrer" target="_blank" title={title}>
        {children}
      </a>
    ),
    img: ({ alt, src, title }) => {
      const imageUrl = safeImageUrl(src, imageBaseUrl);
      if (!imagesAllowed || !imageUrl) {
        return inertImage(alt, title, Boolean(imageUrl), onLoadImages);
      }
      const image = {
        alt: alt ?? "",
        src: imageUrl,
        ...(title ? { title } : {}),
      };
      return (
        <button
          aria-label={`Expand image${alt ? `: ${alt}` : ""}`}
          className="reader-markdown-image-trigger"
          data-image-src={imageUrl}
          onClick={(event) => onOpenImage?.(image, event.currentTarget)}
          title={title ? `${title} — expand image` : "Expand image"}
          type="button"
        >
          <img
            alt={alt ?? ""}
            className="reader-markdown-image"
            decoding="async"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={imageUrl}
          />
        </button>
      );
    },
  };

  return (
    <div className={className}>
      <ReactMarkdown
        components={{ ...safeMarkdownComponents, ...components }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
