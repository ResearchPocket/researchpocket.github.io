import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
          Loading images contacts their hosts and can reveal your IP address.
          <button onClick={onLoadImages} type="button">
            Load images for this item
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
  source,
}: {
  className?: string;
  components?: Components;
  imageBaseUrl?: string;
  imagesAllowed?: boolean;
  onLoadImages?: () => void;
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
      return (
        <img
          alt={alt ?? ""}
          className="reader-markdown-image"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={imageUrl}
          title={title}
        />
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
