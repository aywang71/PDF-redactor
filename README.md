# Local PDF Redactor

A local-only PDF redaction app. It runs entirely on the computer opening it: there is no backend, upload endpoint, cloud storage, account, analytics script, or persistent browser storage. The desktop build uses a native Save As dialog, so you choose exactly where the verified output goes.

## Security model

The app reads the chosen PDF into its renderer memory. When exporting, it renders each page to a bitmap, applies the selected opaque black regions, and puts only those flattened page images in a newly created PDF. It does **not** add rectangles to the original PDF.

That means the exported PDF does not retain the source document's text layer, vector objects, annotations, form fields, embedded attachments, or original metadata. Pages in the export are no longer searchable, selectable, or editable as text; this is an intentional tradeoff for stronger removal. Each selected region is expanded by a tiny raster safety margin during export so rounding cannot reveal an edge pixel.

Important limits:

- Review every page and block before sharing. This tool cannot identify information you did not cover.
- High-resolution or long documents can use substantial memory and result in a large output file. Choose a lower export quality if needed.
- To avoid resource exhaustion from unusually large files, the app limits input files to 200 MB, documents to 250 pages, preview pages to about 16 megapixels, exported pages to about 32 megapixels, an export job to about 128 megapixels in total, and a generated PDF to 250 MB.
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

## Use

1. Choose or drop a PDF.
2. Drag over information to redact. Click a black block to move it; drag the lower-right corner to resize it; press Delete to remove it.
3. Change pages and repeat as needed.
4. Select export quality and choose **Create redacted PDF**.
5. Review the in-memory technical verification report, then choose **Save verified PDF**.

The verification report reopens the generated PDF in memory and checks the expected page count plus the absence of selectable text, annotations/form fields, attachments, and document JavaScript. It renders the finished PDF again to sample every selected black block after serialization. This is a technical safeguard, not a substitute for visually reviewing every sensitive field.

The desktop app uses a native **Save As** dialog after verification. The renderer has no filesystem access; it can only request this one validated save operation. The browser build retains its normal download fallback.

## Windows desktop app

This repository can produce a per-user Windows installer and a portable Windows `.exe`. Neither needs an account or installs a background service:

```bash
npm install
npm run package:windows
```

The outputs are written to `release/`. Use `npm run package:installer` or `npm run package:portable` to make just one variant. End users receive those release artifacts—not the repository, `node_modules`, or the development toolchain. Run `npm run app` to open the desktop shell during development. The Electron renderer is sandboxed, has Node.js integration disabled, denies all runtime permissions, and only loads the bundled local app files through a private `localpdf://` protocol.

### Signing a public Windows release

Do not ship a self-signed public installer. A practical default is Microsoft Azure Artifact Signing (formerly Trusted Signing) for an eligible organization or individual: create an Azure subscription and Microsoft Entra tenant, complete identity validation, create a certificate profile, and grant a CI service principal the signing role. Keep all credentials in the CI secret store, never in this repository.

Have CI sign the final NSIS setup file, portable executable, and every shipped executable with SHA-256 plus an RFC 3161 timestamp, then verify each artifact with `signtool verify /pa /v`. Timestamping is essential because signing certificates expire. Consistent signed releases build SmartScreen reputation over time, though a new direct-download publisher can still see warnings initially. The Microsoft Store is an alternative distribution path that re-signs MSIX packages for you.

Use the Light mode / Dark mode button in the top-right corner to switch appearance. The choice is intentionally not saved, so the app still does not write browser storage.
