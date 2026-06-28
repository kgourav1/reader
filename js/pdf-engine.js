// pdf-engine.js
// Setup PDF.js worker
const pdfjsLib = window["pdfjs-dist/build/pdf"];
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let pdfDoc = null;
let pageNum = 1;
let pageIsRendering = false;
let pageNumIsPending = null;
const scale = 1.5; // High-res rendering scale

const canvas = document.getElementById("pdf-render");
const ctx = canvas.getContext("2d");

/**
 * Renders a specific page
 */
export const renderPage = (num) => {
  pageIsRendering = true;

  pdfDoc.getPage(num).then((page) => {
    const viewport = page.getViewport({ scale });

    // Output canvas settings for crispness (retina display support)
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const renderCtx = {
      canvasContext: ctx,
      viewport: viewport,
    };

    page.render(renderCtx).promise.then(() => {
      pageIsRendering = false;

      // Render pending pages if user clicked next rapidly
      if (pageNumIsPending !== null) {
        renderPage(pageNumIsPending);
        pageNumIsPending = null;
      }
    });

    // Update UI counters
    document.getElementById("page-num").textContent = num;
  });
};

/**
 * Queue rendering to avoid memory collisions
 */
const queueRenderPage = (num) => {
  if (pageIsRendering) {
    pageNumIsPending = num;
  } else {
    renderPage(num);
  }
};

export const showPrevPage = () => {
  if (pageNum <= 1) return;
  pageNum--;
  queueRenderPage(pageNum);
};

export const showNextPage = () => {
  if (pageNum >= pdfDoc.numPages) return;
  pageNum++;
  queueRenderPage(pageNum);
};

/**
 * Initializes the document from an ArrayBuffer or URL
 */
export const loadDocument = async (source) => {
  try {
    pdfDoc = await pdfjsLib.getDocument(source).promise;
    document.getElementById("page-count").textContent = pdfDoc.numPages;
    renderPage(pageNum);
  } catch (err) {
    console.error("Error loading PDF:", err);
  }
};
