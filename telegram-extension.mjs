// Companion extension loaded by the gateway via `pi --mode rpc -e telegram-extension.mjs`.
// Gives the model two Telegram-native tools:
//   telegram_attach — deliver local files to the chat
//   telegram_ask    — ask a multiple-choice question with inline buttons
// Communication with the gateway runs through a spool directory (REMOTE_PI_SPOOL):
//   events.jsonl        extension -> gateway (attach / ask events, JSONL, append-only)
//   answers/<id>.json   gateway -> extension (ask answers, one file per ask)
import { existsSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";

const SPOOL = process.env.REMOTE_PI_SPOOL;
const ASK_TIMEOUT_MS = 5 * 60_000;

export default function (pi) {
  if (!SPOOL) return; // Only meaningful when spawned by the gateway.

  async function emit(event) {
    await appendFile(join(SPOOL, "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description: "Send local files to the user's Telegram chat as attachments with the current reply.",
    promptSnippet: "Deliver local files to the Telegram chat",
    promptGuidelines: ["Use telegram_attach when a Telegram user asks for a file or generated artifact, instead of only naming the path in text."],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Absolute local file path" }), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_toolCallId, params) {
      for (const path of params.paths) {
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`Not a file: ${path}`);
      }
      await emit({ type: "attach", paths: params.paths });
      return { content: [{ type: "text", text: `Queued ${params.paths.length} attachment(s) for Telegram delivery.` }], details: { paths: params.paths } };
    },
  });

  pi.registerTool({
    name: "telegram_ask",
    label: "Telegram Ask",
    description: "Ask the Telegram user a multiple-choice question rendered as inline buttons. Blocks until the user answers or 5 minutes pass.",
    promptSnippet: "Ask the Telegram user a multiple-choice question with buttons",
    promptGuidelines: ["Use telegram_ask only when the next step is genuinely ambiguous and one of the options would unblock it; otherwise pick the reasonable default and say so."],
    parameters: Type.Object({
      question: Type.String({ description: "Short question shown above the buttons" }),
      options: Type.Array(Type.String({ description: "Button label" }), { minItems: 2, maxItems: 8 }),
    }),
    async execute(_toolCallId, params) {
      const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await emit({ type: "ask", id, question: params.question, options: params.options });
      const answerPath = join(SPOOL, "answers", `${id}.json`);
      for (let waited = 0; waited < ASK_TIMEOUT_MS; waited += 500) {
        await sleep(500);
        if (existsSync(answerPath)) {
          const { answer } = JSON.parse(await readFile(answerPath, "utf8"));
          return { content: [{ type: "text", text: `用户选择了：${answer}` }], details: { answer } };
        }
      }
      return { content: [{ type: "text", text: "（用户 5 分钟内未回答）" }], details: { answer: null } };
    },
  });
}
