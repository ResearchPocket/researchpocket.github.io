import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["html"], { languageName: "xml" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["ps1"], { languageName: "powershell" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  css: "CSS",
  html: "HTML",
  ini: "INI",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  md: "Markdown",
  powershell: "PowerShell",
  ps1: "PowerShell",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  xml: "HTML/XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

export function HighlightedCodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | undefined>(undefined);
  const normalizedLanguage = language?.toLocaleLowerCase();
  const highlighted = useMemo(() => {
    if (!normalizedLanguage || !hljs.getLanguage(normalizedLanguage)) {
      return escapeHtml(code);
    }
    return hljs.highlight(code, {
      ignoreIllegals: true,
      language: normalizedLanguage,
    }).value;
  }, [code, normalizedLanguage]);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2_000);
  }

  const label =
    (normalizedLanguage && LANGUAGE_LABELS[normalizedLanguage]) || "Code";
  const buttonLabel =
    copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy";

  return (
    <figure className="docs-code-block">
      <figcaption>
        <span>{label}</span>
        <button
          aria-label={`Copy ${label} code`}
          onClick={copyCode}
          type="button"
        >
          {buttonLabel}
        </button>
      </figcaption>
      <pre>
        <code
          className={normalizedLanguage ? `hljs language-${normalizedLanguage}` : "hljs"}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? `${label} code copied to clipboard.`
          : copyState === "error"
            ? `Could not copy ${label} code.`
            : ""}
      </span>
    </figure>
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
