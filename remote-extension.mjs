// Companion extension loaded by the gateway via `pi --mode rpc -e remote-extension.mjs`.
// Gives the model two gateway-native tools:
//   remote_attach — deliver local files to the chat
//   remote_ask    — ask a multiple-choice question with interactive buttons
import { stat } from "node:fs/promises";
import { Type } from "typebox";

const ASK_TIMEOUT_MS = 5 * 60_000;

function registerAttach(pi, name, label, desc, promptSnippet, promptGuidelines) {
  pi.registerTool({
    name,
    label,
    description: desc,
    promptSnippet,
    promptGuidelines,
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Absolute local file path" }), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_toolCallId, params) {
      for (const path of params.paths) {
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`Not a file: ${path}`);
      }
      return {
        content: [{ type: "text", text: `Queued ${params.paths.length} attachment(s) for delivery.` }],
        details: { paths: params.paths },
      };
    },
  });
}

function registerAsk(pi, name, label, desc, promptSnippet, promptGuidelines) {
  pi.registerTool({
    name,
    label,
    description: desc,
    promptSnippet,
    promptGuidelines,
    parameters: Type.Object({
      question: Type.String({ description: "Short question shown above the options" }),
      options: Type.Array(Type.String({ description: "Button or option label" }), { minItems: 2, maxItems: 8 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const answer = await ctx.ui.select(params.question, params.options, { timeout: ASK_TIMEOUT_MS });
      if (answer) {
        return { content: [{ type: "text", text: `User selected: ${answer}` }], details: { answer } };
      }
      return { content: [{ type: "text", text: "(User did not answer within 5 minutes, or cancelled)" }], details: { answer: null } };
    },
  });
}

export default function (pi) {
  // Primary generic tools
  registerAttach(
    pi,
    "remote_attach",
    "Remote Attach",
    "Send local files to the user's chat as attachments with the current reply.",
    "Deliver local files to the chat",
    ["Use remote_attach when the user asks for a file or generated artifact, instead of only naming the path in text."]
  );

  registerAsk(
    pi,
    "remote_ask",
    "Remote Ask",
    "Ask the user a multiple-choice question rendered as interactive buttons. Blocks until the user answers or 5 minutes pass.",
    "Ask the user a multiple-choice question with buttons",
    ["Use remote_ask only when the next step is genuinely ambiguous and one of the options would unblock it; otherwise pick the reasonable default and say so."]
  );

  // Backward-compatibility aliases for existing prompts and sessions
  registerAttach(
    pi,
    "telegram_attach",
    "Telegram Attach (Alias)",
    "Alias for remote_attach to maintain backward compatibility.",
    "Deliver local files to the chat",
    ["Alias for remote_attach."]
  );

  registerAsk(
    pi,
    "telegram_ask",
    "Telegram Ask (Alias)",
    "Alias for remote_ask to maintain backward compatibility.",
    "Ask the user a multiple-choice question with buttons",
    ["Alias for remote_ask."]
  );
}
