// Moon Begin: minimal Markdown renderer for the isolated temporary chat iframe.
// This function is serialized with toString() and injected into the iframe script,
// so it must stay self-contained (no imports, no outer references). It only creates
// DOM nodes and text nodes; it never assigns HTML strings, so model output cannot
// inject markup or scripts.
export function renderTemporaryChatMarkdown(
  doc: Document,
  source: string,
  renderMath?: (target: HTMLElement, formula: string, display: boolean) => void,
): DocumentFragment {
  const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
  const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const rule = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const quote = /^\s{0,3}>\s?/;
  const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const tableRule = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const displayStart = /^\s{0,3}(\$\$|\\\[)(.*)$/;
  const inlinePattern = /`([^`\n]+)`|(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|(?<![\\$])\$(?![\d$\s])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\$)|(?<!\\)\\\(([\s\S]+?)\\\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s](?:[\s\S]*?[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)[^)]*\)|\n/g;

  const el = (tag: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  const math = (target: Node, formula: string, display: boolean, original: string): void => {
    if (!renderMath) { target.appendChild(doc.createTextNode(original)); return; }
    const node = el('span', display ? 'math-display' : 'math-inline');
    try { renderMath(node, formula, display); } catch { node.textContent = original; }
    target.appendChild(node);
  };

  const inline = (target: Node, text: string): void => {
    const pattern = new RegExp(inlinePattern.source, 'g');
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      if (match.index > last) target.appendChild(doc.createTextNode(text.slice(last, match.index)));
      last = pattern.lastIndex;
      if (match[1] !== undefined) { const code = el('code'); code.textContent = match[1]; target.appendChild(code); }
      else if (match[2] !== undefined || match[3] !== undefined) math(target, match[2] ?? match[3], true, match[0]);
      else if (match[4] !== undefined || match[5] !== undefined) math(target, match[4] ?? match[5], false, match[0]);
      else if (match[6] !== undefined || match[7] !== undefined) { const strong = el('strong'); inline(strong, (match[6] ?? match[7]).trim()); target.appendChild(strong); }
      else if (match[8] !== undefined) { const del = el('del'); inline(del, match[8]); target.appendChild(del); }
      else if (match[9] !== undefined) { const em = el('em'); inline(em, match[9]); target.appendChild(em); }
      else if (match[10] !== undefined) { const link = el('span', 'link'); link.title = match[11]; inline(link, match[10]); target.appendChild(link); }
      else target.appendChild(el('br'));
    }
    if (last < text.length) target.appendChild(doc.createTextNode(text.slice(last)));
  };

  const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const startsBlock = (line: string): boolean => fence.test(line) || displayStart.test(line) || heading.test(line) || rule.test(line) || quote.test(line) || item.test(line);
  const indentOf = (line: string): number => (line.match(/^\s*/) as RegExpMatchArray)[0].replace(/\t/g, '    ').length;

  const blocks = (target: Node, lines: string[]): void => {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fenced = line.match(fence);
      if (fenced) {
        const body: string[] = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s{0,3}' + fenced[1][0] + '{' + fenced[1].length + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
        i++;
        const pre = el('pre');
        const code = el('code');
        if (fenced[2]) code.setAttribute('data-language', fenced[2]);
        code.textContent = body.join('\n');
        pre.appendChild(code);
        target.appendChild(pre);
        continue;
      }
      const display = line.match(displayStart);
      if (display) {
        const close = display[1] === '$$' ? '$$' : '\\]';
        const body = [display[2]];
        let end = i;
        let closing = body[0].indexOf(close);
        while (closing < 0 && end + 1 < lines.length) {
          body.push(lines[++end]);
          closing = body[body.length - 1].indexOf(close);
        }
        const last = body[body.length - 1];
        if (closing >= 0 && !last.slice(closing + close.length).trim()) {
          body[body.length - 1] = last.slice(0, closing);
          math(target, body.join('\n').trim(), true, lines.slice(i, end + 1).join('\n'));
          i = end + 1;
          continue;
        }
      }
      const head = line.match(heading);
      if (head) { const h = el('h' + head[1].length); inline(h, head[2]); target.appendChild(h); i++; continue; }
      if (rule.test(line)) { target.appendChild(el('hr')); i++; continue; }
      if (quote.test(line)) {
        const body: string[] = [];
        while (i < lines.length && lines[i].trim() && (quote.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(quote, ''));
        const blockquote = el('blockquote');
        blocks(blockquote, body);
        target.appendChild(blockquote);
        continue;
      }
      const first = line.match(item);
      if (first) {
        const baseIndent = indentOf(first[1]);
        const ordered = /\d/.test(first[2]);
        const list = el(ordered ? 'ol' : 'ul');
        if (ordered && parseInt(first[2], 10) !== 1) list.setAttribute('start', String(parseInt(first[2], 10)));
        while (i < lines.length) {
          const current = lines[i].match(item);
          if (!current || indentOf(current[1]) !== baseIndent || /\d/.test(current[2]) !== ordered) break;
          const body = [current[3]];
          i++;
          while (i < lines.length) {
            const next = lines[i];
            if (!next.trim()) {
              let peek = i + 1;
              while (peek < lines.length && !lines[peek].trim()) peek++;
              if (peek < lines.length && indentOf(lines[peek]) > baseIndent) { body.push(''); i++; continue; }
              break;
            }
            const nested = next.match(item);
            if (nested && indentOf(nested[1]) <= baseIndent) break;
            if (!nested && indentOf(next) <= baseIndent && startsBlock(next)) break;
            body.push(next.replace(/^\s+/, nested ? ' '.repeat(Math.max(0, indentOf(nested[1]) - baseIndent - 2)) : ''));
            i++;
          }
          const li = el('li');
          blocks(li, body);
          if (li.childNodes.length === 1 && li.firstChild && (li.firstChild as Element).tagName === 'P') {
            const paragraph = li.firstChild;
            while (paragraph.firstChild) li.insertBefore(paragraph.firstChild, paragraph);
            li.removeChild(paragraph);
          }
          list.appendChild(li);
          while (i < lines.length && !lines[i].trim()) {
            let peek = i;
            while (peek < lines.length && !lines[peek].trim()) peek++;
            const again = peek < lines.length ? lines[peek].match(item) : null;
            if (again && indentOf(again[1]) === baseIndent) i = peek; else break;
          }
        }
        target.appendChild(list);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && tableRule.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const table = el('table');
        const thead = el('thead');
        const headRow = el('tr');
        cells(line).forEach(cell => { const th = el('th'); inline(th, cell); headRow.appendChild(th); });
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const row = el('tr');
          cells(lines[i++]).forEach(cell => { const td = el('td'); inline(td, cell); row.appendChild(td); });
          tbody.appendChild(row);
        }
        table.appendChild(tbody);
        const wrap = el('div', 'table');
        wrap.appendChild(table);
        target.appendChild(wrap);
        continue;
      }
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (body.length === 0 || !startsBlock(lines[i]))) body.push(lines[i++].trim());
      const p = el('p');
      inline(p, body.join('\n'));
      target.appendChild(p);
    }
  };

  const fragment = doc.createDocumentFragment();
  blocks(fragment, source.replace(/\r\n?/g, '\n').split('\n'));
  return fragment;
}
// Moon End
