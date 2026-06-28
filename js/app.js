// app.js
import { loadDocument, showPrevPage, showNextPage } from "./pdf-engine.js";
import { initUI } from "./ui-controller.js";

// Initialize UI interactions
initUI();

// Event Listeners for Pagination
document.getElementById("btn-prev").addEventListener("click", showPrevPage);
document.getElementById("btn-next").addEventListener("click", showNextPage);

// Keyboard Shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") showNextPage();
  if (e.key === "ArrowLeft") showPrevPage();
});

// File Upload Handler (Local processing only, no server)
document.getElementById("btn-upload").addEventListener("click", () => {
  document.getElementById("file-upload").click();
});

document.getElementById("file-upload").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file && file.type === "application/pdf") {
    const fileReader = new FileReader();
    fileReader.onload = function (ev) {
      const typedarray = new Uint8Array(ev.target.result);
      loadDocument(typedarray);
      document.getElementById("book-title").textContent = file.name;
    };
    fileReader.readAsArrayBuffer(file);
  }
});

// Load a sample book by default (Ensure this path is correct based on your folder structure)
// loadDocument('../books/sample.pdf');
