interface MarkdownNode {
  children?: MarkdownNode[];
  data?: {
    hChildren: Array<{ type: "text"; value: string }>;
    hName: "code";
    hProperties: { className: ["language-math", "math-inline"] };
  };
  type: string;
  value?: string;
}

const vectorMacroNames = [
  "a",
  "A",
  "b",
  "B",
  "c",
  "C",
  "d",
  "D",
  "e",
  "E",
  "I",
  "k",
  "L",
  "m",
  "M",
  "P",
  "q",
  "Q",
  "r",
  "R",
  "s",
  "S",
  "Sig",
  "t",
  "T",
  "u",
  "U",
  "v",
  "V",
  "w",
  "W",
  "x",
  "X",
  "y",
  "Y",
  "z",
  "Z",
] as const;

export const markdownMathMacros: Record<string, string> = Object.fromEntries([
  ...vectorMacroNames.map((name) => [`\\${name}`, `\\mathbf{${name}}`]),
  ["\\bp", "\\mathbf{p}"],
  ["\\Sig", "\\mathbf{\\Sigma}"],
  ["\\p", "\\,\\text{.}"],
  ["\\sp", "^{\\prime}"],
  ["\\tab", "\\hspace{0.7cm}"],
  ["\\deg", "^{\\circ}"],
  ["\\argmin", "\\underset{#1}{\\operatorname{argmin}}"],
  ["\\argmax", "\\underset{#1}{\\operatorname{argmax}}"],
  ["\\co", "\\;\\cos"],
  ["\\si", "\\;\\sin"],
  ["\\mR", "\\mathbb{R}"],
  ["\\mC", "\\mathbb{C}"],
  ["\\mN", "\\mathbb{N}"],
  ["\\mZ", "\\mathbb{Z}"],
  ["\\rc", "#1"],
  ["\\gc", "#1"],
  ["\\bc", "#1"],
  ["\\kc", "#1"],
  ["\\oc", "#1"],
  ["\\lrc", "#1"],
  ["\\lgc", "#1"],
  ["\\lbc", "#1"],
  ["\\loc", "#1"],
]);

const bareMathStarts = new Set(vectorMacroNames);

function normalizeEscapedTex(value: string) {
  return value.replace(/\\\\(?=[A-Za-z])/gu, "\\").replace(/\\_/gu, "_");
}

function replaceDelimitedMath(value: string) {
  return value
    .replace(
      /\\{1,2}\[([\s\S]*?)\\{1,2}\]/gu,
      (_, math: string) => `$$${normalizeEscapedTex(math)}$$`,
    )
    .replace(
      /\\{1,2}\(([\s\S]*?)\\{1,2}\)/gu,
      (_, math: string) => `$${normalizeEscapedTex(math)}$`,
    );
}

function mapOutsideInlineCode(line: string) {
  let output = "";
  let cursor = 0;

  while (cursor < line.length) {
    const opening = line.indexOf("`", cursor);
    if (opening === -1) return output + replaceDelimitedMath(line.slice(cursor));

    output += replaceDelimitedMath(line.slice(cursor, opening));
    let ticks = 1;
    while (line[opening + ticks] === "`") ticks += 1;
    const delimiter = "`".repeat(ticks);
    const closing = line.indexOf(delimiter, opening + ticks);
    if (closing === -1) return output + line.slice(opening);

    output += line.slice(opening, closing + ticks);
    cursor = closing + ticks;
  }

  return output;
}

export function normalizeMarkdownMathDelimiters(source: string) {
  let fence: { marker: string; size: number } | null = null;

  return source
    .split("\n")
    .map((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
      if (fenceMatch) {
        const delimiter = fenceMatch[1];
        if (!delimiter) return line;
        const marker = delimiter[0];
        const size = delimiter.length;
        if (!marker) return line;
        if (!fence) {
          fence = { marker, size };
        } else if (marker === fence.marker && size >= fence.size) {
          fence = null;
        }
        return line;
      }
      return fence ? line : mapOutsideInlineCode(line);
    })
    .join("\n");
}

function readBareMath(value: string, start: number) {
  let cursor = start;
  let braceDepth = 0;
  let sawStart = false;

  while (cursor < value.length) {
    const rest = value.slice(cursor);
    const command = /^\\([A-Za-z]+)/u.exec(rest);
    const commandName = command?.[1];
    if (command && commandName) {
      if (!sawStart && !bareMathStarts.has(commandName as (typeof vectorMacroNames)[number])) {
        return null;
      }
      sawStart = true;
      cursor += command[0].length;
      continue;
    }

    const escapedPunctuation = /^\\([_{}%&#])/u.exec(rest);
    if (escapedPunctuation) {
      cursor += escapedPunctuation[0].length;
      continue;
    }

    const character = value[cursor];
    if (!character) break;
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (/[\d_{}[\](),;:+\-=*/^|<>!']/u.test(character)) {
      cursor += 1;
      continue;
    }

    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }

    const word = /^[A-Za-z]+/u.exec(rest);
    const wordValue = word?.[0];
    if (wordValue && (braceDepth > 0 || wordValue.length === 1)) {
      cursor += wordValue.length;
      continue;
    }
    break;
  }

  const math = value.slice(start, cursor).trimEnd();
  return sawStart && math ? { end: start + math.length, math } : null;
}

export function splitBareMathText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] !== "\\") {
      cursor += 1;
      continue;
    }

    const match = readBareMath(value, cursor);
    if (!match) {
      cursor += 1;
      continue;
    }

    if (textStart < cursor) {
      nodes.push({ type: "text", value: value.slice(textStart, cursor) });
    }
    const math = normalizeEscapedTex(match.math);
    nodes.push({
      data: {
        hChildren: [{ type: "text", value: math }],
        hName: "code",
        hProperties: { className: ["language-math", "math-inline"] },
      },
      type: "inlineMath",
      value: math,
    });
    cursor = match.end;
    textStart = cursor;
  }

  if (textStart < value.length) {
    nodes.push({ type: "text", value: value.slice(textStart) });
  }
  return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

export function remarkBareMath() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value) {
          return splitBareMathText(child.value);
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
