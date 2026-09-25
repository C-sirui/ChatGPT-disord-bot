/** Splits a text stream into lines (handles \n and \r\n, and lines split across chunks). */
export class SseLineSplitter {
  #buf = '';

  push(text: string): string[] {
    this.#buf += text;
    const parts = this.#buf.split('\n');
    this.#buf = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }

  flush(text = ''): string[] {
    const lines = this.push(text);
    if (this.#buf) {
      lines.push(this.#buf.endsWith('\r') ? this.#buf.slice(0, -1) : this.#buf);
      this.#buf = '';
    }
    return lines;
  }
}
