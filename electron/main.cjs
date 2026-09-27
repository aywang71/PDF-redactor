const { app, BrowserWindow, net, protocol, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
const appOrigin = "localpdf://app";

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
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const assetPath = path.resolve(appRoot, relativePath);

    if (url.host !== "app" || (assetPath !== appRoot && !assetPath.startsWith(`${appRoot}${path.sep}`))) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
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
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
