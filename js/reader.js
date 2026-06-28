/**
 * reader.js — Folio PDF Reader
 * Core PDF rendering: virtual scrolling, page caching, search, bookmarks
 */

const Reader = {
  /* ── State ──────────────────────────────────────────────── */
  pdfDoc: null,
  currentBook: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.0,
  fitMode: "width", // 'width' | 'page' | 'actual'
  viewMode: "continuous", // 'continuous' | 'single' | 'double'
  isLoading: false,

  // Virtual rendering
  renderedPages: new Map(), // page → { canvas, textDiv }
  renderQueue: new Set(),
  visibleRange: { start: 1, end: 3 },
  BUFFER_PAGES: 3, // pages to render ahead/behind
  MAX_CACHE: 12, // max cached pages
  pageSizes: [], // [{width, height}] at scale 1.0

  // Search
  searchResults: [],
  searchIndex: -1,
  searchQuery: "",
  pendingSearchHighlight: null,

  // Scroll tracking
  lastScrollTop: 0,
  scrollDebounce: null,
  pageOffsets: [], // cumulative top offset per page

  /* ── Init ───────────────────────────────────────────────── */
  async init() {
    this._bindUI();
    this._bindKeyboard();
  },

  /* ── Load PDF ───────────────────────────────────────────── */
  async open(source, bookMeta) {
    this.currentBook = bookMeta;
    this._showLoading(true);
    this._clearState();

    try {
      // Configure PDF.js worker
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      const loadTask =
        typeof source === "string"
          ? pdfjsLib.getDocument(source)
          : pdfjsLib.getDocument({ data: source });

      this.pdfDoc = await loadTask.promise;
      this.totalPages = this.pdfDoc.numPages;

      // Pre-compute page sizes at scale 1 for layout
      await this._computePageSizes();

      // Restore last position
      const progress = Storage.getBookProgress(bookMeta.id);
      this.currentPage = Math.min(progress.page, this.totalPages);

      // Build UI
      this._buildContainer();
      this._updateProgressSlider();
      this._renderTOC();

      // Scroll to last position and render
      this._showLoading(false);
      await this._scrollToPage(this.currentPage, false);
      this._renderVisiblePages();

      // Render thumbnails (async, low priority)
      this._renderThumbnails();

      // Book metadata in UI
      document.getElementById("book-title-nav").textContent = bookMeta.title;

      // Start stats tracking
      Stats.startSession(bookMeta.id);
      Storage.addRecent(bookMeta.id, bookMeta.title);
    } catch (err) {
      console.error("PDF load error:", err);
      this._showLoading(false);
      this._showError("Could not open this PDF file.");
    }
  },

  /* ── Clear State ────────────────────────────────────────── */
  _clearState() {
    Stats.endSession();
    this.pdfDoc = null;
    this.currentPage = 1;
    this.totalPages = 0;
    this.renderedPages.clear();
    this.renderQueue.clear();
    this.searchResults = [];
    this.searchIndex = -1;
    this.pageSizes = [];
    this.pageOffsets = [];
    document.getElementById("pages-container").innerHTML = "";
    document.getElementById("toc-list").innerHTML =
      '<p class="panel-empty">No table of contents.</p>';
    document.getElementById("thumb-grid").innerHTML = "";
  },

  /* ── Pre-compute page sizes ─────────────────────────────── */
  async _computePageSizes() {
    this.pageSizes = [];
    // Sample first page for speed; others get same unless we need precision
    const first = await this.pdfDoc.getPage(1);
    const vp = first.getViewport({ scale: 1.0 });
    for (let i = 0; i < this.totalPages; i++) {
      this.pageSizes.push({ width: vp.width, height: vp.height });
    }
    // For accuracy on first 20 pages, load them
    const sampleCount = Math.min(20, this.totalPages);
    for (let i = 0; i < sampleCount; i++) {
      const page = await this.pdfDoc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1.0 });
      this.pageSizes[i] = { width: vp.width, height: vp.height };
    }
  },

  /* ── Compute display scale ──────────────────────────────── */
  _computeScale() {
    const container = document.getElementById("pdf-viewport");
    const availW = container.clientWidth - 48; // padding
    const availH = container.clientHeight - 40;
    const pageW = this.pageSizes[0]?.width || 612;
    const pageH = this.pageSizes[0]?.height || 792;

    switch (this.fitMode) {
      case "width":
        return Math.max(0.3, availW / pageW);
      case "page":
        return Math.min(availW / pageW, availH / pageH);
      case "actual":
        return this.scale; // user-set zoom
      default:
        return Math.max(0.3, availW / pageW);
    }
  },

  /* ── Build Container (virtual placeholders) ─────────────── */
  _buildContainer() {
    const container = document.getElementById("pages-container");
    container.innerHTML = "";
    this.pageOffsets = [];

    const displayScale =
      this._computeScale() * (this.fitMode === "actual" ? 1 : 1);
    let cumOffset = 0;

    for (let i = 0; i < this.totalPages; i++) {
      const ps = this.pageSizes[i] || this.pageSizes[0];
      const w = Math.floor(ps.width * displayScale);
      const h = Math.floor(ps.height * displayScale);

      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper page-skeleton";
      wrapper.id = `page-${i + 1}`;
      wrapper.style.width = `${w}px`;
      wrapper.style.height = `${h}px`;
      wrapper.dataset.pageNum = i + 1;
      container.appendChild(wrapper);

      this.pageOffsets.push(cumOffset);
      cumOffset += h + 16; // 16px gap
    }

    // Update slider max
    const slider = document.getElementById("progress-slider");
    slider.max = this.totalPages;
    slider.value = this.currentPage;
  },

  /* ── Scroll to Page ─────────────────────────────────────── */
  async _scrollToPage(pageNum, smooth = true) {
    const viewport = document.getElementById("pdf-viewport");
    const offset = this.pageOffsets[pageNum - 1] || 0;
    viewport.scrollTo({ top: offset, behavior: smooth ? "smooth" : "instant" });
  },

  /* ── Render Visible Pages ───────────────────────────────── */
  _renderVisiblePages() {
    const viewport = document.getElementById("pdf-viewport");
    const scrollTop = viewport.scrollTop;
    const viewHeight = viewport.clientHeight;

    // Find visible page range
    let startPage = this.totalPages,
      endPage = 1;
    for (let i = 0; i < this.totalPages; i++) {
      const top = this.pageOffsets[i];
      const h = this._getRenderedPageHeight(i + 1);
      const bottom = top + h;
      if (bottom > scrollTop - viewHeight && top < scrollTop + viewHeight * 2) {
        startPage = Math.min(startPage, i + 1);
        endPage = Math.max(endPage, i + 1);
      }
    }

    startPage = Math.max(1, startPage - this.BUFFER_PAGES);
    endPage = Math.min(this.totalPages, endPage + this.BUFFER_PAGES);
    this.visibleRange = { start: startPage, end: endPage };

    // Render pages in range
    for (let p = startPage; p <= endPage; p++) {
      if (!this.renderedPages.has(p) && !this.renderQueue.has(p)) {
        this._queueRender(p);
      }
    }

    // Evict far-away pages
    this._evictCache(startPage, endPage);

    // Update current page indicator
    this._updateCurrentPage(scrollTop, viewHeight);
  },

  _getRenderedPageHeight(pageNum) {
    const ps = this.pageSizes[pageNum - 1] || this.pageSizes[0];
    const scale = this._computeScale();
    return Math.floor(ps.height * scale);
  },

  /* ── Queue & Render a Page ──────────────────────────────── */
  _queueRender(pageNum) {
    this.renderQueue.add(pageNum);
    // Use requestIdleCallback for non-urgent pages
    requestAnimationFrame(() => this._renderPage(pageNum));
  },

  async _renderPage(pageNum) {
    if (this.renderedPages.has(pageNum) || !this.pdfDoc) {
      this.renderQueue.delete(pageNum);
      return;
    }

    const wrapper = document.getElementById(`page-${pageNum}`);
    if (!wrapper) {
      this.renderQueue.delete(pageNum);
      return;
    }

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const scale = this._computeScale();
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Text layer for selection & search
      const textDiv = document.createElement("div");
      textDiv.className = "text-layer";
      const textContent = await page.getTextContent();

      // Build text spans for selectable text
      this._renderTextLayer(textContent, textDiv, viewport);

      // Update wrapper
      wrapper.innerHTML = "";
      wrapper.classList.remove("page-skeleton");
      wrapper.style.width = `${canvas.width}px`;
      wrapper.style.height = `${canvas.height}px`;
      wrapper.appendChild(canvas);
      wrapper.appendChild(textDiv);

      this.renderedPages.set(pageNum, { canvas, textDiv });
      this.renderQueue.delete(pageNum);

      // Re-apply search highlights if needed
      if (
        this.searchQuery &&
        this.searchResults.some((r) => r.page === pageNum)
      ) {
        this._highlightPageResults(pageNum);
      }
    } catch (err) {
      this.renderQueue.delete(pageNum);
      console.warn(`Failed to render page ${pageNum}:`, err);
    }
  },

  /* ── Text Layer ─────────────────────────────────────────── */
  _renderTextLayer(textContent, container, viewport) {
    container.innerHTML = "";
    const scaleX = viewport.width / viewport.viewBox[2];
    const scaleY = viewport.height / viewport.viewBox[3];

    textContent.items.forEach((item) => {
      if (!item.str.trim()) return;
      const span = document.createElement("span");
      span.textContent = item.str;

      const tx = item.transform;
      const x = tx[4] * scaleX;
      const y = viewport.height - tx[5] * scaleY;
      const fontSize = Math.sqrt(tx[0] ** 2 + tx[1] ** 2) * scaleY;

      span.style.cssText = `
        position:absolute;
        left:${x}px;
        top:${y - fontSize}px;
        font-size:${fontSize}px;
        white-space:pre;
        color:transparent;
        cursor:text;
        transform-origin:left bottom;
        user-select:text;
      `;

      container.appendChild(span);
    });
  },

  /* ── Evict Cache ────────────────────────────────────────── */
  _evictCache(startPage, endPage) {
    for (const [pageNum] of this.renderedPages) {
      if (
        pageNum < startPage - this.BUFFER_PAGES ||
        pageNum > endPage + this.BUFFER_PAGES
      ) {
        const wrapper = document.getElementById(`page-${pageNum}`);
        if (wrapper) {
          const ps = this.pageSizes[pageNum - 1] || this.pageSizes[0];
          const scale = this._computeScale();
          wrapper.innerHTML = "";
          wrapper.classList.add("page-skeleton");
          wrapper.style.width = `${Math.floor(ps.width * scale)}px`;
          wrapper.style.height = `${Math.floor(ps.height * scale)}px`;
        }
        this.renderedPages.delete(pageNum);
      }
    }
  },

  /* ── Update Current Page ────────────────────────────────── */
  _updateCurrentPage(scrollTop, viewHeight) {
    const center = scrollTop + viewHeight / 2;
    let bestPage = 1;
    for (let i = 0; i < this.totalPages; i++) {
      if (this.pageOffsets[i] <= center) bestPage = i + 1;
      else break;
    }

    if (bestPage !== this.currentPage) {
      const prevPage = this.currentPage;
      this.currentPage = bestPage;
      Stats.recordPageRead(bestPage);
      Storage.setBookProgress(this.currentBook.id, bestPage);
      this._updateUI();

      // Highlight active TOC
      this._updateActiveTOC();
    }
  },

  /* ── UI Updates ─────────────────────────────────────────── */
  _updateUI() {
    const p = this.currentPage,
      t = this.totalPages;
    const pct = t > 0 ? Math.round((p / t) * 100) : 0;

    document.getElementById("page-info").textContent = `Page ${p} of ${t}`;
    document.getElementById("progress-fill").style.width = `${pct}%`;
    document.getElementById("progress-pct").textContent = `${pct}%`;
    document.getElementById("progress-slider").value = p;
    document.getElementById("zoom-level").textContent =
      `${Math.round(this.scale * 100)}%`;

    const remaining = Stats.estimateReadingTime(t - p);
    document.getElementById("read-time-est").textContent = remaining;

    const wpm = Stats.getWPM();
    document.getElementById("wpm-badge").textContent = `${wpm} WPM`;

    // Bookmark button state
    const bookmarks = Storage.getBookmarks(this.currentBook?.id || "");
    const isBookmarked = bookmarks.some((b) => b.page === p);
    document
      .getElementById("bookmark-btn")
      .classList.toggle("bookmarked", isBookmarked);
  },

  _updateProgressSlider() {
    const slider = document.getElementById("progress-slider");
    slider.max = this.totalPages;
    slider.value = this.currentPage;
  },

  /* ── TOC ────────────────────────────────────────────────── */
  async _renderTOC() {
    if (!this.pdfDoc) return;
    const tocList = document.getElementById("toc-list");

    try {
      const outline = await this.pdfDoc.getOutline();
      if (!outline || outline.length === 0) {
        tocList.innerHTML =
          '<p class="panel-empty">No table of contents in this PDF.</p>';
        return;
      }

      tocList.innerHTML = "";
      this._buildTOCItems(outline, tocList, 1);
    } catch (err) {
      tocList.innerHTML =
        '<p class="panel-empty">Could not load table of contents.</p>';
    }
  },

  _buildTOCItems(items, container, level) {
    items.forEach((item) => {
      const div = document.createElement("button");
      div.className = `toc-item level-${Math.min(level, 3)}`;
      div.textContent = item.title;
      div.addEventListener("click", async () => {
        if (item.dest) {
          try {
            const dest =
              typeof item.dest === "string"
                ? await this.pdfDoc.getDestination(item.dest)
                : item.dest;

            if (dest) {
              const ref = dest[0];
              const pageIndex = await this.pdfDoc.getPageIndex(ref);
              this.goToPage(pageIndex + 1);
            }
          } catch (e) {
            /* invalid dest */
          }
        }
      });
      container.appendChild(div);

      if (item.items && item.items.length) {
        this._buildTOCItems(item.items, container, level + 1);
      }
    });
  },

  _updateActiveTOC() {
    document
      .querySelectorAll(".toc-item")
      .forEach((el) => el.classList.remove("active"));
  },

  /* ── Thumbnails ─────────────────────────────────────────── */
  async _renderThumbnails() {
    const grid = document.getElementById("thumb-grid");
    grid.innerHTML = "";
    const maxThumbs = Math.min(this.totalPages, 100); // limit for perf

    for (let i = 1; i <= maxThumbs; i++) {
      const item = document.createElement("div");
      item.className = "thumb-item";
      item.id = `thumb-${i}`;
      item.dataset.page = i;

      const numLabel = document.createElement("span");
      numLabel.className = "thumb-num";
      numLabel.textContent = i;
      item.appendChild(numLabel);
      item.addEventListener("click", () => this.goToPage(i));
      grid.appendChild(item);
    }

    // Render thumbnail canvases lazily
    for (let i = 1; i <= maxThumbs; i++) {
      await this._renderThumbnail(i);
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0)); // yield
    }
  },

  async _renderThumbnail(pageNum) {
    const item = document.getElementById(`thumb-${pageNum}`);
    if (!item || !this.pdfDoc) return;

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 0.18 });
      const canvas = document.createElement("canvas");
      canvas.className = "thumb-canvas";
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport })
        .promise;
      item.insertBefore(canvas, item.firstChild);
    } catch (e) {
      /* skip */
    }
  },

  _updateActiveThumbnail() {
    document.querySelectorAll(".thumb-item").forEach((el) => {
      el.classList.toggle(
        "active",
        parseInt(el.dataset.page) === this.currentPage,
      );
    });
  },

  /* ── Navigation ─────────────────────────────────────────── */
  goToPage(pageNum) {
    pageNum = Math.max(1, Math.min(this.totalPages, pageNum));
    this.currentPage = pageNum;
    this._scrollToPage(pageNum);
    this._updateUI();
    this._updateActiveThumbnail();
  },

  nextPage() {
    this.goToPage(this.currentPage + 1);
  },
  prevPage() {
    this.goToPage(this.currentPage - 1);
  },

  /* ── Zoom ───────────────────────────────────────────────── */
  setFitMode(mode) {
    this.fitMode = mode;
    if (mode === "actual") this.scale = 1.0;
    this._rebuild();
  },

  zoomIn() {
    this.fitMode = "actual";
    this.scale = Math.min(5.0, this.scale + 0.15);
    this._rebuild();
  },

  zoomOut() {
    this.fitMode = "actual";
    this.scale = Math.max(0.3, this.scale - 0.15);
    this._rebuild();
  },

  setZoom(pct) {
    this.fitMode = "actual";
    this.scale = Math.max(0.3, Math.min(5.0, pct / 100));
    this._rebuild();
  },

  resetZoom() {
    this.fitMode = "width";
    this._rebuild();
  },

  _rebuild() {
    if (!this.pdfDoc) return;
    const savedPage = this.currentPage;
    this.renderedPages.clear();
    this._buildContainer();
    requestAnimationFrame(() => {
      this._scrollToPage(savedPage, false);
      this._renderVisiblePages();
      this._updateUI();
    });
  },

  /* ── Search ─────────────────────────────────────────────── */
  async search(query) {
    this.searchQuery = query.trim();
    this.searchResults = [];
    this.searchIndex = -1;
    this._clearSearchHighlights();

    if (!this.searchQuery || !this.pdfDoc) {
      document.getElementById("search-count").textContent = "";
      return;
    }

    const q = this.searchQuery.toLowerCase();
    for (let i = 1; i <= this.totalPages; i++) {
      try {
        const page = await this.pdfDoc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str).join(" ");
        if (text.toLowerCase().includes(q)) {
          this.searchResults.push({ page: i, text: text.substring(0, 80) });
        }
      } catch (e) {
        /* skip */
      }
    }

    const count = this.searchResults.length;
    document.getElementById("search-count").textContent =
      count > 0 ? `${count} result${count !== 1 ? "s" : ""}` : "No results";

    if (count > 0) {
      this.searchIndex = 0;
      this._jumpToSearchResult(0);
    }
  },

  _jumpToSearchResult(index) {
    if (index < 0 || index >= this.searchResults.length) return;
    this.searchIndex = index;
    const result = this.searchResults[index];
    this.goToPage(result.page);
    this._highlightPageResults(result.page);
    document.getElementById("search-count").textContent =
      `${index + 1} / ${this.searchResults.length}`;
  },

  searchNext() {
    this._jumpToSearchResult(
      (this.searchIndex + 1) % this.searchResults.length,
    );
  },

  searchPrev() {
    this._jumpToSearchResult(
      (this.searchIndex - 1 + this.searchResults.length) %
        this.searchResults.length,
    );
  },

  _highlightPageResults(pageNum) {
    const wrapper = document.getElementById(`page-${pageNum}`);
    if (!wrapper) return;
    const spans = wrapper.querySelectorAll(".text-layer span");
    const q = this.searchQuery.toLowerCase();

    spans.forEach((span) => {
      if (span.textContent.toLowerCase().includes(q)) {
        span.classList.add("highlight");
      }
    });
  },

  _clearSearchHighlights() {
    document.querySelectorAll(".text-layer .highlight").forEach((el) => {
      el.classList.remove("highlight", "selected");
    });
  },

  /* ── Bookmarks ──────────────────────────────────────────── */
  toggleBookmark() {
    if (!this.currentBook) return;
    const bookmarks = Storage.getBookmarks(this.currentBook.id);
    const idx = bookmarks.findIndex((b) => b.page === this.currentPage);

    if (idx >= 0) {
      bookmarks.splice(idx, 1);
    } else {
      bookmarks.push({
        page: this.currentPage,
        label: `Page ${this.currentPage}`,
        addedAt: Date.now(),
      });
      bookmarks.sort((a, b) => a.page - b.page);
    }

    Storage.setBookmarks(this.currentBook.id, bookmarks);
    this._renderBookmarksList();
    this._updateUI();
  },

  _renderBookmarksList() {
    if (!this.currentBook) return;
    const list = document.getElementById("bookmarks-list");
    const bookmarks = Storage.getBookmarks(this.currentBook.id);

    if (bookmarks.length === 0) {
      list.innerHTML =
        '<p class="panel-empty">No bookmarks yet. Press <kbd>B</kbd> to add one.</p>';
      return;
    }

    list.innerHTML = "";
    bookmarks.forEach((bm) => {
      const item = document.createElement("div");
      item.className = "bookmark-item";
      item.innerHTML = `
        <span class="bookmark-page-num">${bm.page}</span>
        <span class="bookmark-text">${bm.label}</span>
        <button class="bookmark-del" aria-label="Remove bookmark">×</button>
      `;
      item
        .querySelector(".bookmark-page-num")
        .addEventListener("click", () => this.goToPage(bm.page));
      item
        .querySelector(".bookmark-text")
        .addEventListener("click", () => this.goToPage(bm.page));
      item.querySelector(".bookmark-del").addEventListener("click", (e) => {
        e.stopPropagation();
        const updated = Storage.getBookmarks(this.currentBook.id).filter(
          (b) => b.page !== bm.page,
        );
        Storage.setBookmarks(this.currentBook.id, updated);
        this._renderBookmarksList();
        this._updateUI();
      });
      list.appendChild(item);
    });
  },

  /* ── UI Binding ─────────────────────────────────────────── */
  _bindUI() {
    const viewport = document.getElementById("pdf-viewport");

    // Scroll handler
    viewport.addEventListener(
      "scroll",
      () => {
        clearTimeout(this.scrollDebounce);
        this.scrollDebounce = setTimeout(() => {
          this._renderVisiblePages();
          this._updateActiveThumbnail();
        }, 50);
      },
      { passive: true },
    );

    // Progress slider
    document
      .getElementById("progress-slider")
      .addEventListener("input", (e) => {
        this.goToPage(parseInt(e.target.value));
      });

    // Zoom controls
    document
      .getElementById("zoom-in")
      .addEventListener("click", () => this.zoomIn());
    document
      .getElementById("zoom-out")
      .addEventListener("click", () => this.zoomOut());

    // Zoom range in settings
    document.getElementById("zoom-range").addEventListener("input", (e) => {
      this.setZoom(parseInt(e.target.value));
      document.getElementById("zoom-val-display").textContent =
        `${e.target.value}%`;
    });

    // Page nav buttons
    document
      .getElementById("prev-page-btn")
      .addEventListener("click", () => this.prevPage());
    document
      .getElementById("next-page-btn")
      .addEventListener("click", () => this.nextPage());

    // Bookmark
    document
      .getElementById("bookmark-btn")
      .addEventListener("click", () => this.toggleBookmark());

    // Sidebar tabs
    document.querySelectorAll(".sidebar-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".sidebar-tab").forEach((t) => {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
        });
        document
          .querySelectorAll(".sidebar-panel")
          .forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        tab.setAttribute("aria-selected", "true");
        document
          .getElementById(`panel-${tab.dataset.tab}`)
          .classList.add("active");
        if (tab.dataset.tab === "bookmarks") this._renderBookmarksList();
      });
    });

    // Sidebar toggle
    document.getElementById("sidebar-toggle").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("collapsed");
    });

    // Search
    const searchInput = document.getElementById("search-input");
    let searchDebounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => this.search(searchInput.value), 400);
    });
    document
      .getElementById("search-next")
      .addEventListener("click", () => this.searchNext());
    document
      .getElementById("search-prev")
      .addEventListener("click", () => this.searchPrev());

    const searchBar = document.getElementById("search-bar");
    document.getElementById("search-open-btn").addEventListener("click", () => {
      searchBar.classList.toggle("visible");
      document.getElementById("search-open-btn").style.display =
        searchBar.classList.contains("visible") ? "none" : "";
      if (searchBar.classList.contains("visible")) searchInput.focus();
    });
    document.getElementById("search-close").addEventListener("click", () => {
      searchBar.classList.remove("visible");
      document.getElementById("search-open-btn").style.display = "";
      this.searchQuery = "";
      this._clearSearchHighlights();
      document.getElementById("search-count").textContent = "";
      searchInput.value = "";
    });

    // TOC search filter
    document.getElementById("toc-search").addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(".toc-item").forEach((item) => {
        item.style.display = item.textContent.toLowerCase().includes(q)
          ? ""
          : "none";
      });
    });

    // Jump overlay
    document.getElementById("jump-go").addEventListener("click", () => {
      const val = parseInt(document.getElementById("jump-input").value);
      if (val >= 1 && val <= this.totalPages) {
        this.goToPage(val);
        document.getElementById("jump-overlay").style.display = "none";
      }
    });
    document.getElementById("jump-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("jump-go").click();
      if (e.key === "Escape")
        document.getElementById("jump-overlay").style.display = "none";
    });

    // Touch / Swipe
    let touchStartX = 0,
      touchStartY = 0;
    viewport.addEventListener(
      "touchstart",
      (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      },
      { passive: true },
    );

    viewport.addEventListener(
      "touchend",
      (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
        if (Math.abs(dx) > 60 && dy < 40) {
          if (dx < 0) this.nextPage();
          else this.prevPage();
        }
      },
      { passive: true },
    );

    // Resize
    window.addEventListener("resize", () => {
      if (this.fitMode !== "actual") {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this._rebuild(), 300);
      }
    });
  },

  _bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (document.getElementById("reader-view").style.display === "none")
        return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          e.preventDefault();
          this.nextPage();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          this.prevPage();
          break;
        case "Home":
          e.preventDefault();
          this.goToPage(1);
          break;
        case "End":
          e.preventDefault();
          this.goToPage(this.totalPages);
          break;
        case "+":
        case "=":
          e.preventDefault();
          this.zoomIn();
          break;
        case "-":
          e.preventDefault();
          this.zoomOut();
          break;
        case "0":
          e.preventDefault();
          this.resetZoom();
          break;
        case "b":
        case "B":
          this.toggleBookmark();
          break;
        case "g":
        case "G": {
          const j = document.getElementById("jump-overlay");
          const visible = j.style.display !== "none";
          j.style.display = visible ? "none" : "flex";
          if (!visible) {
            document.getElementById("jump-input").focus();
            document.getElementById("jump-input").value = "";
          }
          break;
        }
        case "f":
        case "F":
          if (!e.ctrlKey && !e.metaKey) {
            this._toggleFullscreen();
          }
          break;
        case "h":
        case "H":
          this._toggleFocusMode();
          break;
        case "d":
        case "D":
          Themes.toggle();
          break;
        case "l":
        case "L":
          if (!e.ctrlKey && !e.metaKey) App.showLibrary();
          break;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        document.getElementById("search-open-btn").click();
      }
    });
  },

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  },

  _toggleFocusMode() {
    document.body.classList.toggle("focus-mode");
    if (document.body.classList.contains("focus-mode")) {
      this._startFocusTimeout();
    } else {
      document.body.classList.add("ui-visible");
    }
  },

  _focusTimeout: null,
  _startFocusTimeout() {
    document.body.classList.remove("ui-visible");
    clearTimeout(this._focusTimeout);
  },

  _setupFocusMouseMove() {
    document.getElementById("reader-view").addEventListener("mousemove", () => {
      if (!document.body.classList.contains("focus-mode")) return;
      document.body.classList.add("ui-visible");
      clearTimeout(this._focusTimeout);
      this._focusTimeout = setTimeout(() => {
        document.body.classList.remove("ui-visible");
      }, 3000);
    });
  },

  /* ── Error / Loading ────────────────────────────────────── */
  _showLoading(show) {
    const el = document.getElementById("reader-loading");
    el.classList.toggle("hidden", !show);
  },

  _showError(msg) {
    document.getElementById("reader-loading").innerHTML =
      `<p style="color:var(--text-muted);text-align:center;padding:40px">${msg}</p>`;
    document.getElementById("reader-loading").classList.remove("hidden");
  },
};
