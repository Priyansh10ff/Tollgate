import type { ReactNode } from "react";

/**
 * Renders the small subset of Markdown the agent writes (paragraphs, **bold**, `code`, links,
 * headings, bullet and numbered lists, pipe tables) as React elements. No HTML is ever injected.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isTableRow(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        if (!isSeparator(lines[i]!)) rows.push(cells(lines[i]!));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="md-table" key={blocks.length}>
          <table>
            {head && (
              <thead>
                <tr>{head.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {body.map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(<h4 key={blocks.length}>{inline(heading[1]!)}</h4>);
      i++;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i]!)) {
        items.push(lines[i]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={blocks.length}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</List>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isTableRow(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

/** **bold**, *italic*, `code` and [links](https://…). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(<strong key={out.length}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<code key={out.length}>{m[3]}</code>);
    else if (m[4] !== undefined) out.push(<a key={out.length} href={m[5]} target="_blank" rel="noreferrer noopener">{m[4]}</a>);
    else if (m[6] !== undefined) out.push(<em key={out.length}>{m[6]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
