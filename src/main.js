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
  pageThumbnails: document.querySelector("#page-thumbnails"),
  previousPage: document.querySelector("#previous-page"),
  quality: document.querySelector("#quality"),
  redactionCount: document.querySelector("#redaction-count"),
  redactionLayer: document.querySelector("#redaction-layer"),
  status: document.querySelector("#status"),
  themeIcon: document.querySelector("#theme-icon"),
  themeLabel: document.querySelector("#theme-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  returnToEditor: document.querySelector("#return-to-editor"),
  saveVerified: document.querySelector("#save-verified"),
  verificationChecks: document.querySelector("#verification-checks"),
  verificationDialog: document.querySelector("#verification-dialog"),
  verificationStats: document.querySelector("#verification-stats"),
  verificationSummary: document.querySelector("#verification-summary"),
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
  pendingExport: null,
  pdf: null,
  redactions: new Map(),
  renderTask: null,
  selectedId: null,
  theme: window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  thumbnailActivePage: null,
  thumbnailObserver: null,
  thumbnailRenderedOrder: [],
  thumbnailRenderTasks: new Map(),
  zoom: 1,
};

const MIN_RECT_SIZE = 0.004;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PAGES = 250;
const MAX_PREVIEW_PIXELS = 16 * 1024 * 1024;
const MAX_EXPORT_PIXELS = 32 * 1024 * 1024;
const MAX_TOTAL_EXPORT_PIXELS = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;
const MAX_THUMBNAIL_PIXELS = 220_000;
const MAX_RENDERED_THUMBNAILS = 24;
const MAX_VERIFICATION_PIXELS = 8 * 1024 * 1024;

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

function hasPendingExport() {
  return Boolean(state.pendingExport);
}

function normalizedBounds(rectangle, canvas, safetyBleed = 0) {
  const left = Math.max(0, Math.floor(rectangle.x * canvas.width) - safetyBleed);
  const top = Math.max(0, Math.floor(rectangle.y * canvas.height) - safetyBleed);
  const right = Math.min(
    canvas.width,
    Math.ceil((rectangle.x + rectangle.width) * canvas.width) + safetyBleed,
  );
  const bottom = Math.min(
    canvas.height,
    Math.ceil((rectangle.y + rectangle.height) * canvas.height) + safetyBleed,
  );
  return { bottom, left, right, top };
}

function applyRedactionsToCanvas(context, canvas, rectangles, safetyBleed = 0) {
  context.fillStyle = "#000000";
  for (const rectangle of rectangles) {
    const bounds = normalizedBounds(rectangle, canvas, safetyBleed);
    context.fillRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  }
}

function hasOpaqueBlackCoverage(context, bounds) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width < 3 || height < 3) return false;
  const inset = 1;
  const left = bounds.left + inset;
  const top = bounds.top + inset;
  const right = bounds.right - 1 - inset;
  const bottom = bounds.bottom - 1 - inset;
  const samplePoints = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
    [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)],
  ];
  return samplePoints.every(([x, y]) => {
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    return red <= 8 && green <= 8 && blue <= 8 && alpha >= 250;
  });
}

function thumbnailButton(pageNumber) {
  return elements.pageThumbnails.querySelector(`[data-page-number="${pageNumber}"]`);
}

function updateThumbnailBadge(pageNumber) {
  const button = thumbnailButton(pageNumber);
  if (!button) return;
  const count = state.redactions.get(pageNumber)?.length ?? 0;
  const badge = button.querySelector(".thumbnail-badge");
  badge.hidden = count === 0;
  badge.textContent = count ? String(count) : "";
}

function syncActiveThumbnail() {
  if (state.thumbnailActivePage === state.currentPage) return;
  thumbnailButton(state.thumbnailActivePage)?.removeAttribute("aria-current");
  thumbnailButton(state.thumbnailActivePage)?.classList.remove("current");
  const current = thumbnailButton(state.currentPage);
  current?.setAttribute("aria-current", "page");
  current?.classList.add("current");
  state.thumbnailActivePage = state.currentPage;
  if (current?.dataset.thumbnailState !== "rendered") renderThumbnail(state.currentPage, current);
}

function rememberRenderedThumbnail(pageNumber) {
  state.thumbnailRenderedOrder = state.thumbnailRenderedOrder.filter((item) => item !== pageNumber);
  state.thumbnailRenderedOrder.push(pageNumber);

  while (state.thumbnailRenderedOrder.length > MAX_RENDERED_THUMBNAILS) {
    const candidate = state.thumbnailRenderedOrder.shift();
    if (candidate === state.currentPage) {
      state.thumbnailRenderedOrder.push(candidate);
      continue;
    }
    const button = thumbnailButton(candidate);
    if (button?.dataset.thumbnailState === "rendered") {
      const canvas = button.querySelector("canvas");
      canvas.width = 1;
      canvas.height = 1;
      button.dataset.thumbnailState = "idle";
    }
  }
}

async function renderThumbnail(pageNumber, button, force = false) {
  if (!state.pdf || !button || !button.isConnected || (!force && button.dataset.thumbnailState === "rendered")) return;
  const existingRecord = state.thumbnailRenderTasks.get(pageNumber);
  if (existingRecord) {
    if (force) button.dataset.refreshThumbnail = "true";
    return existingRecord.promise;
  }

  const documentSession = state.documentSession;
  const pdf = state.pdf;
  const canvas = button.querySelector("canvas");
  const record = { cancelled: false, renderTask: null };
  button.dataset.thumbnailState = "rendering";
  state.thumbnailRenderTasks.set(pageNumber, record);
  const task = Promise.resolve().then(async () => {
    try {
      const page = await pdf.getPage(pageNumber);
      if (record.cancelled || documentSession !== state.documentSession || pdf !== state.pdf || !button.isConnected) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(0.25, Math.sqrt(MAX_THUMBNAIL_PIXELS / (baseViewport.width * baseViewport.height)));
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      record.renderTask = page.render({
        annotationMode: pdfjsLib.AnnotationMode.DISABLE,
        canvasContext: context,
        viewport,
      });
      await record.renderTask.promise;
      if (record.cancelled || documentSession !== state.documentSession || pdf !== state.pdf || !button.isConnected) return;
      applyRedactionsToCanvas(context, canvas, state.redactions.get(pageNumber) ?? []);
      button.dataset.thumbnailState = "rendered";
      rememberRenderedThumbnail(pageNumber);
    } catch (error) {
      if (!record.cancelled && documentSession === state.documentSession && pdf === state.pdf && button.isConnected) {
        button.dataset.thumbnailState = "failed";
      }
    } finally {
      if (state.thumbnailRenderTasks.get(pageNumber) === record) state.thumbnailRenderTasks.delete(pageNumber);
      if (button.dataset.refreshThumbnail === "true") {
        button.dataset.refreshThumbnail = "";
        renderThumbnail(pageNumber, button, true);
      }
    }
  })();
  record.promise = task;
  return task;
}

function refreshThumbnail(pageNumber = state.currentPage) {
  const button = thumbnailButton(pageNumber);
  updateThumbnailBadge(pageNumber);
  if (button?.dataset.thumbnailState === "rendered") renderThumbnail(pageNumber, button, true);
}

function setupThumbnails() {
  state.thumbnailObserver?.disconnect();
  state.thumbnailRenderTasks.clear();
  state.thumbnailActivePage = null;
  state.thumbnailRenderedOrder = [];
  elements.pageThumbnails.replaceChildren();
  if (!state.pdf) return;

  const buttons = [];
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
    const button = document.createElement("button");
    button.className = "thumbnail";
    button.type = "button";
    button.dataset.pageNumber = String(pageNumber);
    button.setAttribute("aria-label", `Go to page ${pageNumber}`);

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const footer = document.createElement("span");
    footer.className = "thumbnail-footer";
    const label = document.createElement("span");
    label.textContent = `Page ${pageNumber}`;
    const badge = document.createElement("span");
    badge.className = "thumbnail-badge";
    badge.hidden = true;
    footer.append(label, badge);
    button.append(canvas, footer);
    button.addEventListener("click", () => changePage(pageNumber));
    fragment.append(button);
    buttons.push(button);
  }
  elements.pageThumbnails.append(fragment);

  if ("IntersectionObserver" in window) {
    state.thumbnailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          renderThumbnail(Number(entry.target.dataset.pageNumber), entry.target);
        }
      },
      { root: elements.pageThumbnails, rootMargin: "180px 0px" },
    );
    buttons.forEach((button) => state.thumbnailObserver.observe(button));
  } else {
    buttons.slice(0, 8).forEach((button) => renderThumbnail(Number(button.dataset.pageNumber), button));
  }
  syncActiveThumbnail();
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
  elements.exportButton.disabled = !state.pdf || marked === 0 || state.isExporting || hasPendingExport();
  elements.redactionCount.textContent = `${marked} block${marked === 1 ? "" : "s"} marked`;
  syncActiveThumbnail();
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
  updateThumbnailBadge(state.currentPage);
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
  if (!state.pdf || state.isExporting || hasPendingExport()) return;
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
  if (!state.selectedId || state.isExporting || hasPendingExport()) return;
  const location = findRectangle(state.selectedId);
  if (location) {
    state.redactions.set(
      location.page,
      rectanglesForPage(location.page).filter((rectangle) => rectangle.id !== state.selectedId),
    );
  }
  state.selectedId = null;
  paintRedactions();
  refreshThumbnail(location?.page);
  setStatus("Redaction block removed.");
}

function beginInteraction(event) {
  if (event.button !== 0 || !state.pdf || state.isExporting || hasPendingExport()) return;
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
  refreshThumbnail();
}

async function loadFile(file) {
  if (!file) return;
  if (hasPendingExport()) {
    setStatus("Finish or dismiss the verification review before opening another document.", "error");
    return;
  }
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
    setupThumbnails();
    updateControls();
    elements.workspace.scrollIntoView({ block: "start" });
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
  discardPendingExport();
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
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = null;
  for (const record of state.thumbnailRenderTasks.values()) {
    record.cancelled = true;
    record.renderTask?.cancel();
  }
  state.thumbnailRenderTasks.clear();
  state.thumbnailActivePage = null;
  state.thumbnailRenderedOrder = [];
  elements.fileInput.value = "";
  elements.canvas.width = 1;
  elements.canvas.height = 1;
  elements.redactionLayer.replaceChildren();
  elements.pageThumbnails.replaceChildren();
  elements.workspace.hidden = true;
  elements.dropZone.hidden = false;
  updateControls();
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode page image."))), "image/png");
  });
}

async function verifySerializedRedactions(page, rectangles) {
  if (!rectangles.length) return 0;
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(
    2,
    Math.sqrt(MAX_VERIFICATION_PIXELS / (baseViewport.width * baseViewport.height)),
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  try {
    await page.render({
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      canvasContext: context,
      viewport,
    }).promise;
    for (const rectangle of rectangles) {
      if (!hasOpaqueBlackCoverage(context, normalizedBounds(rectangle, canvas))) {
        throw new UserFacingError("A redaction block could not be verified in the finished PDF.");
      }
    }
    return rectangles.length;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function verifyGeneratedPdf(bytes, expectedPageCount, expectedRedactions) {
  const expectedRedactionCount = [...expectedRedactions.values()].reduce(
    (count, rectangles) => count + rectangles.length,
    0,
  );
  const verificationBytes = new Uint8Array(bytes).slice();
  const loadingTask = pdfjsLib.getDocument({
    data: verificationBytes,
    disableAutoFetch: true,
    disableRange: true,
    enableScripting: false,
    enableXfa: false,
    isEvalSupported: false,
    stopAtErrors: false,
  });

  try {
    const outputPdf = await loadingTask.promise;
    let annotationCount = 0;
    let pageJavaScriptActionCount = 0;
    let searchableTextCount = 0;
    let verifiedRedactionCount = 0;
    for (let pageNumber = 1; pageNumber <= outputPdf.numPages; pageNumber += 1) {
      const page = await outputPdf.getPage(pageNumber);
      const [annotations, text, pageJavaScriptActions] = await Promise.all([
        page.getAnnotations({ intent: "any" }),
        page.getTextContent(),
        page.getJSActions?.(),
      ]);
      annotationCount += annotations.length;
      searchableTextCount += text.items.length;
      pageJavaScriptActionCount += Object.keys(pageJavaScriptActions ?? {}).length;
      verifiedRedactionCount += await verifySerializedRedactions(
        page,
        expectedRedactions.get(pageNumber) ?? [],
      );
    }
    const attachments = await outputPdf.getAttachments();
    const fields = await outputPdf.getFieldObjects?.();
    const javaScriptActions = await outputPdf.getJSActions?.();
    const attachmentCount = Object.keys(attachments ?? {}).length;
    const fieldCount = Object.keys(fields ?? {}).length;
    const javaScriptActionCount = Object.keys(javaScriptActions ?? {}).length + pageJavaScriptActionCount;
    const checksPassed =
      outputPdf.numPages === expectedPageCount &&
      searchableTextCount === 0 &&
      annotationCount === 0 &&
      attachmentCount === 0 &&
      fieldCount === 0 &&
      javaScriptActionCount === 0 &&
      verifiedRedactionCount === expectedRedactionCount;

    if (!checksPassed) {
      throw new UserFacingError("The generated PDF did not pass technical verification and was not saved.");
    }

    return {
      annotationCount,
      attachmentCount,
      fieldCount,
      javaScriptActionCount,
      pageCount: outputPdf.numPages,
      redactionCount: expectedRedactionCount,
      searchableTextCount,
      verifiedRedactionCount,
    };
  } finally {
    await loadingTask.destroy();
  }
}

function addVerificationStat(value, label) {
  const item = document.createElement("div");
  item.className = "verification-stat";
  const number = document.createElement("strong");
  number.textContent = String(value);
  const caption = document.createElement("span");
  caption.textContent = label;
  item.append(number, caption);
  return item;
}

function addVerificationCheck(label, detail) {
  const item = document.createElement("li");
  const icon = document.createElement("span");
  icon.className = "verification-check-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "✓";
  const text = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = label;
  const description = document.createElement("small");
  description.textContent = detail;
  text.append(title, description);
  item.append(icon, text);
  return item;
}

function showVerificationDialog(report) {
  const markedPages = [...state.redactions.values()].filter((rectangles) => rectangles.length > 0).length;
  elements.verificationSummary.textContent = "A fresh, flattened PDF is ready. Nothing has been written to disk yet.";
  elements.verificationStats.replaceChildren(
    addVerificationStat(report.pageCount, "pages flattened"),
    addVerificationStat(markedPages, "pages marked"),
    addVerificationStat(report.redactionCount, "blocks applied"),
  );
  elements.verificationChecks.replaceChildren(
    addVerificationCheck("No selectable text found", `${report.searchableTextCount} text items detected.`),
    addVerificationCheck("No annotations or form fields found", `${report.annotationCount} annotations and ${report.fieldCount} form fields detected.`),
    addVerificationCheck("No attachments or document JavaScript found", `${report.attachmentCount} attachments and ${report.javaScriptActionCount} script actions detected.`),
    addVerificationCheck("Redaction coverage verified in the finished PDF", `${report.verifiedRedactionCount} black blocks sampled after serialization.`),
    addVerificationCheck("Source metadata was not copied", "The output was created as a new document containing flattened page images."),
  );
  if (!elements.verificationDialog.open) elements.verificationDialog.showModal();
  elements.saveVerified.focus();
}

function discardPendingExport() {
  if (state.pendingExport?.bytes) state.pendingExport.bytes.fill(0);
  state.pendingExport = null;
  if (elements.verificationDialog.open) elements.verificationDialog.close();
}

function downloadInBrowser(bytes, fileName) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const download = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  download.href = objectUrl;
  download.download = fileName;
  document.body.append(download);
  download.click();
  download.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

async function saveVerifiedExport() {
  const pendingExport = state.pendingExport;
  if (!pendingExport) return;
  elements.saveVerified.disabled = true;
  elements.returnToEditor.disabled = true;
  try {
    if (typeof window.localPdfRedactor?.saveRedactedPdf === "function") {
      const result = await window.localPdfRedactor.saveRedactedPdf(pendingExport.bytes, pendingExport.fileName);
      if (result?.status === "cancelled") {
        setStatus("Save cancelled. Choose Save verified PDF when you are ready.");
        return;
      }
      if (result?.status !== "saved") throw new Error("Unexpected save result.");
      setStatus("Verified redacted PDF saved to the location you selected.", "success");
    } else {
      downloadInBrowser(pendingExport.bytes, pendingExport.fileName);
      setStatus("Verified redacted PDF downloaded. Check your browser's Downloads location.", "success");
    }
    discardPendingExport();
  } catch (error) {
    console.error(error);
    setStatus("The verified PDF could not be saved. Check the selected folder for an incomplete .partial file, then try again.", "error");
  } finally {
    elements.saveVerified.disabled = false;
    elements.returnToEditor.disabled = false;
    updateControls();
  }
}

async function createRedactedPdf() {
  if (!state.pdf || !state.file || hasPendingExport()) return;
  const redactionTotal = countRedactions();
  if (redactionTotal === 0) {
    setStatus("Mark at least one block before creating a redacted PDF.", "error");
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
  let generatedBytes = null;

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
      const pageRedactions = exportRedactions.get(pageNumber) ?? [];
      applyRedactionsToCanvas(context, exportCanvas, pageRedactions, 1);
      for (const rectangle of pageRedactions) {
        if (!hasOpaqueBlackCoverage(context, normalizedBounds(rectangle, exportCanvas, 1))) {
          throw new UserFacingError("A redaction block could not be verified. No output was saved.");
        }
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

    generatedBytes = new Uint8Array(await output.save({ useObjectStreams: true }));
    if (generatedBytes.byteLength > MAX_OUTPUT_BYTES) {
      throw new UserFacingError(
        `The generated PDF is ${formatBytes(generatedBytes.byteLength)}, above the ${formatBytes(MAX_OUTPUT_BYTES)} safety limit. Choose a lower export quality.`,
      );
    }
    const report = await verifyGeneratedPdf(generatedBytes, pdf.numPages, exportRedactions);
    state.pendingExport = {
      bytes: generatedBytes,
      fileName: redactedFileName(file.name),
      report,
    };
    generatedBytes = null;
    showVerificationDialog(report);
    setStatus("Technical checks passed. Review the report before saving.", "success");
  } catch (error) {
    generatedBytes?.fill(0);
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
  if (hasPendingExport()) return;
  clearDocument();
  setStatus("Document closed. It is no longer held by this app.");
});
elements.previousPage.addEventListener("click", () => changePage(state.currentPage - 1));
elements.nextPage.addEventListener("click", () => changePage(state.currentPage + 1));
elements.pageNumber.addEventListener("change", (event) => changePage(event.target.value));
elements.deleteRedaction.addEventListener("click", removeSelectedRedaction);
elements.exportButton.addEventListener("click", createRedactedPdf);
elements.returnToEditor.addEventListener("click", () => {
  discardPendingExport();
  updateControls();
  setStatus("Verification review dismissed. You can continue editing.");
});
elements.saveVerified.addEventListener("click", saveVerifiedExport);
elements.verificationDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  discardPendingExport();
  updateControls();
  setStatus("Verification review dismissed. You can continue editing.");
});
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
  if (state.isExporting || hasPendingExport()) return;
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
