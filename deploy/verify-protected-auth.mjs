import { readFileSync, statSync } from "node:fs";

const secretPath = process.argv[2] ?? "/etc/uma-agent/protected-user-pat";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:3210";
const stat = statSync(secretPath);
if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
  throw new Error("protected PAT file must use mode 0600");
if (process.platform !== "win32" && secretPath === "/etc/uma-agent/protected-user-pat" && stat.uid !== 0)
  throw new Error("production protected PAT file must be owned by root");
const token = readFileSync(secretPath, "utf8").trim();
const response = await fetch(`${baseUrl}/api/v14/sessions`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`protected user authentication failed: HTTP ${response.status}`);
const sessions = await response.json();
if (!Array.isArray(sessions)) throw new Error("protected user session response is invalid");
console.log(JSON.stringify({ protectedAuthentication: true, sessionCount: sessions.length }));
