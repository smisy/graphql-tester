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
  .option("-q, --query <query>", "Inline GraphQL query/mutation string (cannot co-exist with query.json)")
  .option("-f, --file <path>", "Path to .graphql file containing the query")
  .option("-v, --variables <json>", "JSON string of variables", "{}")
  .option("-H, --header <key:value...>", "Custom headers (repeatable)", collect, [])
  .option("--route <target>", "Shorthand for X-Route-Override header (go|csharp)")
  .option("--compare", "Send same query to both Go and C# routes, diff responses")
  .option("--raw", "Output raw JSON (no pretty-print)")
  .option("--timing", "Show request timing")
  .action(run);

function collect(value, previous) {
  return previous.concat([value]);
}

function loadQueryJson() {
  const jsonPath = path.resolve("query.json");
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.query !== "string") {
      console.error(`Error: query.json must contain a "query" field with a GraphQL string`);
      process.exit(1);
    }
    return parsed;
  } catch (e) {
    console.error(`Error: failed to parse query.json: ${e.message}`);
    process.exit(1);
  }
}

function resolveQuery(opts) {
  if (opts.file) {
    const filePath = path.resolve(opts.file);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    return fs.readFileSync(filePath, "utf-8");
  } else if (opts.query) {
    return opts.query;
  }
  return null;
}

function buildHeaders(opts, routeOverride) {
  const headers = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (routeOverride) headers["X-Route-Override"] = routeOverride;
  else if (opts.route) headers["X-Route-Override"] = opts.route;
  for (const h of opts.header) {
    const sep = h.indexOf(":");
    if (sep === -1) {
      console.error(`Error: invalid header format "${h}" — use key:value`);
      process.exit(1);
    }
    headers[h.slice(0, sep).trim()] = h.slice(sep + 1).trim();
  }
  return headers;
}

async function sendRequest(url, headers, body) {
  const start = Date.now();
  const res = await fetch(url, { method: "POST", headers, body });
  const elapsed = Date.now() - start;
  const json = await res.json();
  return { status: res.status, statusText: res.statusText, elapsed, json };
}

// Simple deep-sorted JSON for stable comparison
function sortedJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort(), 2);
}

function deepSort(obj) {
  if (Array.isArray(obj)) return obj.map(deepSort);
  if (obj && typeof obj === "object") {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = deepSort(obj[key]);
    }
    return sorted;
  }
  return obj;
}

function printDiff(goLines, csLines) {
  const max = Math.max(goLines.length, csLines.length);
  let diffCount = 0;
  const diffs = [];

  for (let i = 0; i < max; i++) {
    const g = goLines[i] || "";
    const c = csLines[i] || "";
    if (g !== c) {
      diffCount++;
      diffs.push({ line: i + 1, go: g, csharp: c });
    }
  }

  if (diffCount === 0) {
    console.log("\n✅ Responses are identical.");
  } else {
    console.log(`\n⚠️  ${diffCount} difference(s) found:\n`);
    for (const d of diffs.slice(0, 50)) {
      console.log(`  Line ${d.line}:`);
      if (d.go) console.log(`    \x1b[31m- Go:    ${d.go}\x1b[0m`);
      if (d.csharp) console.log(`    \x1b[32m+ C#:    ${d.csharp}\x1b[0m`);
    }
    if (diffs.length > 50) {
      console.log(`  ... and ${diffs.length - 50} more differences`);
    }
  }
  return diffCount;
}

async function run(opts) {
  // Check for query.json in cwd
  const queryJson = loadQueryJson();
  const hasQueryJson = queryJson !== null;
  const hasInlineQuery = !!opts.query;

  // query.json and -q must not co-exist
  if (hasQueryJson && hasInlineQuery) {
    console.error("Error: query.json and --query (-q) cannot be used together. Remove one.");
    process.exit(1);
  }

  let query;
  let variables;
  let operationName;

  if (hasQueryJson) {
    // Primary source: query.json
    query = queryJson.query;
    variables = queryJson.variables;
    operationName = queryJson.operationName;
    console.error(`📄 Using query.json`);
  } else {
    // Fallback: -q, -f, or stdin
    query = resolveQuery(opts);
    if (!query) {
      if (!process.stdin.isTTY) {
        query = await readStdin();
      } else {
        console.error("Error: provide query.json in cwd, --query, --file, or pipe query via stdin");
        process.exit(1);
      }
    }

    // If -q received a full JSON body (e.g. {"query":"...", "variables":{...}}), extract parts
    try {
      const parsed = JSON.parse(query);
      if (parsed && typeof parsed === "object" && typeof parsed.query === "string") {
        query = parsed.query;
        if (parsed.variables) variables = parsed.variables;
        if (parsed.operationName) operationName = parsed.operationName;
      }
    } catch {}
  }

  if (!opts.url) {
    console.error("Error: --url is required (or set GQL_URL in .env)");
    process.exit(1);
  }

  if (!variables) {
    try {
      variables = JSON.parse(opts.variables);
    } catch (e) {
      console.error(`Error: invalid JSON for --variables: ${e.message}`);
      process.exit(1);
    }
  }

  const payload = { query, variables };
  if (operationName) payload.operationName = operationName;
  const body = JSON.stringify(payload);

  // --- Compare mode ---
  if (opts.compare) {
    console.error(`→ POST ${opts.url} (compare mode: Go vs C#)\n`);

    try {
      const [goRes, csRes] = await Promise.all([
        sendRequest(opts.url, buildHeaders(opts, "go"), body),
        sendRequest(opts.url, buildHeaders(opts, "csharp"), body),
      ]);

      console.error(`← Go:    ${goRes.status} ${goRes.statusText} (${goRes.elapsed}ms)`);
      console.error(`← C#:    ${csRes.status} ${csRes.statusText} (${csRes.elapsed}ms)`);

      // Diff with sorted keys for stable comparison
      const goSorted = JSON.stringify(deepSort(goRes.json), null, 2).split("\n");
      const csSorted = JSON.stringify(deepSort(csRes.json), null, 2).split("\n");
      const diffCount = printDiff(goSorted, csSorted);

      if (diffCount > 0) {
        console.log("\n═══════════════════ Go Response ═══════════════════");
        console.log(JSON.stringify(goRes.json, null, 2));

        console.log("\n═══════════════════ C# Response ═══════════════════");
        console.log(JSON.stringify(csRes.json, null, 2));
      }

      if (opts.raw) {
        // Also write raw files for external diffing
        fs.writeFileSync("go.json", JSON.stringify(goRes.json));
        fs.writeFileSync("csharp.json", JSON.stringify(csRes.json));
        console.error("\nRaw files written: go.json, csharp.json");
      }

      process.exit(diffCount > 0 ? 2 : 0);
    } catch (e) {
      console.error(`\n❌ Request failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // --- Normal mode ---
  const headers = buildHeaders(opts, null);

  console.error(`→ POST ${opts.url}`);
  if (opts.route) console.error(`  X-Route-Override: ${opts.route}`);

  try {
    const { status, statusText, elapsed, json } = await sendRequest(opts.url, headers, body);

    console.error(`← ${status} ${statusText} (${elapsed}ms)`);
    if (opts.timing) console.error(`  Timing: ${elapsed}ms`);

    if (opts.raw) {
      process.stdout.write(JSON.stringify(json));
    } else {
      console.log(JSON.stringify(json, null, 2));
    }

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
