// Companion extension loaded by the gateway via `pi --mode rpc -e telegram-extension.mjs`.
// Gives the model two Telegram-native tools:
//   telegram_attach — deliver local files to the chat
//   telegram_ask    — ask a multiple-choice question with inline buttons
import { stat } from "node:fs/promises";
import { Type } from "typebox";

const ASK_TIMEOUT_MS = 5 * 60_000;

export default function (pi) {
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
      return {
        content: [{ type: "text", text: `Queued ${params.paths.length} attachment(s) for Telegram delivery.` }],
        details: { paths: params.paths },
      };
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const answer = await ctx.ui.select(params.question, params.options, { timeout: ASK_TIMEOUT_MS });
      if (answer) {
        return { content: [{ type: "text", text: `用户选择了：${answer}` }], details: { answer } };
      }
      return { content: [{ type: "text", text: "（用户 5 分钟内未回答或取消）" }], details: { answer: null } };
    },
  });
}
