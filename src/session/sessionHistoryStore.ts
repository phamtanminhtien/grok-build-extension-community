export interface SessionHistoryEntry {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  preview: string;
  messageCount: number;
}

const KEY = "grok.sessionHistory.v1";
const MAX = 50;

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class SessionHistoryStore {
  private readonly memento: MementoLike;

  constructor(memento: MementoLike) {
    this.memento = memento;
  }

  list(): SessionHistoryEntry[] {
    const all = this.memento.get<SessionHistoryEntry[]>(KEY) ?? [];
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsert(entry: SessionHistoryEntry): Promise<void> {
    const all = this.list().filter((e) => e.sessionId !== entry.sessionId);
    all.unshift(entry);
    await this.memento.update(KEY, all.slice(0, MAX));
  }

  async remove(sessionId: string): Promise<void> {
    await this.memento.update(
      KEY,
      this.list().filter((e) => e.sessionId !== sessionId),
    );
  }
}

export function deriveTitle(preview: string, sessionId: string): string {
  const line = preview.trim().split("\n")[0] ?? "";
  if (line.length > 0) {
    return line.slice(0, 80);
  }
  return `Session ${sessionId.slice(0, 8)}`;
}
