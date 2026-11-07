# jubilant-meme

Dumps the Wayback Machine snapshot of **mope.io from 21 March 2021** into a local folder.

```sh
bun dump-mope.ts                 # → ./dump/mope.io/... + dump/manifest.json
bun dump-mope.ts --serve         # browse it at http://localhost:8080
```

Options: `--date YYYYMMDD`, `--window <days>` (how far from the date to look for captures, default 30),
`--out <dir>`, `--concurrency <n>` (default 4), `--domain <host>`, `--no-crawl`, `--dry-run`.

How it works: it lists every mope.io capture (subdomains included) via the Wayback CDX API, picks the
capture closest to the target date for each URL, downloads the raw files (`id_` URLs, no toolbar), then
scans the HTML/JS/CSS for more mope.io asset paths and fetches those too. Re-running skips files already
on disk, so an interrupted dump can be resumed.

The game servers are long gone, so the dump gives you the client, menus and art, not live matches.
