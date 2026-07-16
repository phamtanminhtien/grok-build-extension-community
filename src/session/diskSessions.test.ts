import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeSessionCwd, listDiskSessions } from "./diskSessions.ts";

describe("encodeSessionCwd", () => {
  it("url-encodes absolute path like Grok", () => {
    const enc = encodeSessionCwd("/Users/tienpham/Work/demo");
    assert.equal(enc, encodeURIComponent("/Users/tienpham/Work/demo"));
    assert.match(enc, /^%2F/);
  });
});

describe("listDiskSessions", () => {
  it("reads summary.json from GROK_HOME sessions tree", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sess-"));
    const cwd = "/tmp/project-a";
    const group = path.join(
      tmp,
      "sessions",
      encodeURIComponent(cwd),
      "019f0000-aaaa-bbbb-cccc-dddddddddddd",
    );
    fs.mkdirSync(group, { recursive: true });
    fs.writeFileSync(
      path.join(group, "summary.json"),
      JSON.stringify({
        info: { id: "019f0000-aaaa-bbbb-cccc-dddddddddddd", cwd },
        generated_title: "Hello World",
        session_summary: "Hello World",
        updated_at: "2026-07-16T12:00:00.000Z",
        num_messages: 4,
        num_chat_messages: 2,
        current_model_id: "grok-4.5",
      }),
    );

    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = tmp;
    try {
      const all = listDiskSessions({ allWorkspaces: true, limit: 10 });
      assert.equal(all.length, 1);
      assert.equal(all[0]?.title, "Hello World");
      assert.equal(all[0]?.sessionId, "019f0000-aaaa-bbbb-cccc-dddddddddddd");
      assert.equal(all[0]?.source, "disk");

      const filtered = listDiskSessions({ cwd, limit: 10 });
      assert.equal(filtered.length, 1);

      const other = listDiskSessions({
        cwd: "/tmp/other-project",
        limit: 10,
      });
      assert.equal(other.length, 0);
    } finally {
      if (prev === undefined) {
        delete process.env.GROK_HOME;
      } else {
        process.env.GROK_HOME = prev;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
