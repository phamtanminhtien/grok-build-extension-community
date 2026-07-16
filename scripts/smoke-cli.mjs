#!/usr/bin/env node
/**
 * Headless L0 smoke: spawn `grok agent stdio`, initialize, session/new,
 * prompt, print session/update text. Does not need VS Code.
 *
 * Usage: npm run smoke:cli
 * Env:
 *   GROK_BINARY   path to grok
 *   GROK_CWD      session cwd (default: process.cwd())
 *   GROK_MODEL    optional --model
 *   SMOKE_TIMEOUT_MS  overall timeout (default: 120000)
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 120_000);

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

function hintForStderr(line) {
  if (/localhost:9876|127\.0\.0\.1:9876/.test(line)) {
    return (
      "\n[smoke] hint: something in ~/.grok/config.toml is calling :9876 " +
      "(often [mcp_servers.blender]). Set enabled = false or start that server.\n"
    );
  }
  if (/Connection refused/i.test(line) && /mcp|worker quit/i.test(line)) {
    return (
      "\n[smoke] hint: an MCP worker failed to connect. Check enabled entries " +
      "under [mcp_servers.*] in ~/.grok/config.toml.\n"
    );
  }
  return "";
}

const binary = resolveBinary();
const cwd = process.env.GROK_CWD || process.cwd();
const model = process.env.GROK_MODEL;
const args = ["agent"];
if (model) {
  args.push("--model", model);
}
// Avoid permission stalls during smoke (tools may still run).
args.push("--always-approve");
args.push("stdio");

console.log(`[smoke] spawn ${binary} ${args.join(" ")}`);
console.log(`[smoke] cwd=${cwd}`);
console.log(`[smoke] timeout=${TIMEOUT_MS}ms`);

const child = spawn(binary, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let sawMcpHint = false;
child.stderr.on("data", (buf) => {
  const text = buf.toString();
  process.stderr.write(`[agent stderr] ${text}`);
  if (!sawMcpHint) {
    const hint = hintForStderr(text);
    if (hint) {
      sawMcpHint = true;
      process.stderr.write(hint);
    }
  }
});

const input = Writable.toWeb(child.stdin);
const output = Readable.toWeb(child.stdout);
const stream = acp.ndJsonStream(input, output);

let text = "";
let finished = false;

function shutdown(code) {
  if (finished) {
    return;
  }
  finished = true;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    process.exit(code);
  }, 1500).unref();
}

const watchdog = setTimeout(() => {
  console.error(
    `\n[smoke] FAIL: timed out after ${TIMEOUT_MS}ms waiting for prompt completion.`,
  );
  console.error(
    "[smoke] ACP initialize/session may be fine; the model turn did not finish.",
  );
  if (sawMcpHint) {
    console.error(
      "[smoke] Also saw MCP connection errors — fix ~/.grok/config.toml and retry.",
    );
  }
  shutdown(1);
}, TIMEOUT_MS);
watchdog.unref?.();

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
        // Do not await prompt() alone — drain nextUpdate until stop.
        const promptDone = session.prompt(prompt);

        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === "stop") {
            console.log(`[smoke] stopReason=${message.stopReason}`);
            await promptDone.catch(() => undefined);
            return {
              sessionId: session.sessionId,
              stopReason: message.stopReason,
              text,
            };
          }
          const u = message.update;
          if (
            u.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text"
          ) {
            text += u.content.text;
            process.stdout.write(u.content.text);
          } else if (u.sessionUpdate === "agent_thought_chunk") {
            process.stdout.write(".");
          } else {
            console.log(`\n[smoke] update ${u.sessionUpdate}`);
          }
        }
      });
    });

  clearTimeout(watchdog);
  console.log("\n[smoke] collected text:", JSON.stringify(result.text));
  if (!/L0 OK/i.test(result.text)) {
    console.warn(
      "[smoke] WARN: response did not contain exact 'L0 OK' (protocol still ok)",
    );
  }
  console.log("[smoke] PASS");
  shutdown(0);
} catch (err) {
  clearTimeout(watchdog);
  console.error("[smoke] FAIL", err);
  shutdown(1);
}
