#!/usr/bin/env node

const { Command } = require("commander");
const fs = require("fs");
const path = require("path");

// Load .env from cwd
try {
  require("dotenv").config();
} catch {}

const program = new Command();

program
  .name("gql")
  .description("Send GraphQL queries/mutations with custom headers")
  .version("1.0.0")
  .requiredOption("-u, --url <url>", "GraphQL endpoint URL", process.env.GQL_URL)
  .option("-t, --token <token>", "Bearer token for Authorization header", process.env.GQL_TOKEN)
  .option("-q, --query <query>", "Inline GraphQL query/mutation string")
  .option("-f, --file <path>", "Path to .graphql file containing the query")
  .option("-v, --variables <json>", "JSON string of variables", "{}")
  .option("-H, --header <key:value...>", "Custom headers (repeatable)", collect, [])
  .option("--route <target>", "Shorthand for X-Route-Override header (go|csharp)")
  .option("--raw", "Output raw JSON (no pretty-print)")
  .option("--timing", "Show request timing")
  .action(run);

function collect(value, previous) {
  return previous.concat([value]);
}

async function run(opts) {
  // Resolve query
  let query;
  if (opts.file) {
    const filePath = path.resolve(opts.file);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    query = fs.readFileSync(filePath, "utf-8");
  } else if (opts.query) {
    query = opts.query;
  } else {
    // Read from stdin if piped
    if (!process.stdin.isTTY) {
      query = await readStdin();
    } else {
      console.error("Error: provide --query, --file, or pipe query via stdin");
      process.exit(1);
    }
  }

  if (!opts.url) {
    console.error("Error: --url is required (or set GQL_URL in .env)");
    process.exit(1);
  }

  // Build variables
  let variables;
  try {
    variables = JSON.parse(opts.variables);
  } catch (e) {
    console.error(`Error: invalid JSON for --variables: ${e.message}`);
    process.exit(1);
  }

  // Build headers
  const headers = {
    "Content-Type": "application/json",
  };

  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }

  if (opts.route) {
    headers["X-Route-Override"] = opts.route;
  }

  // Parse custom headers
  for (const h of opts.header) {
    const sep = h.indexOf(":");
    if (sep === -1) {
      console.error(`Error: invalid header format "${h}" — use key:value`);
      process.exit(1);
    }
    headers[h.slice(0, sep).trim()] = h.slice(sep + 1).trim();
  }

  const body = JSON.stringify({ query, variables });

  // Print request info to stderr
  console.error(`→ POST ${opts.url}`);
  if (opts.route) console.error(`  X-Route-Override: ${opts.route}`);

  const start = Date.now();

  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers,
      body,
    });

    const elapsed = Date.now() - start;
    const json = await res.json();

    // Status line to stderr
    console.error(`← ${res.status} ${res.statusText} (${elapsed}ms)`);

    if (opts.timing) {
      console.error(`  Timing: ${elapsed}ms`);
    }

    // Response to stdout
    if (opts.raw) {
      process.stdout.write(JSON.stringify(json));
    } else {
      console.log(JSON.stringify(json, null, 2));
    }

    // Highlight errors
    if (json.errors) {
      console.error(`\n⚠️  ${json.errors.length} GraphQL error(s):`);
      for (const err of json.errors) {
        console.error(`  • ${err.message}`);
      }
      process.exit(2);
    }
  } catch (e) {
    console.error(`\n❌ Request failed: ${e.message}`);
    process.exit(1);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

program.parse();
