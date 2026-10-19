// Desktop Pi extension (installed by install.sh into ~/.pi/agent/extensions/remote-pi.ts).
// Adds /remote-pi: opt this Pi agent's Herdr pane in/out of Telegram push notifications.
// The opt-in lives on the pane itself as a Herdr-native metadata token (remote_pi=on), which the
// gateway reads via `herdr agent list/get`; nothing is pushed for panes without it.
// ref: Herdr socket API pane.report_metadata (`herdr api schema --json`); Pi extensions (docs/extensions.md)
// @ts-nocheck
import net from "node:net";

const TOKEN = "remote_pi";
const SOURCE = "remote-pi";
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;

function request(method, params, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Herdr did not respond")); }, timeoutMs);
    const finish = (fn, value) => { clearTimeout(timer); socket.destroy(); fn(value); };
    socket.on("error", (error) => finish(reject, error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: `remote-pi:${Date.now()}`, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const message = JSON.parse(buffer.slice(0, index));
      if (message.error) finish(reject, new Error(message.error.message || message.error.code));
      else finish(resolve, message.result);
    });
  });
}

async function isOn() {
  const result = await request("pane.get", { pane_id: paneId });
  return result?.pane?.tokens?.[TOKEN] === "on";
}

function setOn(on) {
  return request("pane.report_metadata", { pane_id: paneId, source: SOURCE, tokens: { [TOKEN]: on ? "on" : null } });
}

export default function (pi) {
  // The gateway's own Pi already streams to Telegram; its pane is excluded there anyway.
  if (process.env.REMOTE_PI_GATEWAY) return;

  pi.registerCommand("remote-pi", {
    description: "Push this agent's done / needs-confirmation events to Telegram (on | off | status; no argument toggles)",
    handler: async (args, ctx) => {
      if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) {
        ctx.ui.notify("/remote-pi only works inside a Herdr pane.", "error");
        return;
      }
      try {
        const arg = String(args || "").trim().toLowerCase();
        const current = await isOn();
        if (arg === "status") {
          ctx.ui.notify(`Telegram push for this agent (${paneId}): ${current ? "on" : "off"}`, "info");
          return;
        }
        const next = arg === "on" ? true : arg === "off" ? false : !current;
        await setOn(next);
        ctx.ui.notify(next
          ? `📡 Telegram push on for ${paneId}: you'll be notified when this agent finishes or needs confirmation.`
          : `Telegram push off for ${paneId}.`, "info");
      } catch (error) {
        ctx.ui.notify(`/remote-pi failed: ${error.message}`, "error");
      }
    },
  });

  // Quitting Pi frees the pane; clear the flag so the next agent there is not pushed by default.
  pi.on("session_shutdown", async (event) => {
    if (event?.reason !== "quit" || process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;
    await setOn(false).catch(() => {});
  });
}
