#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { AdtClient, ReadOnlyViolationError } from "./adt-client.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { textResult } from "./result.js";
import { createReporter } from "./reporter.js";
import { createAuditLog, toolContext } from "./audit.js";
import { configurePanel, ensurePanelStarted } from "./panel.js";

import * as connectionTools from "./tools/connection.js";
import * as sourceTools from "./tools/source.js";
import * as qualityTools from "./tools/quality.js";
import * as lifecycleTools from "./tools/lifecycle.js";
import * as discoveryTools from "./tools/discovery.js";
import * as crossSystemTools from "./tools/cross-system.js";
import * as transportTools from "./tools/transports.js";
import * as runtimeTools from "./tools/runtime.js";
import * as dataTools from "./tools/data.js";
import * as systemInfoTools from "./tools/system-info.js";
import * as requestTools from "./tools/request.js";
import * as versionTools from "./tools/versions.js";
import * as noteTools from "./tools/notes.js";
import * as cdsTools from "./tools/cds.js";
import * as worklistTools from "./tools/worklist.js";
import * as jobTools from "./tools/jobs.js";
import * as rapTools from "./tools/rap.js";
import * as reportTools from "./tools/report.js";
import * as panelTools from "./tools/panel.js";
import * as debugTools from "./tools/debug.js";

const PKG = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8"
  )
);

// --- CLI dispatch ------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${PKG.name} ${PKG.version}\n`);
  process.exit(0);
}
if (argv.includes("--validate-config")) {
  await validateConfig();
  // validateConfig() exits.
}

// --- Boot --------------------------------------------------------------------
const config = loadConfig();
process.stderr.write(
  `[${PKG.name}] v${PKG.version} — loaded ${Object.keys(config.systems).length} system(s) from ${config.configPath}; default=${config.defaultSystem ?? "none"}${config.readOnly ? " (global read-only)" : ""}\n`
);

const auditLog = createAuditLog(config);
if (auditLog.enabled) {
  process.stderr.write(
    `[${PKG.name}] audit log: every write to SAP is recorded at ${auditLog.path} ` +
      `(local only; disable with "audit": { "enabled": false } or SAP_ADT_MCP_AUDIT=0).\n`
  );
}

const reporter = createReporter(config, PKG);
if (reporter.enabled) {
  process.stderr.write(
    `[${PKG.name}] automatic error reporting is ON. On an unexpected crash, an ` +
      `anonymous, redacted report (no hostnames, users, passwords, or business data) ` +
      `is sent to the maintainer to help fix bugs. Disable with ` +
      `"reporting": { "enabled": false } in config or SAP_ADT_MCP_REPORT=0.\n`
  );
}

const clientCache = new Map();

function getClient(systemName) {
  const name = systemName ?? config.defaultSystem;
  if (!name) {
    throw new Error(
      "No system specified and no defaultSystem configured. " +
        `Available: ${Object.keys(config.systems).join(", ")}`
    );
  }
  const profile = config.systems[name];
  if (!profile) {
    throw new Error(
      `Unknown system '${name}'. Available: ${Object.keys(config.systems).join(", ")}`
    );
  }
  if (!clientCache.has(name)) {
    clientCache.set(name, new AdtClient(profile, { audit: auditLog.record }));
  }
  return { name, client: clientCache.get(name), profile };
}

const ctx = { getClient, config, reporter };

const TOOL_MODULES = [
  connectionTools,
  sourceTools,
  qualityTools,
  lifecycleTools,
  discoveryTools,
  crossSystemTools,
  transportTools,
  runtimeTools,
  dataTools,
  systemInfoTools,
  requestTools,
  versionTools,
  noteTools,
  cdsTools,
  worklistTools,
  jobTools,
  rapTools,
  reportTools,
  panelTools,
  debugTools,
];

const tools = [];
const handlers = {};
for (const mod of TOOL_MODULES) {
  for (const def of mod.tools) tools.push(def);
  const registered = mod.register(ctx);
  for (const [name, fn] of Object.entries(registered)) {
    if (handlers[name]) {
      throw new Error(`Duplicate tool handler registered: ${name}`);
    }
    handlers[name] = fn;
  }
}

// --- MCP wiring --------------------------------------------------------------
const server = new Server(
  { name: "sap-adt-mcp", version: PKG.version },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listPrompts(),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  return getPrompt(name, args);
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const handler = handlers[name];
  if (!handler) return textResult(`Unknown tool: ${name}`, true);
  try {
    // toolContext lets the client-level audit log attribute each SAP write to
    // the MCP tool that triggered it.
    const out = await toolContext.run({ tool: name }, () => handler(args));
    // A handler that RETURNED a non-2xx ADT result (vs threw) carries structured
    // metadata on _adtError — let the reporter's classifier decide if it's a
    // likely tool defect worth auto-filing. Fire-and-forget; never throws.
    if (out && out._adtError) {
      reporter.reportAdtError({ tool: name, args, ...out._adtError });
    }
    return out;
  } catch (err) {
    if (err instanceof ReadOnlyViolationError) {
      return textResult(
        JSON.stringify({ error: err.message, code: err.code }, null, 2),
        true
      );
    }
    reporter.report(err, { tool: name, args }); // fire-and-forget; never throws
    return textResult(`Error: ${err.message}`, true);
  }
});

// --- Help / validate ---------------------------------------------------------
function printHelp() {
  process.stdout.write(`${PKG.name} ${PKG.version}
${PKG.description}

Usage:
  ${PKG.name}                    Start the MCP server (stdio transport).
  ${PKG.name} --validate-config  Load config and ping every system.
  ${PKG.name} --version          Print version.
  ${PKG.name} --help             Print this message.

Environment:
  SAP_ADT_MCP_CONFIG   Path to config.json (overrides ~/.sap-adt-mcp/config.json).
  SAP_ADT_MCP_DEBUG=1  Trace every ADT request/response to stderr.

Project: ${PKG.homepage ?? PKG.repository?.url ?? ""}
`);
}

async function validateConfig() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`Loaded config from ${cfg.configPath}\n`);
  process.stdout.write(`Default system: ${cfg.defaultSystem ?? "(none)"}\n`);
  process.stdout.write(`Global readOnly: ${cfg.readOnly ? "yes" : "no"}\n\n`);

  let allOk = true;
  for (const [name, profile] of Object.entries(cfg.systems)) {
    const flags = [];
    if (profile.readOnly) flags.push("read-only");
    if (profile.rejectUnauthorized === false) flags.push("tls-skip");
    const tag = flags.length ? ` [${flags.join(", ")}]` : "";
    process.stdout.write(`  ${name}${tag} ${profile.host} ... `);
    try {
      const client = new AdtClient(profile);
      const res = await client.request({ path: "/sap/bc/adt/discovery" });
      if (res.ok) {
        process.stdout.write(`OK (HTTP ${res.status})\n`);
      } else {
        allOk = false;
        process.stdout.write(`FAIL (HTTP ${res.status})\n`);
      }
    } catch (err) {
      allOk = false;
      process.stdout.write(`FAIL (${err.message})\n`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

// --- Local control panel -----------------------------------------------------
// Always WIRED so the adt_open_panel tool can start it on demand ("paneli aç"),
// but it does not listen until either that tool is called or config.panel.enabled
// auto-starts it at boot. Either way it serves a read-only HTML button panel from
// inside this process — reachable only while this session keeps the MCP connected,
// and it dies when the process exits.
configurePanel({
  tools,
  handlers,
  config,
  version: PKG.version,
  log: (msg) => process.stderr.write(`[${PKG.name}] panel: ${msg}\n`),
});
if (config.panel?.enabled) {
  ensurePanelStarted().catch((err) =>
    process.stderr.write(`[${PKG.name}] panel: ${err.message}\n`)
  );
}

await server.connect(new StdioServerTransport());
