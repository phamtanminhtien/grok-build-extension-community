export class SnapshotStore {
  private readonly map = new Map<string, string>();
  private readonly maxCharsPerFile: number;

  constructor(maxCharsPerFile = 500_000) {
    this.maxCharsPerFile = maxCharsPerFile;
  }

  normalizePath(p: string): string {
    return p.replace(/\\/g, "/");
  }

  capture(path: string, content: string): void {
    const key = this.normalizePath(path);
    if (content.length > this.maxCharsPerFile) {
      this.map.set(key, content.slice(0, this.maxCharsPerFile));
      return;
    }
    this.map.set(key, content);
  }

  get(path: string): string | undefined {
    return this.map.get(this.normalizePath(path));
  }

  has(path: string): boolean {
    return this.map.has(this.normalizePath(path));
  }

  /** Drop a single path baseline (e.g. after accept/reject). */
  delete(path: string): boolean {
    return this.map.delete(this.normalizePath(path));
  }

  clear(): void {
    this.map.clear();
  }

  paths(): string[] {
    return [...this.map.keys()];
  }
}
