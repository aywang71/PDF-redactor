# Local PDF Redactor

A browser-only PDF redaction tool. It runs entirely on the computer opening the app: there is no backend, upload endpoint, cloud storage, account, analytics script, or persistent browser storage. Downloaded output remains in the browser's normal Downloads location—choose a non-synced local folder if that location is cloud-synced.

## Security model

The app reads the chosen PDF into the current browser tab's memory. When exporting, it renders each page to a bitmap, applies the selected opaque black regions, and puts only those flattened page images in a newly created PDF. It does **not** add rectangles to the original PDF.

That means the exported PDF does not retain the source document's text layer, vector objects, annotations, form fields, embedded attachments, or original metadata. Pages in the export are no longer searchable, selectable, or editable as text; this is an intentional tradeoff for stronger removal. Each selected region is expanded by a tiny raster safety margin during export so rounding cannot reveal an edge pixel.

Important limits:

- Review every page and block before sharing. This tool cannot identify information you did not cover.
- High-resolution or long documents can use substantial memory and result in a large output file. Choose a lower export quality if needed.
- To avoid resource exhaustion from unusually large files, the app limits input files to 200 MB, documents to 250 pages, preview pages to about 16 megapixels, exported pages to about 32 megapixels, and an export job to about 128 megapixels in total.
- This protects data from this application. A compromised browser, operating system, or browser extension is outside its threat model.

## Run locally

Requires a recent Node.js version.

```bash
npm install
npm run dev
```

Open the localhost address Vite prints. For a static production bundle:

```bash
npm run build
npm run preview
```

The `dist/` directory is a static site and can be hosted on a local-only web server. Do not deploy it to a public host if handling documents that should remain local. For the most isolated use, build the app, disconnect from the network, then serve the static bundle locally; the production app makes no network requests.

## Windows desktop app

This repository can also produce a portable Windows `.exe`—it does not install a background service or require an account:

```bash
npm install
npm run package:windows
```

The portable executable is written to `release/`. Run `npm run app` to open the desktop shell during development. The Electron renderer is sandboxed, has Node.js integration disabled, denies all runtime permissions, and only loads the bundled local app files through a private `localpdf://` protocol.

Use the Light mode / Dark mode button in the top-right corner to switch appearance. The choice is intentionally not saved, so the app still does not write browser storage.

## Use

1. Choose or drop a PDF.
2. Drag over information to redact. Click a black block to move it; drag the lower-right corner to resize it; press Delete to remove it.
3. Change pages and repeat as needed.
4. Select export quality and choose **Create redacted PDF**. The browser downloads a newly generated `-redacted.pdf`.
