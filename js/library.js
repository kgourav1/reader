/**
 * library.js — Folio PDF Reader
 * Manages the library: uploaded books, built-in books, cover extraction
 */

const Library = {
  // Reading quotes for the home screen
  QUOTES: [
    {
      text: "A reader lives a thousand lives before he dies. The man who never reads lives only one.",
      author: "— George R.R. Martin",
    },
    { text: "Not all those who wander are lost.", author: "— J.R.R. Tolkien" },
    {
      text: "One must always be careful of books, and what is inside them.",
      author: "— Cassandra Clare",
    },
    {
      text: "A book must be the axe for the frozen sea within us.",
      author: "— Franz Kafka",
    },
    {
      text: "I cannot sleep unless I am surrounded by books.",
      author: "— Jorge Luis Borges",
    },
    {
      text: "Reading is dreaming with open eyes.",
      author: "— Anissa Trisdianty",
    },
    {
      text: "The more that you read, the more things you will know.",
      author: "— Dr. Seuss",
    },
    {
      text: "A room without books is like a body without a soul.",
      author: "— Marcus Tullius Cicero",
    },
    { text: "Books are a uniquely portable magic.", author: "— Stephen King" },
    {
      text: "It is what you read when you don't have to that determines what you will be.",
      author: "— Oscar Wilde",
    },
  ],

  // Books stored in IndexedDB
  uploadedBooks: [],

  // Built-in book paths
  BUILTIN_BOOKS: [
    { id: "builtin-1", path: "books/Book1.pdf", title: "Book 1" },
    { id: "builtin-2", path: "books/Book2.pdf", title: "Book 2" },
    { id: "builtin-3", path: "books/Book3.pdf", title: "Book 3" },
  ],

  /* ── Init ───────────────────────────────────────────────── */
  async init() {
    this._showRandomQuote();
    this._setupDropZone();
    await this._loadUploadedBooks();
    this._renderBuiltinBooks();
    this._renderContinueReading();
    this._renderStatsPreview();
  },

  /* ── Quote Banner ───────────────────────────────────────── */
  _showRandomQuote() {
    const q = this.QUOTES[Math.floor(Math.random() * this.QUOTES.length)];
    document.getElementById("quote-text").textContent = `"${q.text}"`;
    document.getElementById("quote-author").textContent = q.author;
  },

  /* ── Drop Zone ──────────────────────────────────────────── */
  _setupDropZone() {
    const zone = document.getElementById("drop-zone");
    const input = document.getElementById("file-input");

    zone.addEventListener("click", (e) => {
      if (e.target !== input) input.click();
    });

    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });

    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });

    zone.addEventListener("dragleave", () =>
      zone.classList.remove("drag-over"),
    );

    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      const files = [...e.dataTransfer.files].filter(
        (f) => f.type === "application/pdf",
      );
      files.forEach((f) => this._handleFile(f));
    });

    input.addEventListener("change", (e) => {
      [...e.target.files].forEach((f) => this._handleFile(f));
      input.value = ""; // allow re-uploading same file
    });
  },

  /* ── Handle Uploaded File ───────────────────────────────── */
  async _handleFile(file) {
    const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const title = file.name.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");

    const buffer = await file.arrayBuffer();
    const meta = {
      title,
      fileName: file.name,
      size: file.size,
      uploadedAt: Date.now(),
    };

    await Storage.savePDF(id, buffer, meta);
    this.uploadedBooks = await Storage.getAllPDFMeta();
    this._renderUploadedBooks();
    this._renderContinueReading();

    // Auto-open the book
    App.openBook({ id, ...meta, source: "uploaded" });
  },

  /* ── Load Uploaded Books from IDB ──────────────────────── */
  async _loadUploadedBooks() {
    this.uploadedBooks = await Storage.getAllPDFMeta();
    this._renderUploadedBooks();
  },

  /* ── Render Uploaded Books ──────────────────────────────── */
  _renderUploadedBooks() {
    const shelf = document.getElementById("uploaded-shelf");
    const section = document.getElementById("uploaded-section");

    if (this.uploadedBooks.length === 0) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";
    shelf.innerHTML = "";

    this.uploadedBooks
      .sort((a, b) => b.savedAt - a.savedAt)
      .forEach((book) => {
        const card = this._createBookCard({
          id: book.id,
          title: book.meta.title,
          source: "uploaded",
          size: book.meta.size,
        });
        shelf.appendChild(card);
      });
  },

  /* ── Render Built-in Books ──────────────────────────────── */
  _renderBuiltinBooks() {
    const shelf = document.getElementById("builtin-shelf");
    shelf.innerHTML = "";

    // Try to detect which built-in books exist
    let detected = 0;
    this.BUILTIN_BOOKS.forEach((book) => {
      // We attempt to fetch; if it fails, skip (handled in App.openBook)
      const card = this._createBookCard({ ...book, source: "builtin" });
      shelf.appendChild(card);
      detected++;
    });

    if (detected === 0) {
      shelf.innerHTML =
        '<div class="empty-shelf"><p>Place PDF files in the <code>/books</code> folder to see them here.</p></div>';
    }
  },

  /* ── Continue Reading ───────────────────────────────────── */
  _renderContinueReading() {
    const shelf = document.getElementById("continue-shelf");
    const section = document.getElementById("continue-section");
    const recents = Storage.getRecents().slice(0, 4);

    if (recents.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    shelf.innerHTML = "";

    recents.forEach((recent) => {
      const progress = Storage.getBookProgress(recent.id);
      const card = this._createBookCard({
        id: recent.id,
        title: recent.title,
        source: "recent",
        progress: progress.page,
      });
      shelf.appendChild(card);
    });
  },

  /* ── Stats Preview ──────────────────────────────────────── */
  _renderStatsPreview() {
    const grid = document.getElementById("stats-grid-mini");
    const s = Stats.getSummary();

    const items = [
      { value: s.totalHours, label: "Hours read" },
      { value: s.streak, label: "Day streak" },
      { value: s.totalPages, label: "Pages read" },
      { value: s.avgWpm, label: "Avg WPM" },
      { value: s.todayPages, label: "Pages today" },
      { value: s.longestStreak, label: "Best streak" },
    ];

    grid.innerHTML = items
      .map(
        (item) => `
      <div class="stat-mini-card">
        <div class="stat-mini-value">${item.value}</div>
        <div class="stat-mini-label">${item.label}</div>
      </div>
    `,
      )
      .join("");
  },

  /* ── Create Book Card ───────────────────────────────────── */
  _createBookCard(book) {
    const card = document.createElement("div");
    card.className = "book-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open ${book.title}`);

    const progress = Storage.getBookProgress(book.id);
    const progressPct =
      progress.page > 1 ? Math.min(100, (progress.page / 300) * 100) : 0;

    card.innerHTML = `
      <div class="book-cover" id="cover-${book.id}">
        <div class="book-cover-placeholder">
          <div class="cover-letter">${(book.title || "B")[0].toUpperCase()}</div>
          <div class="cover-title-text">${this._truncate(book.title, 30)}</div>
        </div>
        <div class="book-progress-bar">
          <div class="book-progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>
      <div class="book-info">
        <div class="book-name" title="${book.title}">${this._truncate(book.title, 24)}</div>
        <div class="book-meta">${book.source === "uploaded" ? this._formatSize(book.size) : "Sample"}</div>
      </div>
      ${book.source === "uploaded" ? '<button class="book-card-delete" aria-label="Remove book">×</button>' : ""}
    `;

    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("book-card-delete")) return;
      App.openBook(book);
    });

    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") App.openBook(book);
    });

    // Delete handler
    const del = card.querySelector(".book-card-delete");
    if (del) {
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Remove "${book.title}" from your library?`)) {
          await Storage.deletePDF(book.id);
          this.uploadedBooks = await Storage.getAllPDFMeta();
          this._renderUploadedBooks();
        }
      });
    }

    // Async: render real cover thumbnail
    if (book.source !== "recent") {
      setTimeout(() => this._generateCoverPreview(book), 100);
    }

    return card;
  },

  /* ── Cover Thumbnail ────────────────────────────────────── */
  async _generateCoverPreview(book) {
    try {
      let src;
      if (book.source === "uploaded") {
        const stored = await Storage.getPDF(book.id);
        if (!stored) return;
        src = { data: stored.data };
      } else if (book.source === "builtin") {
        src = book.path;
      } else return;

      const loadTask = pdfjsLib.getDocument(src);
      const doc = await loadTask.promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 0.4 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "cover";
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: vp,
      }).promise;

      const coverEl = document.getElementById(`cover-${book.id}`);
      if (coverEl) {
        const placeholder = coverEl.querySelector(".book-cover-placeholder");
        if (placeholder) coverEl.removeChild(placeholder);
        coverEl.insertBefore(canvas, coverEl.firstChild);
      }
    } catch (e) {
      /* no cover */
    }
  },

  /* ── Helpers ────────────────────────────────────────────── */
  _truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.slice(0, len - 1) + "…" : str;
  },

  _formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  },
};
