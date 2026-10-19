// Desktop Pi extension (installed by install.sh into ~/.pi/agent/extensions/remote-pi.ts).
// Adds /remote-control (and deprecated /remote-pi): bridge this Pi agent's Herdr pane to its own Telegram topic.
// The opt-in lives on the pane itself as a Herdr-native metadata token (remote_pi=on), which the
// gateway reads via `herdr agent list/get`; session path fallback is reported as remote_pi_session.
// ref: Herdr socket API pane.report_metadata & pane.report_agent_session (`herdr api schema --json`); Pi session_start / sessionManager.getSessionFile() (Pi docs/extensions.md)
// @ts-nocheck
import net from "node:net";

const TOKEN = "remote_pi";
const SESSION_TOKEN = "remote_pi_session";
const SOURCE = "remote-pi";
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;

function request(method, params, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    const reqId = `remote-pi:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Herdr did not respond")); }, timeoutMs);
    const finish = (fn, value) => { clearTimeout(timer); socket.destroy(); fn(value); };
    socket.on("error", (error) => finish(reject, error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: reqId, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (err) {
          finish(reject, new Error(`Invalid JSON from Herdr: ${err.message}`));
          return;
        }
        if (message?.id === reqId) {
          if (message.error) finish(reject, new Error(message.error.message || message.error.code));
          else finish(resolve, message.result);
          return;
        }
      }
    });
  });
}

async function isOn() {
  const result = await request("pane.get", { pane_id: paneId });
  return result?.pane?.tokens?.[TOKEN] === "on";
}

function setOn(on, sessionFile) {
  const tokens = { [TOKEN]: on ? "on" : null };
  if (on) {
    if (sessionFile) tokens[SESSION_TOKEN] = sessionFile;
  } else {
    tokens[SESSION_TOKEN] = null;
  }
  return request("pane.report_metadata", { pane_id: paneId, source: SOURCE, tokens });
}

export default function (pi) {
  // The gateway's own Pi already streams to Telegram; its pane is excluded there anyway.
  if (process.env.REMOTE_PI_GATEWAY) return;

  const handler = async (args, ctx) => {
    if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) {
      ctx.ui.notify("/remote-control only works inside a Herdr pane.", "error");
      return;
    }
    try {
      const arg = String(args || "").trim().toLowerCase();
      const current = await isOn();
      if (arg === "status") {
        ctx.ui.notify(`Remote control for this agent (${paneId}): ${current ? "on" : "off"}`, "info");
        return;
      }
      const next = arg === "on" ? true : arg === "off" ? false : !current;
      const sessionFile = next ? ctx?.sessionManager?.getSessionFile?.() : undefined;
      await setOn(next, sessionFile);
      ctx.ui.notify(next
        ? `📡 Remote control on for ${paneId}: streaming to a Telegram topic.`
        : `Remote control off for ${paneId}.`, "info");
    } catch (error) {
      ctx.ui.notify(`/remote-control failed: ${error.message}`, "error");
    }
  };

  pi.registerCommand("remote-control", {
    description: "Bridge this Pi agent to its own Telegram topic (on | off | status; no argument toggles)",
    handler,
  });

  pi.registerCommand("remote-pi", {
    description: "Deprecated alias of /remote-control",
    handler,
  });

  // Session path fallback: on session_start (any reason) while on, update remote_pi_session
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) return;
    try {
      if (await isOn()) {
        await request("pane.report_metadata", {
          pane_id: paneId,
          source: SOURCE,
          tokens: { [SESSION_TOKEN]: sessionFile },
        });
      }
    } catch {}
  });

  // Quitting Pi frees the pane; clear the flags so the next agent there is not bridged by default.
  pi.on("session_shutdown", async (event) => {
    if (event?.reason !== "quit" || process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;
    await setOn(false).catch(() => {});
  });
}
