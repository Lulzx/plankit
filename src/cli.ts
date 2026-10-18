#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createPlanClient } from "./client.js";
import { MANAGE_USAGE_URL, PlanError } from "./errors.js";

const HELP = `plankit: use your ChatGPT plan from the terminal

Usage:
  plankit login [--account <id>] [--consent]   Sign in with ChatGPT (opens your browser)
  plankit status                               Show saved accounts
  plankit models                               List models available to your plan
  plankit ask "<prompt>" [--model <slug>]      Stream a response (reads stdin when piped)
  plankit use <account-id>                     Switch the active account
  plankit logout                               Sign out of the active account

Options:
  --app <name>   App name to register as (default "plankit CLI")
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: "string", default: "plankit CLI" },
      account: { type: "string" },
      model: { type: "string" },
      consent: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) return void process.stdout.write(HELP);

  const plan = createPlanClient({
    appName: values.app!,
    onWarning: (m) => process.stderr.write(`${m}\n`),
    openBrowser: async (url) => {
      const { openInBrowser } = await import("./oauth.js");
      if (await openInBrowser(url)) return true;
      process.stderr.write(`Open this URL to sign in:\n${url}\n`);
    },
  });

  switch (cmd) {
    case "login": {
      process.stderr.write("Opening your browser to sign in with ChatGPT…\n");
      const a = await plan.signIn({ account: values.account, forceConsent: values.consent });
      console.log(`Signed in as ${a.email ?? a.id}`);
      console.log(a.planEnabled ? "Using your ChatGPT plan." : "Plan usage not granted. Run `plankit login --consent` to enable it.");
      return;
    }
    case "status": {
      const s = await plan.status();
      if (!s.accounts.length) return void console.log("No accounts. Run `plankit login`.");
      for (const a of s.accounts) {
        const flags = [a.signedIn ? "signed in" : "signed out", a.planEnabled ? "plan enabled" : "plan not enabled"];
        console.log(`${a.active ? "*" : " "} ${a.email ?? "(no email)"}  ${a.id}  [${flags.join(", ")}]`);
      }
      return;
    }
    case "models": {
      for (const m of await plan.models()) console.log(`${m.slug}\t${m.displayName}`);
      return;
    }
    case "ask": {
      let prompt = rest.join(" ");
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const piped = Buffer.concat(chunks).toString("utf8").trim();
        prompt = prompt ? `${prompt}\n\n${piped}` : piped;
      }
      if (!prompt) throw new PlanError("no_prompt", 'Usage: plankit ask "<prompt>"');
      const model = values.model ?? (await plan.models())[0]?.slug;
      if (!model) throw new PlanError("no_models", "No models are available to this account");
      for await (const d of plan.streamText({ model, input: prompt })) process.stdout.write(d);
      process.stdout.write("\n");
      return;
    }
    case "use":
      await plan.useAccount(rest[0]);
      return void console.log(`Active account: ${rest[0]}`);
    case "logout": {
      const { revoked } = await plan.signOut();
      console.log(revoked ? "Signed out." : `Signed out locally. Remote revocation wasn't confirmed; you can disconnect the app at ${MANAGE_USAGE_URL}`);
      return;
    }
    default:
      process.stderr.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  if (e instanceof PlanError) {
    const hint: Record<string, string> = {
      sign_in: "Run `plankit login`.",
      enable_plan: "Run `plankit login --consent` to enable ChatGPT plan usage.",
      manage_usage: `Usage limit reached. Manage usage: ${MANAGE_USAGE_URL}`,
      retry_later: "Temporary problem. Try again shortly.",
    };
    process.stderr.write(`Error (${e.code}): ${e.message}\n${hint[e.recovery] ?? ""}${e.requestId ? `\nRequest ID: ${e.requestId}` : ""}\n`);
  } else {
    process.stderr.write(`${e?.stack ?? e}\n`);
  }
  process.exitCode = 1;
});
