import { extractToolSentinels, type ToolEventPatch } from '@/components/ai/lib/toolEvent';

const OPEN = '<<UGS_TOOL>>';
const CLOSE = '<<UGS_TOOL_END>>';

/** Observe every completed sentinel synchronously, independent of UI batching. */
export class StreamToolObserver {
  private tail = '';
  private opened = false;
  private closeSearchFrom = 0;

  append(chunk: string): ToolEventPatch[] {
    this.tail += chunk;
    const patches: ToolEventPatch[] = [];
    for (;;) {
      if (!this.opened) {
        const open = this.tail.indexOf(OPEN);
        if (open < 0) {
          this.tail = this.tail.slice(-(OPEN.length - 1));
          break;
        }
        this.tail = this.tail.slice(open);
        this.opened = true;
        this.closeSearchFrom = OPEN.length;
      }
      const close = this.tail.indexOf(CLOSE, this.closeSearchFrom);
      if (close < 0) {
        this.closeSearchFrom = Math.max(OPEN.length, this.tail.length - CLOSE.length + 1);
        break;
      }
      const end = close + CLOSE.length;
      patches.push(...extractToolSentinels(this.tail.slice(0, end)).patches);
      this.tail = this.tail.slice(end);
      this.opened = false;
    }
    return patches;
  }
}
