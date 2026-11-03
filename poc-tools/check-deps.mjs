#!/usr/bin/env node
// check-deps.mjs
// Checks that every package Kaneo needs is downloadable from an internal npm mirror,
// BEFORE you install anything. Needs only Node.js 18+ (no npm packages).
//
// Usage (PowerShell):
//   node check-deps.mjs --registry https://<your-npm-mirror>/repository/<npm-repo>/
//   node check-deps.mjs                       # uses the registry from `npm config get registry`
//
// Authentication (only if your mirror needs it), set ONE of these first:
//   $env:REGISTRY_TOKEN    = "<token>"              -> sends "Authorization: Bearer <token>"
//   $env:REGISTRY_USER     = "<user>"; $env:REGISTRY_PASSWORD = "<password>"   -> Basic auth
// Internal certificate authority: $env:NODE_EXTRA_CA_CERTS = "C:\path\to\company-ca.pem"
//
// Options:
//   --list <file>         package list (default: kaneo-packages.txt next to this script)
//   --concurrency <n>     parallel requests (default 8)
//   --no-tarball          only check metadata, skip the tarball download check
//
// Output: a summary on screen, plus next to this script:
//   check-report.csv      one row per package with its status
//   missing-packages.txt  only the failures, ready to send to your security / repository team

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

let registry = opt("--registry", "");
if (!registry) {
  try {
    registry = execSync("npm config get registry", { encoding: "utf8" }).trim();
  } catch {
    registry = "";
  }
}
if (!registry || registry === "undefined") {
  console.error("No registry. Pass --registry <url of your internal npm mirror>.");
  process.exit(2);
}
if (!registry.endsWith("/")) registry += "/";

const listFile = opt("--list", join(here, "kaneo-packages.txt"));
const concurrency = Math.max(1, Number(opt("--concurrency", "8")) || 8);
const checkTarball = !args.includes("--no-tarball");

const headers = { "user-agent": "kaneo-dependency-check" };
if (process.env.REGISTRY_TOKEN) {
  headers.authorization = `Bearer ${process.env.REGISTRY_TOKEN}`;
} else if (process.env.REGISTRY_USER) {
  const basic = Buffer.from(`${process.env.REGISTRY_USER}:${process.env.REGISTRY_PASSWORD ?? ""}`).toString("base64");
  headers.authorization = `Basic ${basic}`;
}

// ---- read the package list ----
const wanted = [];
for (const raw of readFileSync(listFile, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const [spec, integrity = ""] = line.split("\t");
  const at = spec.lastIndexOf("@");
  if (at <= 0) continue;
  wanted.push({ name: spec.slice(0, at), version: spec.slice(at + 1), integrity: integrity.trim() });
}
console.log(`Registry : ${registry}`);
console.log(`Packages : ${wanted.length} (from ${listFile})`);
console.log(`Checking metadata${checkTarball ? " and tarball downloads" : ""}, ${concurrency} at a time...\n`);

// ---- http helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, init = {}, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < tries) {
        await sleep(1000 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

const encodeName = (name) => encodeURIComponent(name).replace(/^%40/, "@");
const metaCache = new Map();
function getMetadata(name) {
  if (!metaCache.has(name)) {
    metaCache.set(
      name,
      (async () => {
        const res = await request(registry + encodeName(name), {
          headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
        });
        if (res.status !== 200) return { status: res.status };
        return { status: 200, body: await res.json() };
      })(),
    );
  }
  return metaCache.get(name);
}

async function tarballOk(url) {
  let res = await request(url, { method: "HEAD" });
  if (res.status === 405 || res.status === 501) {
    res = await request(url, { headers: { range: "bytes=0-0" } });
    try { await res.body?.cancel(); } catch {}
  }
  return res.status;
}

// ---- check one package ----
async function check(pkg) {
  try {
    const meta = await getMetadata(pkg.name);
    if (meta.status === 401 || meta.status === 403) return { ...pkg, status: "AUTH_OR_BLOCKED", detail: `metadata HTTP ${meta.status}` };
    if (meta.status === 404) return { ...pkg, status: "MISSING_PACKAGE", detail: "package not found on mirror" };
    if (meta.status !== 200) return { ...pkg, status: "ERROR", detail: `metadata HTTP ${meta.status}` };
    const v = meta.body.versions?.[pkg.version];
    if (!v) return { ...pkg, status: "MISSING_VERSION", detail: "this version is not available on the mirror" };
    const dist = v.dist ?? {};
    if (pkg.integrity && dist.integrity && dist.integrity !== pkg.integrity) {
      return { ...pkg, status: "INTEGRITY_MISMATCH", detail: "mirror serves different file contents than the lockfile expects" };
    }
    if (!checkTarball) return { ...pkg, status: "OK", detail: "metadata only" };
    if (!dist.tarball) return { ...pkg, status: "ERROR", detail: "no tarball URL in metadata" };
    const t = await tarballOk(dist.tarball);
    if (t === 200 || t === 206) return { ...pkg, status: "OK", detail: "" };
    if (t === 401 || t === 403) return { ...pkg, status: "TARBALL_BLOCKED", detail: `download HTTP ${t} (often a security-policy block)` };
    return { ...pkg, status: "TARBALL_ERROR", detail: `download HTTP ${t}` };
  } catch (err) {
    return { ...pkg, status: "ERROR", detail: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

// ---- preflight: is the registry reachable at all? ----
try {
  const probe = await getMetadata(wanted[0].name);
  if (probe.status === 401) {
    console.error("The mirror answered 401 Unauthorized. Set REGISTRY_TOKEN or REGISTRY_USER/REGISTRY_PASSWORD and retry.");
    process.exit(2);
  }
} catch (err) {
  console.error(`Cannot reach ${registry}: ${err?.cause?.code ?? err?.message ?? err}`);
  console.error("Check the URL, VPN/proxy, and NODE_EXTRA_CA_CERTS if your mirror uses an internal certificate.");
  process.exit(2);
}

// ---- run with a small worker pool ----
const results = new Array(wanted.length);
let next = 0, done = 0;
async function worker() {
  while (next < wanted.length) {
    const i = next++;
    results[i] = await check(wanted[i]);
    done++;
    if (done % 100 === 0 || done === wanted.length) process.stdout.write(`  ${done}/${wanted.length} checked\r`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log("");

// ---- report ----
const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;
writeFileSync(
  join(here, "check-report.csv"),
  ["name,version,status,detail", ...results.map((r) => [r.name, r.version, r.status, r.detail].map(csvCell).join(","))].join("\r\n") + "\r\n",
);
const failed = results.filter((r) => r.status !== "OK");
writeFileSync(
  join(here, "missing-packages.txt"),
  failed.map((r) => `${r.name}@${r.version}\t${r.status}\t${r.detail}`).join("\r\n") + (failed.length ? "\r\n" : ""),
);

const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log("Summary:");
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(18)} ${v}`);
if (failed.length) {
  console.log(`\n${failed.length} package(s) are NOT available. First 25:`);
  for (const r of failed.slice(0, 25)) console.log(`  ${r.name}@${r.version}  ${r.status}  ${r.detail}`);
  console.log(`\nFull list: ${join(here, "missing-packages.txt")}  (send this to your repository/security team)`);
  process.exit(1);
} else {
  console.log("\nAll packages are available from the mirror.");
}
