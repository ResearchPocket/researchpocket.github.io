import { fromMarkdown } from "mdast-util-from-markdown";
type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];

export interface ZenLinkTarget {
  kind: "zen" | "item";
  id: string;
  title: string;
  detail: string;
}

export function parseZenLink(
  url: string,
): { kind: "zen" | "item"; id: string } | null {
  const match =
    /^research:(zen|item)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      url,
    );
  return match
    ? {
        kind: match[1]!.toLowerCase() as "zen" | "item",
        id: match[2]!.toLowerCase(),
      }
    : null;
}

/** Actual Markdown links only: code, images and bare examples are not backlinks. */
export function extractZenLinks(body: string): string[] {
  const tree = fromMarkdown(body);
  const definitions = new Map<string, string>();
  const links = new Set<string>();
  function visit(nodes: MarkdownNode[], resolve: boolean) {
    for (const node of nodes) {
      if (node.type === "definition" && !definitions.has(node.identifier))
        definitions.set(node.identifier, node.url);
      const url =
        node.type === "link"
          ? node.url
          : node.type === "linkReference" && resolve
            ? definitions.get(node.identifier)
            : null;
      const target = url ? parseZenLink(url) : null;
      if (target) links.add(`${target.kind}:${target.id}`);
      if ("children" in node) visit(node.children as MarkdownNode[], resolve);
    }
  }
  visit(tree.children, false);
  visit(tree.children, true);
  return [...links];
}

export function linkCompletion(body: string, start: number, end = start) {
  if (start !== end) return null;
  const before = body.slice(0, start);
  const match = /\[\[([^\[\]\n]{0,160})$/.exec(before);
  if (!match) return null;
  return {
    start: start - match[0].length,
    end: body.slice(start, start + 2) === "]]" ? start + 2 : start,
    query: match[1]!,
  };
}

export function insertZenLink(
  body: string,
  start: number,
  end: number,
  target: ZenLinkTarget,
) {
  const label = target.title
    .replace(/\s+/g, " ")
    .replace(/[\\`*{}\[\]<>()!_]/g, "\\$&");
  const text = `[${label}](research:${target.kind}/${target.id})`;
  return {
    body: body.slice(0, start) + text + body.slice(end),
    caret: start + text.length,
  };
}
