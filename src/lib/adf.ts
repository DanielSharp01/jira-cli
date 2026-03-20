import type { AdfDoc, AdfNode } from "./types.ts";

/**
 * Converts an Atlassian Document Format (ADF) document to Markdown.
 * Handles common node types; falls back to plain text extraction for others.
 */
export function adfToMarkdown(doc: AdfDoc | null | undefined): string {
  if (!doc) return "";
  return doc.content.map(nodeToMarkdown).join("\n").trim();
}

function nodeToMarkdown(node: AdfNode, depth = 0): string {
  switch (node.type) {
    case "paragraph":
      return (node.content?.map(n => nodeToMarkdown(n, depth)).join("") ?? "") + "\n";

    case "text": {
      let text = node.text ?? "";
      if (node.marks) {
        for (const mark of node.marks) {
          if (mark.type === "strong") text = `**${text}**`;
          else if (mark.type === "em") text = `_${text}_`;
          else if (mark.type === "code") text = `\`${text}\``;
          else if (mark.type === "strike") text = `~~${text}~~`;
          else if (mark.type === "link") {
            const href = mark.attrs?.["href"] as string | undefined;
            text = href ? `[${text}](${href})` : text;
          }
        }
      }
      return text;
    }

    case "hardBreak":
      return "  \n";

    case "heading": {
      const level = (node.attrs?.["level"] as number | undefined) ?? 1;
      const prefix = "#".repeat(level);
      const inner = node.content?.map(n => nodeToMarkdown(n, depth)).join("") ?? "";
      return `${prefix} ${inner}\n`;
    }

    case "bulletList":
      return (node.content?.map(n => nodeToMarkdown(n, depth)).join("") ?? "") + "\n";

    case "orderedList":
      return (node.content?.map((n, i) => listItemToMarkdown(n, depth, i + 1)).join("") ?? "") + "\n";

    case "listItem": {
      const indent = "  ".repeat(depth);
      const inner = node.content?.map(n => nodeToMarkdown(n, depth + 1)).join("").trim() ?? "";
      return `${indent}- ${inner}\n`;
    }

    case "blockquote": {
      const inner = node.content?.map(n => nodeToMarkdown(n, depth)).join("") ?? "";
      return inner.split("\n").map(l => `> ${l}`).join("\n") + "\n";
    }

    case "codeBlock": {
      const lang = (node.attrs?.["language"] as string | undefined) ?? "";
      const code = node.content?.map(n => n.text ?? "").join("") ?? "";
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }

    case "rule":
      return "---\n";

    case "mention": {
      const name = node.attrs?.["text"] as string | undefined;
      return name ? `@${name}` : "";
    }

    case "inlineCard":
    case "blockCard": {
      const url = node.attrs?.["url"] as string | undefined;
      return url ? `[${url}](${url})` : "";
    }

    case "mediaGroup":
    case "mediaSingle":
    case "media":
      return "_[attachment]_";

    case "table": {
      const rows = node.content ?? [];
      const lines: string[] = [];
      rows.forEach((row, i) => {
        const cells = row.content?.map(cell => {
          const inner = cell.content?.map(n => nodeToMarkdown(n, depth)).join("").replace(/\n/g, " ").trim() ?? "";
          return inner;
        }) ?? [];
        lines.push(`| ${cells.join(" | ")} |`);
        if (i === 0) {
          lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
      });
      return lines.join("\n") + "\n";
    }

    default:
      return node.content?.map(n => nodeToMarkdown(n, depth)).join("") ?? "";
  }
}

function listItemToMarkdown(node: AdfNode, depth: number, index: number): string {
  const indent = "  ".repeat(depth);
  const inner = node.content?.map(n => nodeToMarkdown(n, depth + 1)).join("").trim() ?? "";
  return `${indent}${index}. ${inner}\n`;
}

/**
 * Converts a plain Markdown string to a minimal ADF document.
 * Preserves paragraph breaks; enough for round-tripping description text.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const paragraphs = markdown.trim().split(/\n{2,}/);
  const content: AdfNode[] = paragraphs
    .filter(p => p.trim().length > 0)
    .map(p => ({
      type: "paragraph",
      content: inlineToAdf(p.trim()),
    }));

  return {
    version: 1,
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph", content: [] }],
  };
}

function inlineToAdf(text: string): AdfNode[] {
  // Split on newlines within a paragraph → hardBreaks
  const lines = text.split("\n");
  const nodes: AdfNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.length > 0) {
      nodes.push({ type: "text", text: line });
    }
    if (i < lines.length - 1) {
      nodes.push({ type: "hardBreak" });
    }
  }
  return nodes;
}
