// NotesMd widget — markdown annotation panel. Static (no live data
// refresh); the agent uses these to add context / methodology /
// rationale alongside the data widgets.
//
// Spec shape:
//   {
//     "type": "notes_md",
//     "title": "Methodology",
//     "data_source": { "tool": "inline", "args": {} },
//     "body": "Markdown content here..."
//   }
//
// We render via a tiny inline parser (paragraphs, headings, lists,
// inline code, bold/italic, links) instead of pulling in
// react-markdown to keep the bundle lean. The agent doesn't need
// the full CommonMark surface for trader-facing notes.

import { useMemo, type ReactElement } from "react";

import type { WidgetRenderState } from "./types";

export default function NotesMd({ state }: { state: WidgetRenderState }): ReactElement {
  const body = (state.spec.body as string | undefined) ?? "";

  const rendered = useMemo(() => renderMarkdownLite(body), [body]);

  return (
    <div
      style={{
        padding: 16,
        fontSize: 13,
        lineHeight: 1.6,
        overflow: "auto",
        height: "100%",
      }}
    >
      {rendered}
    </div>
  );
}

/** Very small markdown subset: headings (# / ## / ###), paragraphs,
 *  unordered lists, fenced code, inline code, bold + italic, links.
 *  Anything more elaborate (tables, nested lists) gets rendered as
 *  the literal markdown. */
function renderMarkdownLite(input: string): ReactElement[] {
  const lines = input.split(/\r?\n/);
  const out: ReactElement[] = [];
  let key = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Fenced code
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // consume closing fence
      out.push(
        <pre
          key={key++}
          className="mono"
          style={{
            padding: 10,
            background: "var(--bg-alt)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            margin: "8px 0",
            fontSize: 11,
            overflow: "auto",
          }}
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1]!.length;
      const text = h[2] ?? "";
      const Tag = (`h${lvl}` as unknown) as keyof React.JSX.IntrinsicElements;
      const sizes = { 1: 18, 2: 16, 3: 14 } as Record<number, number>;
      out.push(
        <Tag
          key={key++}
          style={{
            margin: "12px 0 6px",
            fontSize: sizes[lvl] ?? 14,
            fontWeight: 600,
          }}
        >
          {renderInline(text)}
        </Tag>,
      );
      i++;
      continue;
    }
    // List
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul
          key={key++}
          style={{ paddingLeft: 20, margin: "6px 0" }}
        >
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph
    const buf: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").startsWith("#") &&
      !(lines[i] ?? "").startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "")
    ) {
      buf.push(lines[i] ?? "");
      i++;
    }
    out.push(
      <p key={key++} style={{ margin: "6px 0" }}>
        {renderInline(buf.join(" "))}
      </p>,
    );
  }
  return out;
}

function renderInline(text: string): (string | ReactElement)[] {
  // Order matters: code first (otherwise * inside code gets bolded),
  // then bold, then italic, then links.
  const parts: (string | ReactElement)[] = [text];
  let key = 0;
  // Inline code
  expand(parts, /`([^`]+)`/, (m) => (
    <code
      key={key++}
      className="mono"
      style={{
        padding: "1px 4px",
        background: "var(--bg-alt)",
        border: "1px solid var(--border)",
        borderRadius: 3,
        fontSize: 11,
      }}
    >
      {m[1]}
    </code>
  ));
  // Bold
  expand(parts, /\*\*([^*]+)\*\*/, (m) => (
    <strong key={key++}>{m[1]}</strong>
  ));
  // Italic
  expand(parts, /\*([^*]+)\*/, (m) => <em key={key++}>{m[1]}</em>);
  // Links
  expand(parts, /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/, (m) => (
    <a
      key={key++}
      href={m[2]}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "var(--accent)" }}
    >
      {m[1]}
    </a>
  ));
  return parts;
}

function expand(
  parts: (string | ReactElement)[],
  re: RegExp,
  build: (m: RegExpExecArray) => ReactElement,
): void {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (typeof p !== "string") continue;
    const m = re.exec(p);
    if (!m) continue;
    const before = p.slice(0, m.index);
    const after = p.slice(m.index + m[0].length);
    const built = build(m);
    parts.splice(i, 1, before, built, after);
    // Re-process from the `after` segment (which may match again).
    i += 1;
  }
}
