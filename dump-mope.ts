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
 *   bun dump-mope.ts --live --domain v1.mope.io   # crawl the live site instead
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
  live: boolean;
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
    live: false,
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
      case "--live": o.live = true; break;
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
  --live              crawl the live site instead of the Wayback Machine
                      (e.g. --live --domain v1.mope.io)
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
    // reject things that are clearly not URLs (meta-tag prose, JS expressions)
    if (!/^[\w./\-~%:@?=&+#;!$']+$/.test(raw) || !/[./]/.test(raw)) return;
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return;
      const host = u.hostname.toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) return;
      if (u.pathname.startsWith("/cdn-cgi/")) return; // Cloudflare's own scripts
      u.hash = "";
      found.add(u.href);
    } catch {}
  };

  // HTML attributes (meta content only when it looks like a file)
  for (const m of body.matchAll(/\bcontent\s*=\s*["']([^"'<>\s]+\.\w{2,5})["']/gi)) add(m[1]);
  for (const m of body.matchAll(/\b(?:src|href|data-src|poster)\s*=\s*["']([^"'<>]+)["']/gi)) add(m[1]);
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

/** Undo `\xNN` string escaping, which obfuscated game clients use to hide paths. */
function unescapeHex(js: string): string {
  return js.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => {
    const c = String.fromCharCode(parseInt(h, 16));
    return c === "'" || c === '"' || c === "\\" ? `\\${c}` : c;
  });
}

/**
 * mope.io builds most image paths at runtime, e.g.
 *   './assets/s/' + seasonID + '/skins/' + 'land/rabbit/200/rabbit' + '.png'
 * so they never appear whole in the source. Rebuild likely paths from the
 * fragments that do appear. Returned paths are relative to an asset root
 * (the site root or an assets/s/<season>/ folder).
 */
function guessGamePaths(js: string): string[] {
  const out = new Set<string>();
  const strs = [...js.matchAll(/'([^'\\\n]{1,120})'|"([^"\\\n]{1,120})"/g)].map((m) => m[1] ?? m[2]);

  // whole files: 'img/snowball.png', 'audio/click.mp3', 'shop/gem.png'
  for (const s of strs)
    if (/^\.?\/?[\w\-]+(\/[\w\-.]+)+\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav|json)$/i.test(s))
      out.add(s.replace(/^\.?\//, ""));

  // full skin ids: 'land/rabbit/200/rabbit'
  const animalDirs = new Set<string>();
  for (const s of strs) {
    const m = s.match(/^([a-z]+)\/(\w+)\/(\d+)\/(\w+)$/);
    if (m) {
      out.add(`skins/${s}.png`);
      animalDirs.add(`${m[1]}/${m[2]}`);
    }
  }
  // animal folders: 'skins/volcano/kingdragon/' or 'skins/land/' + '/tiger/'
  for (const s of strs) {
    const m = s.match(/^skins\/([a-z]+)\/(\w+)\/?$/);
    if (m) animalDirs.add(`${m[1]}/${m[2]}`);
  }
  // body-part fragments: '/tail.png', '_head.png', '/ability.png'
  const parts = new Set(strs.filter((s) => /^[\/_][\w\-]+\.png$/.test(s)));
  for (const dir of animalDirs) {
    const animal = dir.split("/")[1];
    out.add(`skins/${dir}/0/${animal}.png`);
    for (const p of parts) out.add(p.startsWith("/") ? `skins/${dir}/0${p}` : `skins/${dir}/0/${animal}${p}`);
  }
  return [...out];
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
  let captures = new Map<string, Capture>();
  if (o.live) {
    console.log(`🦊 dumping live https://${o.domain}/ → ${out}`);
  } else {
    console.log(`🦊 dumping ${o.domain} as it was around ${o.date} (±${o.windowDays}d) → ${out}`);
    console.log("📜 asking the Wayback CDX index what it has…");
    captures = await listCaptures(o);
    console.log(`   ${captures.size} unique URLs found`);
  }

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
  const guesses = new Set<string>();
  let guessMisses = 0;
  let seasons: string[] | undefined;
  let done = 0;

  // Find which assets/s/<N>/ season folders exist by probing with a known skin.
  const findSeasons = async (samples: string[]) => {
    const hits: string[] = [];
    for (let n = 0; n < 10; n++) {
      for (const sample of samples) {
        const res = await fetchRetry(`https://${o.domain}/assets/s/${n}/${sample}`);
        await res.body?.cancel();
        if (res.ok && !(res.headers.get("content-type") ?? "").includes("html")) {
          hits.push(String(n));
          break;
        }
      }
    }
    console.log(`   season folders on the server: ${hits.map((n) => `assets/s/${n}`).join(", ") || "none"}`);
    return hits;
  };

  const addGuesses = async (js: string) => {
    const paths = guessGamePaths(unescapeHex(js));
    if (!paths.length) return;
    seasons ??= await findSeasons(paths.filter((p) => /^skins\/\w+\/(\w+)\/0\/\1\.png$/.test(p)).slice(0, 5));
    let n = 0;
    for (const p of paths)
      for (const root of p.startsWith("assets/") ? [""] : ["", ...seasons.map((s) => `assets/s/${s}/`)]) {
        const u = `https://${o.domain}/${root}${p}`;
        if (!seen.has(urlKey(u))) {
          guesses.add(urlKey(u));
          enqueue(u);
          n++;
        }
      }
    console.log(`   🔮 queued ${n} guessed game-asset paths`);
  };

  const work = async (url: string) => {
    const cap = captures.get(urlKey(url));
    // With an exact capture use its timestamp; otherwise let Wayback redirect to the nearest one.
    const ts = cap?.timestamp ?? o.date;
    const wb = o.live ? url : `https://web.archive.org/web/${ts}id_/${cap?.original ?? url}`;
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
        // SPA-style servers answer unknown paths with the HTML shell; treat that as a miss for guesses
        const isFakeHit = guesses.has(urlKey(url)) && (res.headers.get("content-type") ?? "").includes("html");
        if (!res.ok || isFakeHit) {
          entry.status = "missing";
          entry.note = `HTTP ${res.status}`;
          await res.body?.cancel();
          return;
        }
        const m = res.url.match(/\/web\/(\d{14})/);
        if (m) entry.timestamp = m[1];
        if (o.live) entry.timestamp = msToTs(Date.now());
        contentType = res.headers.get("content-type") ?? contentType;
        body = new Uint8Array(await res.arrayBuffer());
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
      }
      entry.bytes = body.byteLength;

      if (o.crawl && (TEXTY.test(file) || /html|javascript|css|json/.test(contentType))) {
        let text = new TextDecoder().decode(body);
        const isJs = /\.m?js(__|$)/.test(file) || contentType.includes("javascript");
        if (isJs) text = unescapeHex(text);
        for (const ref of extractRefs(text, cap?.original ?? url, o.domain)) enqueue(ref);
        if (o.live && isJs) await addGuesses(text);
      }
    } catch (e) {
      entry.status = "error";
      entry.note = String(e);
    } finally {
      done++;
      if (entry.status === "missing" && guesses.has(urlKey(url))) {
        guessMisses++;
        return; // wrong guesses are expected; keep the log and manifest clean
      }
      manifest.push(entry);
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
    source: o.live ? "live" : "wayback",
    targetDate: o.live ? null : o.date,
    windowDays: o.windowDays,
    generatedAt: new Date().toISOString(),
    counts: {
      ok: manifest.filter((e) => e.status === "ok").length,
      missing: manifest.filter((e) => e.status === "missing").length,
      error: manifest.filter((e) => e.status === "error").length,
      wrongGuesses: guessMisses,
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
