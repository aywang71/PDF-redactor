const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld(
    "localPdfRedactor",
    Object.freeze({
      saveRedactedPdf: (bytes, suggestedName) =>
        ipcRenderer.invoke("save-redacted-pdf", { bytes, suggestedName }),
    }),
  );
}
