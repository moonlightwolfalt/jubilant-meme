#!/usr/bin/env bun
/**
 * dump-mope.ts — dump the Wayback Machine snapshot of mope.io (default: 21 March 2021)
 * into a local folder you can browse or serve.
 *
 * How it works:
 *   1. Asks the Wayback CDX API for every capture under mope.io (and its subdomains)
 *      within a window around the target date, and keeps the capture closest to it
 *      for each URL.
 *   2. Downloads each one in raw form (the `id_` URL flag, so no Wayback toolbar or
 *      rewritten links) into ./dump/<host>/<path>.
 *   3. Scans the downloaded HTML/JS/CSS/JSON for more mope.io references and fetches
 *      those too, so assets the CDX listing missed still get pulled in.
 *   4. Writes manifest.json describing what came from which capture.
 *
 * Usage:
 *   bun dump-mope.ts [--date 20210321] [--window 30] [--out dump]
 *                    [--concurrency 4] [--domain mope.io] [--no-crawl] [--dry-run]
 *   bun dump-mope.ts --serve [--out dump] [--port 8080]
 */

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, extname, resolve } from "node:path";

// ---------------------------------------------------------------- options --

type Opts = {
  date: string; // YYYYMMDD or YYYYMMDDhhmmss
  windowDays: number;
  out: string;
  concurrency: number;
  domain: string;
  crawl: boolean;
  dryRun: boolean;
  serve: boolean;
  port: number;
};

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    date: "20210321",
    windowDays: 30,
    out: "dump",
    concurrency: 4,
    domain: "mope.io",
    crawl: true,
    dryRun: false,
    serve: false,
    port: 8080,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--date": o.date = next().replace(/\D/g, ""); break;
      case "--window": o.windowDays = Number(next()); break;
      case "--out": o.out = next(); break;
      case "--concurrency": o.concurrency = Math.max(1, Number(next())); break;
      case "--domain": o.domain = next(); break;
      case "--no-crawl": o.crawl = false; break;
      case "--dry-run": o.dryRun = true; break;
      case "--serve": o.serve = true; break;
      case "--port": o.port = Number(next()); break;
      case "-h":
      case "--help":
        console.log(readHelp());
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!/^\d{8}(\d{6})?$/.test(o.date)) throw new Error(`--date must be YYYYMMDD, got ${o.date}`);
  return o;
}

function readHelp() {
  return `dump-mope.ts — dump a Wayback Machine snapshot of mope.io

  --date YYYYMMDD     target snapshot date (default 20210321)
  --window N          how many days either side to look for captures (default 30)
  --out DIR           output folder (default ./dump)
  --concurrency N     parallel downloads (default 4; be kind to archive.org)
  --domain HOST       site to dump (default mope.io, subdomains included)
  --no-crawl          only download what the CDX listing returns
  --dry-run           list what would be downloaded, write nothing
  --serve             serve an existing dump on http://localhost:PORT
  --port N            port for --serve (default 8080)`;
}

// ------------------------------------------------------------ timestamps --

/** Wayback timestamp (YYYYMMDDhhmmss, any prefix) -> epoch ms. */
function tsToMs(ts: string): number {
  const p = ts.padEnd(14, "0");
  return Date.UTC(+p.slice(0, 4), +p.slice(4, 6) - 1, +p.slice(6, 8), +p.slice(8, 10), +p.slice(10, 12), +p.slice(12, 14));
}

function msToTs(ms: number): string {
  return new Date(ms).toISOString().replace(/\D/g, "").slice(0, 14);
}

// ------------------------------------------------------------- networking --

const UA = "mope-dump/1.0 (bun; wayback snapshot archiver)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string, tries = 5): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      // archive.org answers 429 / 5xx when it wants you to slow down
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await res.body?.cancel();
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    const wait = 2000 * 2 ** attempt;
    console.warn(`  ↻ retry ${attempt + 1}/${tries - 1} in ${wait / 1000}s: ${url} (${String(lastErr)})`);
    await sleep(wait);
  }
  throw lastErr;
}

// -------------------------------------------------------------------- CDX --

type Capture = { timestamp: string; original: string; mimetype: string; status: string };

/** Normalise a URL into a dedupe key: no scheme, no www., no fragment, no default port. */
function urlKey(u: string): string {
  try {
    const url = new URL(u.startsWith("http") ? u : `http://${u}`);
    url.hash = "";
    const host = url.hostname.replace(/^www\./, "");
    return `${host}${url.pathname}${url.search}`;
  } catch {
    return u;
  }
}

async function listCaptures(o: Opts): Promise<Map<string, Capture>> {
  const target = tsToMs(o.date);
  const day = 86_400_000;
  const from = msToTs(target - o.windowDays * day).slice(0, 8);
  const to = msToTs(target + (o.windowDays + 1) * day).slice(0, 8);

  const best = new Map<string, Capture>();
  let resumeKey: string | undefined;
  let page = 0;

  do {
    const params = new URLSearchParams({
      url: o.domain,
      matchType: "domain", // mope.io + every subdomain
      from,
      to,
      output: "json",
      fl: "timestamp,original,mimetype,statuscode",
      filter: "statuscode:200",
      limit: "10000",
      showResumeKey: "true",
    });
    if (resumeKey) params.set("resumeKey", resumeKey);
    const res = await fetchRetry(`https://web.archive.org/cdx/search/cdx?${params}`);
    if (!res.ok) throw new Error(`CDX query failed: HTTP ${res.status}`);
    const text = await res.text();
    const rows: string[][] = text.trim() ? JSON.parse(text) : [];

    // Layout: [header, ...rows, [], [resumeKey]] — the trailing pair only when there is more.
    resumeKey = undefined;
    if (rows.length >= 2 && rows[rows.length - 2].length === 0) {
      resumeKey = rows[rows.length - 1][0];
      rows.splice(rows.length - 2, 2);
    }
    for (const [timestamp, original, mimetype, status] of rows.slice(1)) {
      if (!timestamp || !original) continue;
      const key = urlKey(original);
      const prev = best.get(key);
      const dist = Math.abs(tsToMs(timestamp) - target);
      if (!prev || dist < Math.abs(tsToMs(prev.timestamp) - target)) {
        best.set(key, { timestamp, original, mimetype, status });
      }
    }
    page++;
    console.log(`  CDX page ${page}: ${rows.length - 1} rows, ${best.size} unique URLs so far`);
  } while (resumeKey);

  return best;
}

// -------------------------------------------------------------- local paths --

const SAFE = (s: string) => s.replace(/[<>:"\\|?*\x00-\x1f]/g, "_");

/** Where a URL lives on disk under the output folder. */
function localPath(out: string, original: string, mimetype?: string): string {
  const url = new URL(original.startsWith("http") ? original : `http://${original}`);
  const host = url.hostname.replace(/^www\./, "");
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/") || path === "") path += "index.html";
  else if (!extname(path) && mimetype?.includes("html")) path += "/index.html";
  if (url.search) {
    // keep query variants distinct: foo.js?v=3 -> foo.js__v=3.js
    const ext = extname(path);
    path = `${path}__${SAFE(url.search.slice(1)).slice(0, 80)}${ext}`;
  }
  const parts = path.split("/").filter((p) => p && p !== "." && p !== "..").map(SAFE);
  return join(out, host, ...parts);
}

// ------------------------------------------------------------------ crawl --

const TEXTY = /\.(html?|js|mjs|css|json|txt|xml|svg|webmanifest)$/i;
const ASSET_EXT = "png|jpe?g|gif|webp|svg|ico|mp3|ogg|wav|m4a|js|css|json|html?|woff2?|ttf|otf|eot|txt|xml|webmanifest|wasm";

/** Pull candidate URLs out of an HTML/JS/CSS body. */
function extractRefs(body: string, base: string, domain: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    raw = raw.trim().replace(/\\\//g, "/");
    if (!raw || /^(data:|javascript:|mailto:|about:|blob:|#)/i.test(raw)) return;
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return;
      const host = u.hostname.toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) return;
      u.hash = "";
      found.add(u.href);
    } catch {}
  };

  // HTML attributes
  for (const m of body.matchAll(/\b(?:src|href|data-src|poster|content)\s*=\s*["']([^"'<>]+)["']/gi)) add(m[1]);
  // srcset
  for (const m of body.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi))
    for (const part of m[1].split(",")) add(part.trim().split(/\s+/)[0]);
  // CSS url() and @import
  for (const m of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
  for (const m of body.matchAll(/@import\s+["']([^"']+)["']/gi)) add(m[1]);
  // String literals in JS that look like asset paths ("img/foo.png", "/audio/x.mp3", "https://mope.io/...")
  const lit = new RegExp(`["'\`]((?:https?:)?\\/{0,2}[\\w./\\-@%~+]*\\.(?:${ASSET_EXT})(?:\\?[\\w=&.\\-]*)?)["'\`]`, "gi");
  for (const m of body.matchAll(lit)) add(m[1]);

  return [...found];
}

// --------------------------------------------------------------- download --

type Entry = {
  url: string;
  timestamp?: string;
  file?: string;
  bytes?: number;
  status: "ok" | "missing" | "error" | "skipped";
  note?: string;
};

async function exists(p: string) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function dump(o: Opts) {
  const out = resolve(o.out);
  console.log(`🦊 dumping ${o.domain} as it was around ${o.date} (±${o.windowDays}d) → ${out}`);

  console.log("📜 asking the Wayback CDX index what it has…");
  const captures = await listCaptures(o);
  console.log(`   ${captures.size} unique URLs found`);

  // Make sure the homepage is always in the queue even if CDX was shy about it.
  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (u: string) => {
    const k = urlKey(u);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push(u);
  };
  enqueue(`https://${o.domain}/`);
  for (const c of captures.values()) enqueue(c.original);

  if (o.dryRun) {
    for (const u of queue) {
      const c = captures.get(urlKey(u));
      console.log(`${c?.timestamp ?? "(nearest)"}  ${u}`);
    }
    return;
  }

  const manifest: Entry[] = [];
  let done = 0;

  const work = async (url: string) => {
    const cap = captures.get(urlKey(url));
    // With an exact capture use its timestamp; otherwise let Wayback redirect to the nearest one.
    const ts = cap?.timestamp ?? o.date;
    const wb = `https://web.archive.org/web/${ts}id_/${cap?.original ?? url}`;
    const file = localPath(out, cap?.original ?? url, cap?.mimetype);
    const entry: Entry = { url, timestamp: cap?.timestamp, file: file.slice(out.length + 1), status: "ok" };

    try {
      let body: Uint8Array;
      let contentType = cap?.mimetype ?? "";
      if (await exists(file)) {
        body = new Uint8Array(await readFile(file));
        entry.note = "already on disk";
      } else {
        const res = await fetchRetry(wb);
        if (!res.ok) {
          entry.status = "missing";
          entry.note = `HTTP ${res.status}`;
          await res.body?.cancel();
          return;
        }
        const m = res.url.match(/\/web\/(\d{14})/);
        if (m) entry.timestamp = m[1];
        contentType = res.headers.get("content-type") ?? contentType;
        body = new Uint8Array(await res.arrayBuffer());
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
      }
      entry.bytes = body.byteLength;

      if (o.crawl && (TEXTY.test(file) || /html|javascript|css|json/.test(contentType))) {
        const text = new TextDecoder().decode(body);
        for (const ref of extractRefs(text, cap?.original ?? url, o.domain)) enqueue(ref);
      }
    } catch (e) {
      entry.status = "error";
      entry.note = String(e);
    } finally {
      manifest.push(entry);
      done++;
      const icon = entry.status === "ok" ? "✓" : entry.status === "missing" ? "·" : "✗";
      console.log(`[${done}/${queue.length}] ${icon} ${entry.timestamp ?? "????????"} ${url}${entry.note ? `  (${entry.note})` : ""}`);
    }
  };

  // Simple worker pool that keeps draining the queue as the crawl grows it.
  let next = 0;
  let active = 0;
  const workers = Array.from({ length: o.concurrency }, async () => {
    while (true) {
      if (next >= queue.length) {
        // another worker may still be adding refs; wait briefly before giving up
        await sleep(250);
        if (next >= queue.length && active === 0) return;
        continue;
      }
      const url = queue[next++];
      active++;
      try {
        await work(url);
      } finally {
        active--;
      }
    }
  });
  await Promise.all(workers);

  manifest.sort((a, b) => a.url.localeCompare(b.url));
  const summary = {
    domain: o.domain,
    targetDate: o.date,
    windowDays: o.windowDays,
    generatedAt: new Date().toISOString(),
    counts: {
      ok: manifest.filter((e) => e.status === "ok").length,
      missing: manifest.filter((e) => e.status === "missing").length,
      error: manifest.filter((e) => e.status === "error").length,
    },
    files: manifest,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "manifest.json"), JSON.stringify(summary, null, 2));

  console.log(`\n🌙 done: ${summary.counts.ok} saved, ${summary.counts.missing} not archived, ${summary.counts.error} errors`);
  console.log(`   manifest: ${join(out, "manifest.json")}`);
  console.log(`   browse it: bun dump-mope.ts --serve --out ${o.out}`);
}

// ------------------------------------------------------------------ serve --

function serve(o: Opts) {
  const root = join(resolve(o.out), o.domain);
  Bun.serve({
    port: o.port,
    async fetch(req) {
      const { pathname, search } = new URL(req.url);
      const target = localPath(resolve(o.out), `http://${o.domain}${pathname}${search}`);
      for (const candidate of [target, join(target, "index.html")]) {
        const f = Bun.file(candidate);
        if (await f.exists()) return new Response(f);
      }
      return new Response("not in the dump 🍂", { status: 404 });
    },
  });
  console.log(`🌲 serving ${root} on http://localhost:${o.port}`);
  console.log("   note: the game itself needs the old websocket servers, which are long gone —");
  console.log("   you'll get the menus, art and client code, not live matches.");
}

// ------------------------------------------------------------------- main --

const opts = parseArgs(Bun.argv.slice(2));
if (opts.serve) serve(opts);
else
  await dump(opts).catch((e) => {
    console.error(`✗ ${e?.stack ?? e}`);
    process.exit(1);
  });
