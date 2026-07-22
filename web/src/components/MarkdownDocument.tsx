import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE_MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href, title }) => (
    <a href={href} rel="noreferrer" target="_blank" title={title}>
      {children}
    </a>
  ),
  img: ({ alt, title }) => (
    <span
      aria-label={alt || "Referenced image"}
      className="reader-markdown-image"
      role="img"
      title={title}
    >
      [Image: {alt || "unlabeled"}]
    </span>
  ),
};

export const MarkdownDocument = memo(function MarkdownDocument({
  className = "reader-markdown",
  components,
  source,
}: {
  className?: string;
  components?: Components;
  source: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown
        components={{ ...SAFE_MARKDOWN_COMPONENTS, ...components }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
