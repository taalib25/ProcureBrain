import { config } from "dotenv";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Run on the computer where the browser opens the loopback callback. Tokens never go to stdout.
const envPath = resolve(process.env.DOTENV_CONFIG_PATH ?? fileURLToPath(new URL("../../../.env", import.meta.url)));
config({ path: envPath, quiet: true });
if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
  console.error("Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to your local .env first. See docs/CONNECTED_CHANNELS.md.");
  process.exit(1);
}
const redirectUri = "http://127.0.0.1:8788/callback";
const client = new OAuth2Client(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, redirectUri);
const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
const state = randomBytes(32).toString("hex");
const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/gmail.readonly"], state,
  code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
let completing = false;
const server = createServer(async (request, response) => {
  const callback = new URL(request.url ?? "/", redirectUri);
  if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== state) { response.writeHead(400); response.end("Invalid connection request."); return; }
  if (completing) { response.writeHead(409); response.end("Connection is already being saved."); return; }
  const code = callback.searchParams.get("code"); if (!code) { response.writeHead(400); response.end("Google did not authorize Gmail access. You can close this window."); return; }
  completing = true;
  try {
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token || !tokens.scope?.split(" ").includes("https://www.googleapis.com/auth/gmail.readonly")) throw new Error("Read-only authorization was not granted");
    const old = await readFile(envPath, "utf8").catch(() => "");
    let updated = old;
    for (const [key, value] of Object.entries({ GMAIL_REFRESH_TOKEN: tokens.refresh_token, PROCUREBRAIN_GMAIL_ENABLED: "true" })) {
      const pattern = new RegExp(`^${key}=.*$`, "m"); const line = `${key}=${JSON.stringify(value)}`;
      updated = pattern.test(updated) ? updated.replace(pattern, () => line) : `${updated.trimEnd()}\n${line}\n`;
    }
    const temporary = `${envPath}.gmail-${randomBytes(6).toString("hex")}`;
    try { await writeFile(temporary, updated, { mode: 0o600, flag: "wx" }); await rename(temporary, envPath); await chmod(envPath, 0o600); }
    finally { await unlink(temporary).catch(() => {}); }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Gmail connected. Close this window and restart the ProcureBrain API. Recent supplier messages will be saved as history. New supplier messages will be checked automatically.");
    console.log("Gmail authorization saved in your local .env. No token was printed. Restart the API to begin reading supplier messages.");
    server.close();
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain" }); response.end("The connection could not be saved. Run the setup command again.");
    console.error("Gmail authorization could not be saved. No credential details are displayed."); server.close(); process.exitCode = 1;
  }
});
server.on("error", () => { console.error("Gmail setup could not start. Check that port 8788 is free."); process.exitCode = 1; });
server.listen(8788, "127.0.0.1", () => console.log(`Open this URL in your browser to connect Gmail:\n${url}\n\nOnly messages from registered suppliers will be stored. New messages go to the configured AI service. No supplier replies will be sent.`));
const timeout = setTimeout(() => { console.error("Gmail setup timed out. Run the command again when ready."); server.close(); }, 10 * 60000);
timeout.unref(); server.on("close", () => clearTimeout(timeout));
