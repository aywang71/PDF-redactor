import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const elements = {
  browseButton: document.querySelector("#browse-button"),
  canvas: document.querySelector("#pdf-canvas"),
  closeDocument: document.querySelector("#close-document"),
  deleteRedaction: document.querySelector("#delete-redaction"),
  dropZone: document.querySelector("#drop-zone"),
  exportButton: document.querySelector("#export-button"),
  fileInput: document.querySelector("#file-input"),
  fileMeta: document.querySelector("#file-meta"),
  fileName: document.querySelector("#file-name"),
  nextPage: document.querySelector("#next-page"),
  pageCount: document.querySelector("#page-count"),
  pageLabel: document.querySelector("#page-label"),
  pageNumber: document.querySelector("#page-number"),
  pageStage: document.querySelector("#page-stage"),
  previousPage: document.querySelector("#previous-page"),
  quality: document.querySelector("#quality"),
  redactionCount: document.querySelector("#redaction-count"),
  redactionLayer: document.querySelector("#redaction-layer"),
  status: document.querySelector("#status"),
  themeIcon: document.querySelector("#theme-icon"),
  themeLabel: document.querySelector("#theme-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  workspace: document.querySelector("#workspace"),
  zoom: document.querySelector("#zoom"),
};

const state = {
  currentPage: 1,
  documentSession: 0,
  dragDepth: 0,
  file: null,
  interaction: null,
  isExporting: false,
  loadingTask: null,
  pdf: null,
  redactions: new Map(),
  renderTask: null,
  selectedId: null,
  theme: window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  zoom: 1,
};

const MIN_RECT_SIZE = 0.004;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PAGES = 250;
const MAX_PREVIEW_PIXELS = 16 * 1024 * 1024;
const MAX_EXPORT_PIXELS = 32 * 1024 * 1024;
const MAX_TOTAL_EXPORT_PIXELS = 128 * 1024 * 1024;

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function applyTheme(theme) {
  state.theme = theme;
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  elements.themeToggle.setAttribute("aria-pressed", String(isDark));
  elements.themeToggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
  elements.themeIcon.textContent = isDark ? "☀" : "◐";
  elements.themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function clamp(value, lower = 0, upper = 1) {
  return Math.min(Math.max(value, lower), upper);
}

function rectanglesForPage(pageNumber = state.currentPage) {
  if (!state.redactions.has(pageNumber)) state.redactions.set(pageNumber, []);
  return state.redactions.get(pageNumber);
}

function findRectangle(id) {
  for (const [page, rectangles] of state.redactions.entries()) {
    const rectangle = rectangles.find((item) => item.id === id);
    if (rectangle) return { page, rectangle };
  }
  return null;
}

function countRedactions() {
  return [...state.redactions.values()].reduce((total, rectangles) => total + rectangles.length, 0);
}

function updateControls() {
  const pageCount = state.pdf?.numPages ?? 1;
  const marked = countRedactions();
  elements.pageNumber.value = state.currentPage;
  elements.pageNumber.max = pageCount;
  elements.pageCount.textContent = `/ ${pageCount}`;
  elements.pageLabel.textContent = `Page ${state.currentPage} of ${pageCount}`;
  elements.previousPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= pageCount;
  elements.deleteRedaction.disabled = !state.selectedId;
  elements.exportButton.disabled = !state.pdf || marked === 0 || state.isExporting;
  elements.redactionCount.textContent = `${marked} block${marked === 1 ? "" : "s"} marked`;
}

function redactionElement(rectangle) {
  const element = document.createElement("div");
  element.className = `redaction${rectangle.id === state.selectedId ? " selected" : ""}`;
  element.dataset.redactionId = rectangle.id;
  element.style.left = `${rectangle.x * 100}%`;
  element.style.top = `${rectangle.y * 100}%`;
  element.style.width = `${rectangle.width * 100}%`;
  element.style.height = `${rectangle.height * 100}%`;
  element.setAttribute("aria-label", "Redaction block. Drag to move; use lower-right handle to resize.");

  const handle = document.createElement("span");
  handle.className = "resize-handle";
  handle.setAttribute("aria-hidden", "true");
  element.append(handle);
  return element;
}

function paintRedactions() {
  elements.redactionLayer.replaceChildren(...rectanglesForPage().map(redactionElement));
  updateControls();
}

function getLayerPoint(event) {
  const bounds = elements.redactionLayer.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height),
  };
}

function cancelRender() {
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
}

async function renderCurrentPage() {
  if (!state.pdf) return;
  cancelRender();
  const documentSession = state.documentSession;
  const pdf = state.pdf;
  const pageAtRenderStart = state.currentPage;
  let activeRenderTask = null;
  setStatus("Rendering page…");

  try {
    const page = await pdf.getPage(pageAtRenderStart);
    if (documentSession !== state.documentSession || pdf !== state.pdf || pageAtRenderStart !== state.currentPage) return;

    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(320, elements.pageStage.parentElement.clientWidth - 48);
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const fitScale = Math.min(1.8, availableWidth / baseViewport.width);
    const safeScale = Math.sqrt(MAX_PREVIEW_PIXELS / (baseViewport.width * baseViewport.height * outputScale ** 2));
    const displayScale = Math.min(4, fitScale * state.zoom, safeScale);
    const viewport = page.getViewport({ scale: displayScale });
    const canvas = elements.canvas;
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    elements.pageStage.style.width = `${viewport.width}px`;
    elements.pageStage.style.height = `${viewport.height}px`;
    elements.redactionLayer.style.width = `${viewport.width}px`;
    elements.redactionLayer.style.height = `${viewport.height}px`;

    activeRenderTask = page.render({
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      canvasContext: context,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      viewport,
    });
    state.renderTask = activeRenderTask;
    await activeRenderTask.promise;
    if (documentSession === state.documentSession && pdf === state.pdf && pageAtRenderStart === state.currentPage) {
      paintRedactions();
      setStatus("Drag over a region to add a redaction block.");
    }
  } catch (error) {
    if (
      error?.name !== "RenderingCancelledException" &&
      documentSession === state.documentSession &&
      pdf === state.pdf
    ) {
      console.error(error);
      setStatus("This page could not be rendered.", "error");
    }
  } finally {
    if (state.renderTask === activeRenderTask) state.renderTask = null;
  }
}

function changePage(requestedPage) {
  if (!state.pdf || state.isExporting) return;
  const page = Math.round(Number(requestedPage));
  if (!Number.isFinite(page)) {
    updateControls();
    return;
  }
  state.currentPage = clamp(page, 1, state.pdf.numPages);
  state.selectedId = null;
  updateControls();
  renderCurrentPage();
}

function removeSelectedRedaction() {
  if (!state.selectedId) return;
  const location = findRectangle(state.selectedId);
  if (location) {
    state.redactions.set(
      location.page,
      rectanglesForPage(location.page).filter((rectangle) => rectangle.id !== state.selectedId),
    );
  }
  state.selectedId = null;
  paintRedactions();
  setStatus("Redaction block removed.");
}

function beginInteraction(event) {
  if (event.button !== 0 || !state.pdf || state.isExporting) return;
  const point = getLayerPoint(event);
  const block = event.target.closest(".redaction");
  const handle = event.target.closest(".resize-handle");

  if (block) {
    const redaction = rectanglesForPage().find((rectangle) => rectangle.id === block.dataset.redactionId);
    if (!redaction) return;
    state.selectedId = redaction.id;
    state.interaction = {
      kind: handle ? "resize" : "move",
      id: redaction.id,
      origin: { ...redaction },
      start: point,
    };
  } else {
    const rectangle = {
      id: crypto.randomUUID(),
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
    };
    rectanglesForPage().push(rectangle);
    state.selectedId = rectangle.id;
    state.interaction = { kind: "draw", id: rectangle.id, start: point };
  }

  elements.redactionLayer.setPointerCapture(event.pointerId);
  paintRedactions();
  event.preventDefault();
}

function updateInteraction(event) {
  if (!state.interaction) return;
  const point = getLayerPoint(event);
  const rectangle = rectanglesForPage().find((item) => item.id === state.interaction.id);
  if (!rectangle) return;

  if (state.interaction.kind === "draw") {
    rectangle.x = Math.min(state.interaction.start.x, point.x);
    rectangle.y = Math.min(state.interaction.start.y, point.y);
    rectangle.width = Math.abs(point.x - state.interaction.start.x);
    rectangle.height = Math.abs(point.y - state.interaction.start.y);
  }

  if (state.interaction.kind === "move") {
    const deltaX = point.x - state.interaction.start.x;
    const deltaY = point.y - state.interaction.start.y;
    rectangle.x = clamp(state.interaction.origin.x + deltaX, 0, 1 - rectangle.width);
    rectangle.y = clamp(state.interaction.origin.y + deltaY, 0, 1 - rectangle.height);
  }

  if (state.interaction.kind === "resize") {
    rectangle.width = clamp(point.x - rectangle.x, MIN_RECT_SIZE, 1 - rectangle.x);
    rectangle.height = clamp(point.y - rectangle.y, MIN_RECT_SIZE, 1 - rectangle.y);
  }
  paintRedactions();
}

function finishInteraction(event) {
  if (!state.interaction) return;
  const rectangle = rectanglesForPage().find((item) => item.id === state.interaction.id);
  if (
    rectangle &&
    state.interaction.kind === "draw" &&
    (rectangle.width < MIN_RECT_SIZE || rectangle.height < MIN_RECT_SIZE)
  ) {
    state.redactions.set(
      state.currentPage,
      rectanglesForPage().filter((item) => item.id !== rectangle.id),
    );
    state.selectedId = null;
  }
  if (elements.redactionLayer.hasPointerCapture(event.pointerId)) {
    elements.redactionLayer.releasePointerCapture(event.pointerId);
  }
  state.interaction = null;
  paintRedactions();
}

async function loadFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    setStatus("Choose a PDF file (.pdf).", "error");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setStatus("For safety, this app accepts PDFs up to 200 MB.", "error");
    return;
  }

  clearDocument();
  const documentSession = state.documentSession;
  let activeLoadingTask = null;
  setStatus("Opening PDF locally…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    activeLoadingTask = pdfjsLib.getDocument({
      data: bytes,
      disableAutoFetch: true,
      disableRange: true,
      enableXfa: false,
      enableScripting: false,
      isEvalSupported: false,
      stopAtErrors: false,
    });
    state.loadingTask = activeLoadingTask;
    const pdf = await activeLoadingTask.promise;
    if (documentSession !== state.documentSession) {
      pdf.destroy();
      return;
    }
    if (pdf.numPages > MAX_PAGES) {
      pdf.destroy();
      throw new UserFacingError("For safety, this app accepts PDFs with up to 250 pages.");
    }
    state.pdf = pdf;
    state.file = file;
    state.currentPage = 1;
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${state.pdf.numPages} page${state.pdf.numPages === 1 ? "" : "s"} · ${formatBytes(file.size)}`;
    elements.dropZone.hidden = true;
    elements.workspace.hidden = false;
    updateControls();
    await renderCurrentPage();
  } catch (error) {
    if (documentSession !== state.documentSession) return;
    console.error(error);
    clearDocument();
    setStatus(
      error instanceof UserFacingError
        ? error.message
        : error?.name === "PasswordException"
          ? "This password-protected PDF cannot be opened here. Remove its password locally and try again."
          : "The PDF could not be opened. It may be damaged or use an unsupported format.",
      "error",
    );
  } finally {
    if (state.loadingTask === activeLoadingTask) state.loadingTask = null;
  }
}

function clearDocument() {
  state.documentSession += 1;
  cancelRender();
  state.loadingTask?.destroy?.();
  state.loadingTask = null;
  state.pdf?.destroy();
  state.currentPage = 1;
  state.file = null;
  state.interaction = null;
  state.pdf = null;
  state.redactions = new Map();
  state.selectedId = null;
  elements.fileInput.value = "";
  elements.canvas.width = 1;
  elements.canvas.height = 1;
  elements.redactionLayer.replaceChildren();
  elements.workspace.hidden = true;
  elements.dropZone.hidden = false;
  updateControls();
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode page image."))), "image/png");
  });
}

async function createRedactedPdf() {
  if (!state.pdf || !state.file) return;
  const redactionTotal = countRedactions();
  const markedPages = [...state.redactions.values()].filter((rectangles) => rectangles.length > 0).length;
  if (redactionTotal === 0) {
    setStatus("Mark at least one block before creating a redacted PDF.", "error");
    return;
  }
  if (
    !window.confirm(
      `Review complete? This will export ${redactionTotal} redaction block${redactionTotal === 1 ? "" : "s"} across ${markedPages} page${markedPages === 1 ? "" : "s"}. The result will be flattened and cannot be edited as text.`,
    )
  ) {
    setStatus("Export cancelled so you can continue reviewing the marked blocks.");
    return;
  }

  const button = elements.exportButton;
  const outputScale = Number(elements.quality.value);
  const documentSession = state.documentSession;
  const pdf = state.pdf;
  const file = state.file;
  const exportRedactions = new Map(
    [...state.redactions.entries()].map(([page, rectangles]) => [page, rectangles.map((rectangle) => ({ ...rectangle }))]),
  );
  state.isExporting = true;
  button.disabled = true;
  elements.closeDocument.disabled = true;
  elements.previousPage.disabled = true;
  elements.nextPage.disabled = true;
  elements.pageNumber.disabled = true;
  elements.quality.disabled = true;
  elements.zoom.disabled = true;
  elements.redactionLayer.style.pointerEvents = "none";

  try {
    setStatus("Creating a new flattened PDF… 0%");
    const output = await PDFDocument.create();
    output.setTitle("Redacted document");
    output.setAuthor("");
    output.setSubject("");
    output.setKeywords([]);
    output.setProducer("Local PDF Redactor");
    output.setCreator("Local PDF Redactor");
    let totalExportPixels = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (documentSession !== state.documentSession || pdf !== state.pdf) throw new Error("Document was closed during export.");
      const sourcePage = await pdf.getPage(pageNumber);
      const baseViewport = sourcePage.getViewport({ scale: 1 });
      const exportViewport = sourcePage.getViewport({ scale: outputScale });
      const pagePixels = exportViewport.width * exportViewport.height;
      if (pagePixels > MAX_EXPORT_PIXELS) {
        throw new UserFacingError("This page is too large at the selected quality. Choose a lower export quality.");
      }
      totalExportPixels += pagePixels;
      if (totalExportPixels > MAX_TOTAL_EXPORT_PIXELS) {
        throw new UserFacingError("This document is too large at the selected quality. Choose a lower export quality.");
      }
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = Math.ceil(exportViewport.width);
      exportCanvas.height = Math.ceil(exportViewport.height);
      const context = exportCanvas.getContext("2d", { alpha: false });

      await sourcePage.render({
        annotationMode: pdfjsLib.AnnotationMode.DISABLE,
        canvasContext: context,
        viewport: exportViewport,
      }).promise;
      context.fillStyle = "#000000";
      for (const rectangle of exportRedactions.get(pageNumber) ?? []) {
        const left = Math.max(0, Math.floor(rectangle.x * exportCanvas.width) - 1);
        const top = Math.max(0, Math.floor(rectangle.y * exportCanvas.height) - 1);
        const right = Math.min(exportCanvas.width, Math.ceil((rectangle.x + rectangle.width) * exportCanvas.width) + 1);
        const bottom = Math.min(exportCanvas.height, Math.ceil((rectangle.y + rectangle.height) * exportCanvas.height) + 1);
        context.fillRect(left, top, right - left, bottom - top);
      }

      const png = await canvasToBlob(exportCanvas);
      const image = await output.embedPng(await png.arrayBuffer());
      const outputPage = output.addPage([baseViewport.width, baseViewport.height]);
      outputPage.drawImage(image, {
        x: 0,
        y: 0,
        width: baseViewport.width,
        height: baseViewport.height,
      });
      exportCanvas.width = 1;
      exportCanvas.height = 1;
      setStatus(`Creating a new flattened PDF… ${Math.round((pageNumber / pdf.numPages) * 100)}%`);
    }

    const bytes = await output.save({ useObjectStreams: true });
    const blob = new Blob([bytes], { type: "application/pdf" });
    const download = document.createElement("a");
    download.href = URL.createObjectURL(blob);
    download.download = redactedFileName(file.name);
    document.body.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(download.href), 1_000);
    setStatus("Redacted PDF created and downloaded. The original content is not included in the new file.", "success");
  } catch (error) {
    console.error(error);
    setStatus(
      error instanceof UserFacingError
        ? error.message
        : "Could not create the redacted PDF. Try a lower export quality or a smaller document.",
      "error",
    );
  } finally {
    state.isExporting = false;
    elements.closeDocument.disabled = false;
    elements.pageNumber.disabled = false;
    elements.quality.disabled = false;
    elements.zoom.disabled = false;
    elements.redactionLayer.style.pointerEvents = "";
    updateControls();
  }
}

function redactedFileName(fileName) {
  const baseName = fileName.replace(/\.pdf$/i, "") || "document";
  return `${baseName.replace(/[\\/:*?\"<>|]/g, "-")}-redacted.pdf`;
}

class UserFacingError extends Error {}

elements.browseButton.addEventListener("click", () => elements.fileInput.click());
elements.themeToggle.addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
elements.fileInput.addEventListener("change", (event) => loadFile(event.target.files?.[0]));
elements.closeDocument.addEventListener("click", () => {
  clearDocument();
  setStatus("Document closed. It is no longer held by this app.");
});
elements.previousPage.addEventListener("click", () => changePage(state.currentPage - 1));
elements.nextPage.addEventListener("click", () => changePage(state.currentPage + 1));
elements.pageNumber.addEventListener("change", (event) => changePage(event.target.value));
elements.deleteRedaction.addEventListener("click", removeSelectedRedaction);
elements.exportButton.addEventListener("click", createRedactedPdf);
elements.zoom.addEventListener("change", (event) => {
  state.zoom = Number(event.target.value);
  if (state.pdf) renderCurrentPage();
});
elements.redactionLayer.addEventListener("pointerdown", beginInteraction);
elements.redactionLayer.addEventListener("pointermove", updateInteraction);
elements.redactionLayer.addEventListener("pointerup", finishInteraction);
elements.redactionLayer.addEventListener("pointercancel", finishInteraction);

elements.dropZone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  state.dragDepth += 1;
  elements.dropZone.classList.add("dragging");
});
elements.dropZone.addEventListener("dragover", (event) => event.preventDefault());
elements.dropZone.addEventListener("dragleave", (event) => {
  event.preventDefault();
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) elements.dropZone.classList.remove("dragging");
});
elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  state.dragDepth = 0;
  elements.dropZone.classList.remove("dragging");
  loadFile(event.dataTransfer?.files?.[0]);
});

document.addEventListener("keydown", (event) => {
  const tagName = document.activeElement?.tagName;
  if ((event.key === "Delete" || event.key === "Backspace") && tagName !== "INPUT" && tagName !== "SELECT") {
    if (state.selectedId) {
      event.preventDefault();
      removeSelectedRedaction();
    }
  }
  if (event.key === "Escape" && state.selectedId) {
    state.selectedId = null;
    paintRedactions();
  }
});

window.addEventListener("resize", () => {
  if (state.pdf) renderCurrentPage();
});

applyTheme(state.theme);
updateControls();
