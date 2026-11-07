# jubilant-meme

Dumps the Wayback Machine snapshot of **mope.io from 21 March 2021** into a local folder.

```sh
bun dump-mope.ts                 # → ./dump/mope.io/... + dump/manifest.json
bun dump-mope.ts --serve         # browse it at http://localhost:8080
```

### Live site (v1.mope.io)

```sh
bun dump-mope.ts --live --domain v1.mope.io --out dump-v1 --concurrency 8
bun dump-mope.ts --serve --out dump-v1 --domain v1.mope.io
```

In `--live` mode it crawls the current site directly instead of the archive. The game client
(`client.js`) is obfuscated and builds most image paths at runtime
(`'./assets/s/' + season + '/skins/' + 'land/rabbit/200/rabbit' + '.png'`), so the script decodes
its `\xNN` strings, rebuilds likely asset paths from the fragments it finds, finds which
`assets/s/<N>/` season folders exist, and tries each guess. Wrong guesses are counted but kept out of
the log and manifest.

Options: `--date YYYYMMDD`, `--window <days>` (how far from the date to look for captures, default 30),
`--out <dir>`, `--concurrency <n>` (default 70), `--domain <host>`, `--no-crawl`, `--dry-run`.

How it works: it lists every mope.io capture (subdomains included) via the Wayback CDX API, picks the
capture closest to the target date for each URL, downloads the raw files (`id_` URLs, no toolbar), then
scans the HTML/JS/CSS for more mope.io asset paths and fetches those too. Re-running skips files already
on disk, so an interrupted dump can be resumed.

The game servers are long gone, so the dump gives you the client, menus and art, not live matches.
