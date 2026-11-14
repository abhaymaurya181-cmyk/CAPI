#!/usr/bin/env node
// Deploy lucira-capi to Google Cloud — ONE script for Windows, Linux and macOS.
//
// This replaces the old cloud-run.sh / cloud-scheduler.sh (bash-only). Everyone
// on the team runs this same file on their own system, so a change made here
// applies to all of us — there is no second copy to keep in sync. Please keep
// it that way: don't add an OS-specific deploy script next to it.
//
// Needs: Node 22+ and the gcloud CLI (logged in: `gcloud auth login`).
//
// Usage (same on every OS; run from the repo root or anywhere):
//   node deploy/deploy.mjs secret <NAME> --project <gcp-project>   # store a secret (asks, hidden)
//   node deploy/deploy.mjs grant         --project <gcp-project>   # let Cloud Run read secrets + Firestore
//   node deploy/deploy.mjs service       --project <gcp-project> [--dry-run]
//   node deploy/deploy.mjs scheduler     --project <gcp-project> [--dry-run]
//   node deploy/deploy.mjs all           --project <gcp-project> [--dry-run]   # service + scheduler
// Options: --region (default us-central1), --service (default lucira-capi),
//          --service-account <email>: for `grant`, the SA that gets the IAM
//          bindings; for `service` / `all`, the SA Cloud Run will run as.
//          Default on both is the project's Compute default SA.
// --dry-run prints exactly what would happen and changes nothing.
//
// Non-secret settings use production defaults (see SETTINGS below). Override
// one by setting an environment variable before running:
//   Windows PowerShell:  $env:GOOGLE_VALIDATE_ONLY="false"; node deploy/deploy.mjs service --project p
//   Linux / macOS:       GOOGLE_VALIDATE_ONLY=false node deploy/deploy.mjs service --project p
//
// Secrets live in Google Secret Manager (never in this file, git or chat).
// Only LUCIRA_CREDS_CAPI and INTERNAL_TOKEN are required; each integration is
// attached once its secrets exist, so we can go live in stages.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------- config

export const REQUIRED_SECRETS = ["LUCIRA_CREDS_CAPI", "INTERNAL_TOKEN"];

/** Integration secrets: attached only if they exist (staged go-live). */
export const SECRET_GROUPS = {
  OrnaVerse: ["ORNAVERSE_API_BASE", "ORNAVERSE_CLIENT_ID", "ORNAVERSE_CLIENT_SECRET"],
  Meta: ["META_PIXEL_ID", "META_CAPI_ACCESS_TOKEN"],
  Google: [
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_CONVERSION_ACTION_PURCHASE",
    "GOOGLE_ADS_CONVERSION_ACTION_STORE_VISIT",
  ],
  // Only if the Google Ads account sits under a manager (MCC) account.
  GoogleManager: ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
};

/** Non-secret settings and their production defaults (env var overrides). */
export const SETTINGS = {
  GOOGLE_VALIDATE_ONLY: "false", // live: real Purchase conversions reach Google Ads
  // All three event streams are live. Keep the separate flags so we can stage
  // a new one back into validate-only without touching the others.
  GOOGLE_STORE_VISIT_VALIDATE_ONLY: "false",
  GOOGLE_WEBSITE_VALIDATE_ONLY: "false",
  ORNAVERSE_SCOPE: "openid",
  ORNAVERSE_POSTED_STATUSES: "1", // 1 = posted; returns (2) are never imported
  ORNAVERSE_INITIAL_LOOKBACK_DAYS: "7",
  ORNAVERSE_HOURLY_LOOKBACK_DAYS: "3",
  ORNAVERSE_RESCAN_DAYS: "30",
  CLICK_MODE: "last",
  CLICK_WINDOW_DAYS: "90",
  META_API_VERSION: "v20.0",
  ADMIN_USERNAME: "admin",
  LOG_LEVEL: "info",
};

/** Cloud Scheduler jobs. Schedules are cron, Asia/Kolkata (override via env). */
export const JOBS = [
  { suffix: "retry-sweep", path: "/internal/retry-sweep", scheduleEnv: "SCHEDULE", schedule: "*/5 * * * *" },
  { suffix: "sync-offline", path: "/internal/sync-offline", scheduleEnv: "SYNC_SCHEDULE", schedule: "0 * * * *" },
  // Off the hour on purpose: shares a lock with the hourly pull.
  {
    suffix: "sync-offline-rescan",
    path: "/internal/sync-offline-rescan",
    scheduleEnv: "RESCAN_SCHEDULE",
    schedule: "30 3 * * *",
  },
  // Marketplace / online orders: separate lock from the POS feed, so the two
  // run in parallel. Hourly pull at :15 to stagger from the POS pull at :00.
  {
    suffix: "sync-online",
    path: "/internal/sync-online",
    scheduleEnv: "SYNC_ONLINE_SCHEDULE",
    schedule: "15 * * * *",
  },
  {
    suffix: "sync-online-rescan",
    path: "/internal/sync-online-rescan",
    scheduleEnv: "RESCAN_ONLINE_SCHEDULE",
    schedule: "45 3 * * *",
  },
  // CRM customer walk-in visits (store foot-fall). Separate lock, staggered
  // off POS and marketplace so all three can run in parallel hourly.
  {
    suffix: "sync-visits",
    path: "/internal/sync-visits",
    scheduleEnv: "SYNC_VISITS_SCHEDULE",
    schedule: "30 * * * *",
  },
  {
    suffix: "sync-visits-rescan",
    path: "/internal/sync-visits-rescan",
    scheduleEnv: "RESCAN_VISITS_SCHEDULE",
    schedule: "0 4 * * *",
  },
  // POS Orders feed (replaces POS/Invoice as the primary store-sale source).
  // Reports event_time = order creation date, so advance orders credit the
  // right day. Scheduled off the existing POS/Invoice job; pause the old one
  // in Cloud Scheduler UI after cutover so both don't produce conversions.
  {
    suffix: "sync-pos-orders",
    path: "/internal/sync-pos-orders",
    scheduleEnv: "SYNC_POS_ORDERS_SCHEDULE",
    schedule: "45 * * * *",
  },
  {
    suffix: "sync-pos-orders-rescan",
    path: "/internal/sync-pos-orders-rescan",
    scheduleEnv: "RESCAN_POS_ORDERS_SCHEDULE",
    schedule: "15 4 * * *",
  },
  // MarketPlace Order placeholders (pending_invoice=true). Stagger from the
  // Invoice feed (:15) so both can run in the same hour.
  {
    suffix: "sync-online-orders",
    path: "/internal/sync-online-orders",
    scheduleEnv: "SYNC_ONLINE_ORDERS_SCHEDULE",
    schedule: "50 * * * *",
  },
  {
    suffix: "sync-online-orders-rescan",
    path: "/internal/sync-online-orders-rescan",
    scheduleEnv: "RESCAN_ONLINE_ORDERS_SCHEDULE",
    schedule: "30 4 * * *",
  },
];

// ---------------------------------------------------------------- pure helpers (unit-tested)

/**
 * Which secrets to attach, given the set that exist with a value.
 * Returns errors (deploy must stop), warnings, the attach list and what's missing.
 */
export function planSecrets(existing) {
  const errors = REQUIRED_SECRETS.filter((s) => !existing.has(s)).map(
    (s) => `required secret ${s} is missing (or has no value) in Secret Manager`
  );
  const warnings = [];
  const attach = REQUIRED_SECRETS.filter((s) => existing.has(s));
  const missing = [];
  for (const [group, names] of Object.entries(SECRET_GROUPS)) {
    const have = names.filter((s) => existing.has(s));
    attach.push(...have);
    missing.push(...names.filter((s) => !existing.has(s)));
    if (have.length > 0 && have.length < names.length) {
      warnings.push(`${group} is partly configured (${have.length}/${names.length}): missing ${names.filter((s) => !existing.has(s)).join(", ")}`);
    }
  }
  return { errors, warnings, attach, missing };
}

/** Env vars for the service: defaults overridden by the caller's environment. */
export function planSettings(projectId, env = process.env) {
  const out = { NODE_ENV: "production", GOOGLE_CLOUD_PROJECT: projectId };
  for (const [k, def] of Object.entries(SETTINGS)) out[k] = env[k] ?? def;
  const warnings = [];
  if (env.META_TEST_EVENT_CODE) {
    out.META_TEST_EVENT_CODE = env.META_TEST_EVENT_CODE;
    warnings.push("META_TEST_EVENT_CODE is set — Meta events go to Test Events only, not real reports.");
  }
  return { settings: out, warnings };
}

/**
 * Settings as a YAML file for `--env-vars-file`. JSON strings are valid YAML,
 * so any value (commas, colons, quotes) is passed exactly — no delimiter tricks.
 */
export function settingsYaml(settings) {
  return Object.entries(settings)
    .map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`)
    .join("\n") + "\n";
}

/**
 * Windows runs gcloud through cmd.exe (gcloud is a .cmd file). Each argument
 * is wrapped in double quotes, where cmd treats | & < > ^ as plain text.
 * `"` and `%` can't be made safe there, so they are refused instead of
 * silently changing the command.
 */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (/["%\r\n]/.test(s)) throw new Error(`unsafe character (" or % or newline) in argument: ${s.slice(0, 30)}`);
  // A trailing backslash would escape the closing quote.
  return `"${s.endsWith("\\") ? s + "\\" : s}"`;
}

/**
 * Clean a typed or piped secret: drop the BOM Windows PowerShell adds when
 * piping, and the line break at the end; then trim spaces (reported, since a
 * space is rarely intended in an id or token).
 */
export function cleanSecretInput(raw) {
  const noMarkers = String(raw).replace(/^﻿/, "").replace(/\r?\n$/, "");
  const value = noMarkers.trim();
  return { value, trimmedSpaces: value !== noMarkers };
}

/** The scheduler's Authorization header value must survive gcloud's comma-separated --headers. */
export function checkInternalToken(token) {
  if (!token) throw new Error("INTERNAL_TOKEN secret is empty");
  if (/[,"%\s]/.test(token)) {
    throw new Error("INTERNAL_TOKEN contains a comma, quote, % or space — use letters/digits/-/_ only");
  }
  return token;
}

// ---------------------------------------------------------------- gcloud runner

// `input` is written to gcloud's stdin (used for secret values, so they never
// appear in the command line, process list or shell history).
function gcloud(args, { capture = false, allowFail = false, cwd = REPO_ROOT, input } = {}) {
  const stdio = [input != null ? "pipe" : "ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"];
  const res = IS_WINDOWS
    ? spawnSync(["gcloud", ...args.map(quoteForCmd)].join(" "), { shell: true, cwd, encoding: "utf8", stdio, input })
    : spawnSync("gcloud", args, { cwd, encoding: "utf8", stdio, input });
  if (res.error) throw new Error(`could not run gcloud (is it installed and on PATH?): ${res.error.message}`);
  if (res.status !== 0 && !allowFail) {
    throw new Error(`gcloud ${args.slice(0, 3).join(" ")} … failed (exit ${res.status})${capture && res.stderr ? ": " + res.stderr.trim().split("\n").pop() : ""}`);
  }
  return { ok: res.status === 0, stdout: (res.stdout ?? "").trim() };
}

/** True if the secret has an enabled latest version. Reads metadata only, never the value. */
function secretHasValue(name, project) {
  const r = gcloud(
    ["secrets", "versions", "describe", "latest", "--secret", name, "--project", project, "--format", "value(state)"],
    { capture: true, allowFail: true }
  );
  return r.ok && r.stdout === "ENABLED";
}

function printCmd(args) {
  console.log("  gcloud " + args.map((a) => (/[\s|&^<>()]/.test(a) ? JSON.stringify(a) : a)).join(" "));
}

// ---------------------------------------------------------------- commands

function deployService(opts) {
  const { project, region, service, dryRun, serviceAccount } = opts;
  const image = `${region}-docker.pkg.dev/${project}/lucira-capi/${service}:latest`;

  const existing = new Set(ALL_SECRETS.filter((s) => secretHasValue(s, project)));
  const secrets = planSecrets(existing);
  const settings = planSettings(project);

  for (const w of [...secrets.warnings, ...settings.warnings]) console.warn("WARNING: " + w);
  if (secrets.missing.length) console.log("Not attached (no secret / no value yet): " + secrets.missing.join(", "));
  if (secrets.errors.length) {
    for (const e of secrets.errors) console.error("ERROR: " + e);
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "lucira-deploy-"));
  const envFile = join(tmp, "env.yaml");
  writeFileSync(envFile, settingsYaml(settings.settings));

  const buildArgs = ["builds", "submit", "--project", project, "--tag", image, "."];
  const deployArgs = [
    "run", "deploy", service,
    "--project", project, "--region", region, "--image", image,
    "--platform", "managed", "--allow-unauthenticated", "--port", "8080",
    "--memory", "512Mi", "--cpu", "1", "--concurrency", "80",
    "--min-instances", "0", "--max-instances", "10",
    "--env-vars-file", envFile,
    "--set-secrets", secrets.attach.map((s) => `${s}=${s}:latest`).join(","),
    // When set, Cloud Run runs the container as this SA instead of the project's
    // default compute SA. Required for Google Ads: only the identity added as a
    // user in Google Ads can call the Data Manager API — a mismatch here = 403.
    ...(serviceAccount ? ["--service-account", serviceAccount] : []),
  ];

  try {
    if (dryRun) {
      console.log(`\nDRY RUN — nothing is built or changed. Would run (from ${REPO_ROOT}):`);
      printCmd(buildArgs);
      printCmd(deployArgs);
      console.log("\nSettings (env vars) that would be set:\n" + settingsYaml(settings.settings).replace(/^/gm, "  "));
      return;
    }
    console.log(`Building image ${image}`);
    gcloud(buildArgs);
    console.log("Deploying to Cloud Run");
    gcloud(deployArgs);
    const url = gcloud(
      ["run", "services", "describe", service, "--project", project, "--region", region, "--format", "value(status.url)"],
      { capture: true }
    ).stdout;
    console.log(`Service URL: ${url}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function deployScheduler(opts) {
  const { project, region, service, dryRun } = opts;
  const tz = process.env.SCHEDULER_TZ ?? "Asia/Kolkata";

  const url = dryRun
    ? `https://<${service}-url>`
    : gcloud(
        ["run", "services", "describe", service, "--project", project, "--region", region, "--format", "value(status.url)"],
        { capture: true }
      ).stdout;
  if (!url) throw new Error(`Cloud Run service ${service} not found — deploy the service first`);

  // Read the token only for real runs; it is never printed.
  const token = dryRun
    ? "<INTERNAL_TOKEN>"
    : checkInternalToken(
        gcloud(["secrets", "versions", "access", "latest", "--secret", "INTERNAL_TOKEN", "--project", project], {
          capture: true,
        }).stdout
      );

  for (const job of JOBS) {
    const name = `${service}-${job.suffix}`;
    const schedule = process.env[job.scheduleEnv] ?? job.schedule;
    const exists = !dryRun && gcloud(
      ["scheduler", "jobs", "describe", name, "--project", project, "--location", region],
      { capture: true, allowFail: true }
    ).ok;
    const verb = exists ? "update" : "create";
    const args = [
      "scheduler", "jobs", verb, "http", name,
      "--project", project, "--location", region,
      "--schedule", schedule, "--time-zone", tz,
      "--uri", `${url}${job.path}`, "--http-method", "POST",
      "--attempt-deadline", "600s",
      verb === "create" ? "--headers" : "--update-headers",
      `Authorization=Bearer ${token},Content-Type=application/json`,
      "--message-body", "{}",
    ];
    if (dryRun) {
      console.log(`${name}: create-or-update, ${schedule} (${tz}) → ${job.path}`);
      continue;
    }
    console.log(`${verb} ${name}: ${job.path} (${schedule} ${tz})`);
    gcloud(args, { capture: true }); // captured so the token in the args never echoes
  }
}

/** All secret names this service knows about (required + every integration). */
export const ALL_SECRETS = [...REQUIRED_SECRETS, ...Object.values(SECRET_GROUPS).flat()];

/** Ask for a value without showing it (works in PowerShell, cmd, bash, zsh). */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    // Piped input (e.g. from a password manager CLI): read it as-is.
    return new Promise((res) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => res(data.replace(/\r?\n$/, "")));
    });
  }
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let asked = false;
    rl._writeToOutput = (s) => {
      if (!asked) process.stdout.write(s); // show the question once, then hide typing
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      res(answer);
    });
    asked = true;
  });
}

async function storeSecret(opts) {
  const { project, secretName: name } = opts;
  const clean = cleanSecretInput(await askHidden(`Value for ${name} (hidden): `));
  if (!clean.value) throw new Error("empty value — nothing stored");
  if (clean.trimmedSpaces) console.warn("WARNING: value had leading/trailing spaces; they were removed.");
  const value = clean.value;
  const exists = gcloud(["secrets", "describe", name, "--project", project], { capture: true, allowFail: true }).ok;
  if (exists) {
    gcloud(["secrets", "versions", "add", name, "--project", project, "--data-file=-"], { capture: true, input: value });
    console.log(`${name}: new version added (older versions stay until you disable them).`);
  } else {
    gcloud(
      ["secrets", "create", name, "--project", project, "--replication-policy=automatic", "--data-file=-"],
      { capture: true, input: value }
    );
    console.log(`${name}: created.`);
  }
  console.log("Run `grant` once after adding new secrets, then redeploy the service.");
}

function grantAccess(opts) {
  const { project, dryRun } = opts;
  let sa = opts.serviceAccount;
  if (!sa) {
    const num = dryRun
      ? "<project-number>"
      : gcloud(["projects", "describe", project, "--format", "value(projectNumber)"], { capture: true }).stdout;
    sa = `${num}-compute@developer.gserviceaccount.com`;
  }
  const member = `serviceAccount:${sa}`;
  const present = dryRun ? ALL_SECRETS : ALL_SECRETS.filter((s) => secretHasValue(s, project));
  console.log(`Granting ${sa}:`);
  for (const s of present) {
    console.log(`  secret ${s} → secretAccessor`);
    if (!dryRun) {
      gcloud(
        ["secrets", "add-iam-policy-binding", s, "--project", project, "--member", member, "--role", "roles/secretmanager.secretAccessor"],
        { capture: true }
      );
    }
  }
  console.log(`  project ${project} → datastore.user (Firestore)`);
  if (!dryRun) {
    gcloud(
      ["projects", "add-iam-policy-binding", project, "--member", member, "--role", "roles/datastore.user", "--condition=None"],
      { capture: true }
    );
  }
  console.log(`Also add ${sa} as a user in Google Ads (Admin → Access and security) for the Data Manager API.`);
}

// ---------------------------------------------------------------- CLI

const COMMANDS = ["secret", "grant", "service", "scheduler", "all"];
const OPTION_KEYS = { "--project": "project", "--region": "region", "--service": "service", "--service-account": "serviceAccount" };

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {
    command,
    project: process.env.PROJECT_ID,
    // us-central1 because asia-south1 blocks the beta run domain-mappings API
    // we need for track.lucirajewelry.com. Changing this strands the Cloud
    // Run service away from the live domain mapping — see 2026-10-27 fix.
    region: "us-central1",
    service: "lucira-capi",
    dryRun: process.env.DRY_RUN === "1",
  };
  if (!COMMANDS.includes(command ?? "")) throw new Error(`command must be one of: ${COMMANDS.join(", ")}`);
  if (command === "secret") {
    opts.secretName = rest.shift();
    if (!opts.secretName || !ALL_SECRETS.includes(opts.secretName)) {
      throw new Error(`secret needs a known name: ${ALL_SECRETS.join(", ")}`);
    }
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a in OPTION_KEYS) {
      const v = rest[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[OPTION_KEYS[a]] = v;
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!opts.project) throw new Error("--project <gcp-project> is required");
  for (const k of ["project", "region", "service"]) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(opts[k])) throw new Error(`invalid --${k}: ${opts[k]}`);
  }
  if (opts.serviceAccount && !/^[a-z0-9-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$|^\d+-compute@developer\.gserviceaccount\.com$/.test(opts.serviceAccount)) {
    throw new Error(`invalid --service-account: ${opts.serviceAccount}`);
  }
  if (command === "secret" && opts.dryRun) throw new Error("secret has no --dry-run (it only asks and stores)");
  return opts;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.command === "secret") await storeSecret(opts);
    if (opts.command === "grant") grantAccess(opts);
    if (opts.command === "service" || opts.command === "all") deployService(opts);
    if (opts.command === "scheduler" || opts.command === "all") deployScheduler(opts);
  } catch (err) {
    console.error("ERROR: " + err.message);
    console.error("Usage: node deploy/deploy.mjs <secret NAME|grant|service|scheduler|all> --project <gcp-project> [--dry-run]");
    process.exit(1);
  }
}
