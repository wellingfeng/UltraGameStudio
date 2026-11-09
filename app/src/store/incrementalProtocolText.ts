import { liveProse } from '@/core/interaction';
import { legacyXmlToolsToSentinels } from '@/components/ai/lib/legacyXmlTool';

const residueLine = /^(?:count|function_calls|tool_calls|<\/?(?:function_calls|tool_calls|antml:function_calls)\s*>)$/i;

// Keep open protocol/code blocks and their wrapper lines in the mutable tail.
// The legacy converter remains the authority; only proven closed prose is sealed.
function safeSealEnd(text: string): number {
  let end = text.lastIndexOf('\n', text.length - 2) + 1;
  const partialAsk = text.lastIndexOf('<<');
  if (partialAsk >= 0 && /^\s*(?:U|UG|UGS|UGS_|UGS_A|UGS_AS|UGS_ASK)?\s*>*$/.test(text.slice(partialAsk + 2))) {
    end = Math.min(end, text.lastIndexOf('\n', partialAsk - 1) + 1);
  }
  const tokens = /<<UGS_TOOL>>|(?:^|\n)(?:```|~~~)|<think(?:ing)?>|(?:^|\n)[ \t]*<invoke\b/gi;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const start = match.index;
    const token = match[0].trimStart();
    let closeEnd = -1;
    if (token === '<<UGS_TOOL>>') {
      const close = text.indexOf('<<UGS_TOOL_END>>', tokens.lastIndex);
      if (close >= 0) closeEnd = close + '<<UGS_TOOL_END>>'.length;
    } else if (token.startsWith('```') || token.startsWith('~~~')) {
      const close = /(?:^|\n)(?:```|~~~)/g;
      close.lastIndex = tokens.lastIndex;
      const hit = close.exec(text);
      if (hit) closeEnd = hit.index + hit[0].length;
    } else {
      const close = token.toLowerCase().startsWith('<think') ? /<\/think(?:ing)?>/gi : /<\/invoke\s*>/gi;
      close.lastIndex = tokens.lastIndex;
      const hit = close.exec(text);
      if (hit) closeEnd = hit.index + hit[0].length;
      // Following XML wrapper residue may itself be split over later chunks.
      if (hit && token.toLowerCase().startsWith('<invoke') && !text.slice(closeEnd).split('\n').slice(0, -1).some((line) =>
        line.trim() && !residueLine.test(line.trim()) && !/^<\//.test(line.trim()))) closeEnd = -1;
    }
    if (closeEnd < 0 || closeEnd > end) {
      end = Math.min(end, text.lastIndexOf('\n', start - 1) + 1);
      break;
    }
    tokens.lastIndex = closeEnd;
  }
  // Do not detach the opening wrapper/count lines from an invoke arriving next.
  while (end > 0) {
    const previous = end <= 1 ? 0 : text.lastIndexOf('\n', end - 2) + 1;
    const line = text.slice(previous, end).trim();
    if ((line && !residueLine.test(line)) || line.startsWith('</')) break;
    end = previous;
  }
  const heartbeat = /^(?:\s*(?:⏳\s*)?仍在运行[.…。]*(?:[（(]已\s*\d+\s*s[）)])?\s*)$/u;
  let offset = 0;
  let firstHeartbeat = -1;
  let lastHeartbeat = -1;
  const lines = text.slice(0, end).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (heartbeat.test(lines[index])) {
      if (firstHeartbeat < 0) firstHeartbeat = offset;
      lastHeartbeat = index;
    }
    offset += lines[index].length + 1;
  }
  // A tail-position heartbeat is mutable until later substantive prose lands.
  if (firstHeartbeat >= 0 && !lines.slice(lastHeartbeat + 1).some((line) => line.trim())) end = firstHeartbeat;
  return end;
}

export class IncrementalProtocolText {
  private chunks: string[] = [];
  private tail = '';
  private sealed = '';
  private hidden = false;
  private tailAtLineStart = true;
  private compactXmlWhitespace = false;
  constructor(private transform: (text: string) => string = (text) => legacyXmlToolsToSentinels(text, { streamingTail: true })) {}
  append(chunk: string): void { this.chunks.push(chunk); if (!this.hidden) this.tail += chunk; }
  get raw(): string { return this.chunks.join(''); }
  display(): string {
    if (this.hidden) return this.sealed;
    // A long ordinary paragraph has no protocol grammar. Keep a small overlap
    // and its line context so a later inline <invoke> cannot become a tool.
    if (this.tail.length > 512 && !/[<\n]/.test(this.tail) &&
        !this.tail.includes('仍在运行') && !this.tail.includes('```') && !this.tail.includes('~~~')) {
      const end = this.tail.length - 64;
      this.sealed += this.tail.slice(0, end);
      this.tail = this.tail.slice(end);
      this.tailAtLineStart = false;
    }
    const convert = (text: string) => this.tailAtLineStart
      ? this.transform(text) : this.transform(`.${text}`).slice(1);
    const converted = convert(this.tail);
    // The authority compacts the *whole* document once an XML tool exists.
    // Normalize the previously sealed prose once too, without reparsing it.
    if (!this.compactXmlWhitespace && converted !== this.tail &&
        converted.includes('<<UGS_TOOL>>{"id":"legacy-xml-')) {
      this.compactXmlWhitespace = true;
      this.sealed = this.sealed.replace(/\n{3,}/g, '\n\n');
    }
    const cut = /<<\s*UGS_ASK\s*>+|<<UGS_MEMORY>>|<<UGS_RECALL>>|<<UGS_GEN>>/.exec(converted);
    if (cut) {
      this.sealed = (this.sealed + liveProse(converted.slice(0, cut.index), false)).trimEnd();
      this.tail = '';
      this.hidden = true;
      return this.sealed;
    }
    const end = safeSealEnd(this.tail);
    if (end > 0) {
      this.sealed += liveProse(convert(this.tail.slice(0, end)), false);
      this.tail = this.tail.slice(end);
      this.tailAtLineStart = true;
    }
    const display = this.sealed + liveProse(this.tailAtLineStart ? this.transform(this.tail) : convert(this.tail), false);
    return this.compactXmlWhitespace ? display.replace(/\n{3,}/g, '\n\n') : display;
  }
}
