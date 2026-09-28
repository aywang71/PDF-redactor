const { app, BrowserWindow, dialog, ipcMain, net, protocol, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let saveInProgress = false;
const appOrigin = "localpdf://app";
const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "localpdf",
    privileges: {
      allowServiceWorkers: false,
      corsEnabled: false,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

function registerLocalAssetProtocol() {
  const appRoot = path.resolve(app.getAppPath(), "dist");
  protocol.handle("localpdf", (request) => {
    const url = new URL(request.url);
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const assetPath = path.resolve(appRoot, relativePath);

    if (url.host !== "app" || (assetPath !== appRoot && !assetPath.startsWith(`${appRoot}${path.sep}`))) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
  });
}

function sanitizeSuggestedName(name) {
  const rawName = typeof name === "string" ? name : "redacted.pdf";
  const baseName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, "-") || "redacted.pdf";
  return baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`;
}

function bytesFromRenderer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function registerIpcHandlers() {
  ipcMain.handle("save-redacted-pdf", async (event, request) => {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== `${appOrigin}/index.html`
    ) {
      throw new Error("Untrusted save request.");
    }
    if (saveInProgress) throw new Error("A save is already in progress.");

    const pdfBytes = bytesFromRenderer(request?.bytes);
    if (
      !pdfBytes?.length ||
      pdfBytes.length > MAX_OUTPUT_BYTES ||
      pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) {
      throw new Error("The generated PDF is not a valid size for saving.");
    }

    saveInProgress = true;
    let temporaryPath;
    let temporaryFile;
    let ownsTemporaryPath = false;
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save verified redacted PDF",
        defaultPath: path.join(app.getPath("downloads"), sanitizeSuggestedName(request?.suggestedName)),
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
        properties: ["createDirectory", "dontAddToRecent", "showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return { status: "cancelled" };

      temporaryPath = path.join(
        path.dirname(result.filePath),
        `.${path.basename(result.filePath)}.${crypto.randomUUID()}.partial`,
      );
      temporaryFile = await fs.open(temporaryPath, "wx", 0o600);
      ownsTemporaryPath = true;
      await temporaryFile.writeFile(pdfBytes);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;
      await fs.rename(temporaryPath, result.filePath);
      temporaryPath = null;
      return { status: "saved" };
    } catch {
      throw new Error("The verified PDF could not be saved.");
    } finally {
      await temporaryFile?.close().catch(() => {});
      if (ownsTemporaryPath && temporaryPath) {
        await fs.rm(temporaryPath, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      }
      pdfBytes.fill(0);
      saveInProgress = false;
    }
  });
}

function denyAllPermissions() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function createMainWindow() {
  const trustedUrl = `${appOrigin}/index.html`;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 650,
    title: "Local PDF Redactor",
    backgroundColor: "#0a1020",
    autoHideMenuBar: true,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== trustedUrl) event.preventDefault();
  });
  mainWindow.loadURL(trustedUrl);
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.localpdfredactor.app");
  registerLocalAssetProtocol();
  denyAllPermissions();
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
