import { stdin } from "node:process";

const chunks = [];
stdin.on("data", (c) => chunks.push(c));
stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
    return;
  }

  const path = String(input.file_path || "");
  const command = String(input.command || "");
  const hay = `${path}\n${command}`.replaceAll("\\", "/").toLowerCase();
  const secretFile = hay.includes(".dev.vars") && !hay.includes(".dev.vars.example");

  if (secretFile) {
    process.stdout.write(
      JSON.stringify({
        permission: "deny",
        user_message: "Blocked .dev.vars. Use /health for missing names, never print secret values.",
        agent_message: "Do not read or dump .dev.vars. Check GET /health and wrangler.toml instead.",
      }),
    );
    return;
  }

  process.stdout.write(JSON.stringify({ permission: "allow" }));
});
