#!/usr/bin/env node
/**
 * Headless L0 smoke: spawn `grok agent stdio`, initialize, session/new,
 * prompt, print session/update text. Does not need VS Code.
 *
 * Usage: npm run smoke:cli
 * Env: GROK_BINARY, GROK_CWD, GROK_MODEL
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

function resolveBinary() {
  if (process.env.GROK_BINARY) {
    return process.env.GROK_BINARY;
  }
  const home = path.join(os.homedir(), ".grok", "bin", "grok");
  if (fs.existsSync(home)) {
    return home;
  }
  return "grok";
}

const binary = resolveBinary();
const cwd = process.env.GROK_CWD || process.cwd();
const model = process.env.GROK_MODEL;
const args = ["agent"];
if (model) {
  args.push("--model", model);
}
args.push("stdio");

console.log(`[smoke] spawn ${binary} ${args.join(" ")}`);
console.log(`[smoke] cwd=${cwd}`);

const child = spawn(binary, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

child.stderr.on("data", (buf) => {
  process.stderr.write(`[agent stderr] ${buf}`);
});

const input = Writable.toWeb(child.stdin);
const output = Readable.toWeb(child.stdout);
const stream = acp.ndJsonStream(input, output);

let text = "";

try {
  const result = await acp
    .client({ name: "grok-build-community-smoke" })
    .onRequest(acp.methods.client.session.requestPermission, async () => ({
      outcome: { outcome: "cancelled" },
    }))
    .onRequest(acp.methods.client.fs.readTextFile, async () => ({
      content: "",
    }))
    .onRequest(acp.methods.client.fs.writeTextFile, async () => ({}))
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });
      console.log(`[smoke] initialize protocolVersion=${init.protocolVersion}`);

      return ctx.buildSession(cwd).withSession(async (session) => {
        console.log(`[smoke] sessionId=${session.sessionId}`);
        const prompt = "Reply with exactly: L0 OK";
        console.log(`[smoke] prompt: ${prompt}`);
        session.prompt(prompt);

        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === "stop") {
            console.log(`[smoke] stopReason=${message.stopReason}`);
            return { sessionId: session.sessionId, stopReason: message.stopReason, text };
          }
          const u = message.update;
          if (
            u.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text"
          ) {
            text += u.content.text;
            process.stdout.write(u.content.text);
          } else {
            console.log(`\n[smoke] update ${u.sessionUpdate}`);
          }
        }
      });
    });

  console.log("\n[smoke] collected text:", JSON.stringify(result.text));
  console.log("[smoke] PASS");
  process.exitCode = 0;
} catch (err) {
  console.error("[smoke] FAIL", err);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    process.exit(process.exitCode ?? 0);
  }, 2000).unref();
}
