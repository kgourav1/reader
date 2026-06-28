/**
 * script.js — Folio PDF Reader
 * App entry point: wires everything together, handles settings/stats panels,
 * ambient sounds, PWA, focus mode, and view routing.
 */

/* ══════════════════════════════════════════════════════════
   APP — Main Controller
══════════════════════════════════════════════════════════ */
const App = {
  currentBook: null,
  ambientAudio: null,
  ambientType: "off",
  breakEnabled: false,

  /* ── Bootstrap ──────────────────────────────────────────── */
  async init() {
    await Storage.init();
    Themes.init();
    await Library.init();
    this._bindNav();
    this._bindSettings();
    this._bindStats();
    this._bindBreakReminder();
    Reader.init();
    Reader._setupFocusMouseMove();
    this._loadSettings();
    this._registerServiceWorker();
  },

  /* ── View Routing ───────────────────────────────────────── */
  showLibrary() {
    Stats.endSession();
    document.getElementById("library-view").classList.add("active");
    document.getElementById("reader-view").classList.remove("active");
    document.body.classList.remove("focus-mode", "ui-visible");
    Library._renderContinueReading();
    Library._renderStatsPreview();
  },

  showReader() {
    document.getElementById("library-view").classList.remove("active");
    document.getElementById("reader-view").classList.add("active");
  },

  /* ── Open Book ──────────────────────────────────────────── */
  async openBook(book) {
    this.currentBook = book;
    this.showReader();

    try {
      let source;

      if (book.source === "uploaded" || book.source === "recent") {
        // Load from IndexedDB
        const stored = await Storage.getPDF(book.id);
        if (!stored) {
          // Might be a recent from before IDB, try builtin path
          source = `books/${book.id}.pdf`;
        } else {
          source = stored.data;
        }
      } else if (book.source === "builtin") {
        source = book.path;
      } else {
        source = book.path || `books/${book.id}.pdf`;
      }

      await Reader.open(source, { id: book.id, title: book.title });
    } catch (err) {
      console.error("Open book error:", err);
    }
  },

  /* ── Navigation ─────────────────────────────────────────── */
  _bindNav() {
    document
      .getElementById("back-to-library")
      .addEventListener("click", () => this.showLibrary());
    document
      .getElementById("lib-theme-toggle")
      .addEventListener("click", () => Themes.toggle());
    document
      .getElementById("theme-toggle-reader")
      .addEventListener("click", () => Themes.toggle());
    document
      .getElementById("fullscreen-btn")
      .addEventListener("click", () => Reader._toggleFullscreen());
    document
      .getElementById("hide-ui-btn")
      .addEventListener("click", () => Reader._toggleFocusMode());

    document
      .getElementById("open-stats-btn")
      .addEventListener("click", () => this.openStats());

    // Click outside panels to close
    document.querySelectorAll(".overlay-panel").forEach((panel) => {
      panel.addEventListener("click", (e) => {
        if (e.target === panel) panel.style.display = "none";
      });
    });

    // Escape to close panels
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document
          .querySelectorAll(".overlay-panel")
          .forEach((p) => (p.style.display = "none"));
        document.getElementById("jump-overlay").style.display = "none";
        const searchBar = document.getElementById("search-bar");
        if (searchBar.classList.contains("visible")) {
          document.getElementById("search-close").click();
        }
      }
    });

    // Settings button in reader
    document.getElementById("settings-btn").addEventListener("click", () => {
      document.getElementById("settings-panel").style.display = "flex";
    });
    document.getElementById("settings-close").addEventListener("click", () => {
      document.getElementById("settings-panel").style.display = "none";
    });
    document.getElementById("stats-close").addEventListener("click", () => {
      document.getElementById("stats-panel").style.display = "none";
    });
    document.getElementById("break-dismiss").addEventListener("click", () => {
      document.getElementById("break-toast").style.display = "none";
    });
  },

  /* ── Settings Panel ─────────────────────────────────────── */
  _bindSettings() {
    // Theme swatches
    document.querySelectorAll(".swatch").forEach((btn) => {
      btn.addEventListener("click", () => Themes.apply(btn.dataset.theme));
    });

    // View mode pills
    document
      .querySelectorAll(".pill:not(.fit-pill):not(.sound-pill)")
      .forEach((pill) => {
        if (!pill.dataset.mode) return;
        pill.addEventListener("click", () => {
          document
            .querySelectorAll("[data-mode]")
            .forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
          this._saveSettings();
        });
      });

    // Fit mode
    document.querySelectorAll(".fit-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document
          .querySelectorAll(".fit-pill")
          .forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        Reader.setFitMode(pill.dataset.fit);
        this._saveSettings();
      });
    });

    // Zoom range
    document.getElementById("zoom-range").addEventListener("input", (e) => {
      document.getElementById("zoom-val-display").textContent =
        `${e.target.value}%`;
    });

    // Blue light
    document
      .getElementById("blue-light-toggle")
      .addEventListener("change", (e) => {
        document.getElementById("blue-light-overlay").style.display = e.target
          .checked
          ? "block"
          : "none";
        this._saveSettings();
      });

    // Break reminder
    document
      .getElementById("break-reminder-toggle")
      .addEventListener("change", (e) => {
        this.breakEnabled = e.target.checked;
        this._saveSettings();
      });

    // Ambient sound
    document.querySelectorAll(".sound-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document
          .querySelectorAll(".sound-pill")
          .forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        this._setAmbientSound(pill.dataset.sound);
        this._saveSettings();
      });
    });
  },

  /* ── Ambient Sound ──────────────────────────────────────── */
  _setAmbientSound(type) {
    this.ambientType = type;

    if (this.ambientAudio) {
      this.ambientAudio.pause();
      this.ambientAudio = null;
    }

    if (type === "off") return;

    // Use Web Audio API to generate ambient noise
    this._generateAmbientNoise(type);
  },

  _audioCtx: null,
  _ambientNodes: [],

  _generateAmbientNoise(type) {
    try {
      if (!this._audioCtx) {
        this._audioCtx = new (
          window.AudioContext || window.webkitAudioContext
        )();
      }

      // Stop previous nodes
      this._ambientNodes.forEach((n) => {
        try {
          n.stop();
        } catch (e) {}
      });
      this._ambientNodes = [];

      const ctx = this._audioCtx;
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0.06;
      gainNode.connect(ctx.destination);

      // Create brown noise (warm, library-like)
      const bufferSize = ctx.sampleRate * 3;
      const buffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate);

      for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          if (type === "rain") {
            // Whiter, higher pitched for rain
            data[i] = white * 0.5;
          } else if (type === "fire") {
            // Low rumble for fire
            lastOut = (lastOut + 0.02 * white) / 1.02;
            data[i] = lastOut * 6;
          } else {
            // Brown noise base for library / forest
            lastOut = (lastOut + 0.02 * white) / 1.02;
            data[i] = lastOut * 4;
          }
        }
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      // Add filtering based on type
      const filter = ctx.createBiquadFilter();
      switch (type) {
        case "rain":
          filter.type = "bandpass";
          filter.frequency.value = 2000;
          filter.Q.value = 0.8;
          gainNode.gain.value = 0.15;
          break;
        case "library":
          filter.type = "lowpass";
          filter.frequency.value = 400;
          gainNode.gain.value = 0.04;
          break;
        case "forest":
          filter.type = "bandpass";
          filter.frequency.value = 800;
          filter.Q.value = 0.5;
          gainNode.gain.value = 0.08;
          break;
        case "fire":
          filter.type = "lowpass";
          filter.frequency.value = 200;
          gainNode.gain.value = 0.12;
          break;
      }

      source.connect(filter);
      filter.connect(gainNode);
      source.start();
      this._ambientNodes.push(source);
    } catch (e) {
      console.warn("Web Audio not available:", e);
    }
  },

  /* ── Break Reminder ─────────────────────────────────────── */
  _bindBreakReminder() {
    Stats.setBreakCallback(() => {
      if (!this.breakEnabled) return;
      const toast = document.getElementById("break-toast");
      toast.style.display = "flex";
      setTimeout(() => {
        toast.style.display = "none";
      }, 10000);
      // Reset for next cycle
      if (this.breakEnabled) Stats._startBreakTimer();
    });
  },

  /* ── Stats Panel ────────────────────────────────────────── */
  openStats() {
    document.getElementById("stats-panel").style.display = "flex";
    this._renderStatsPanel();
  },

  _renderStatsPanel() {
    const body = document.getElementById("stats-body");
    const s = Stats.getSummary();
    const calData = Stats.getCalendarData(70);

    const pct =
      Reader.totalPages > 0
        ? Math.round((Reader.currentPage / Reader.totalPages) * 100)
        : 0;
    const circumference = 2 * Math.PI * 30;
    const offset = circumference - (pct / 100) * circumference;

    body.innerHTML = `
      <!-- Current Book Progress Ring -->
      ${
        Reader.currentBook
          ? `
      <div>
        <div class="stats-section-title">Current Book</div>
        <div class="progress-ring-container">
          <svg class="ring-svg" width="80" height="80" viewBox="0 0 80 80">
            <circle class="ring-bg" cx="40" cy="40" r="30"/>
            <circle class="ring-fill" cx="40" cy="40" r="30"
              style="stroke-dasharray:${circumference};stroke-dashoffset:${offset}"/>
          </svg>
          <div class="ring-label">
            <div class="ring-pct">${pct}%</div>
            <div class="ring-sub">${Reader.currentBook.title}</div>
            <div class="ring-sub">Page ${Reader.currentPage} of ${Reader.totalPages}</div>
            <div class="ring-sub" style="color:var(--accent)">
              ${Reader.totalPages > 0 ? Stats.estimateFinishDate(Reader.totalPages - Reader.currentPage) : ""}
            </div>
          </div>
        </div>
      </div>
      `
          : ""
      }

      <!-- Summary Stats -->
      <div>
        <div class="stats-section-title">All Time</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">${s.totalHours}h</div>
            <div class="stat-label">Total reading</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${s.totalPages}</div>
            <div class="stat-label">Pages read</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${s.streak}</div>
            <div class="stat-label">Day streak 🔥</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${s.longestStreak}</div>
            <div class="stat-label">Best streak</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${s.avgWpm}</div>
            <div class="stat-label">Avg WPM</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${s.todayPages}</div>
            <div class="stat-label">Pages today</div>
          </div>
        </div>
      </div>

      <!-- Reading Calendar -->
      <div>
        <div class="stats-section-title">Reading History (10 weeks)</div>
        <div class="reading-calendar">
          ${calData
            .map(
              (d) => `
            <div class="cal-day ${d.read ? "has-reading" : ""} ${d.today ? "today" : ""}"
              title="${d.key}${d.read ? " — Read" : ""}"></div>
          `,
            )
            .join("")}
        </div>
        <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--text-muted)">
          <span style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;background:var(--border-strong);border-radius:2px;display:inline-block"></span>No reading
          </span>
          <span style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;background:var(--accent);border-radius:2px;display:inline-block"></span>Read
          </span>
          <span style="display:flex;align-items:center;gap:4px">
            <span style="width:12px;height:12px;background:var(--progress-color);border-radius:2px;display:inline-block"></span>Today
          </span>
        </div>
      </div>

      <!-- Export -->
      <div>
        <div class="stats-section-title">Data</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button onclick="App._exportData()" style="
            padding:7px 14px;border-radius:6px;border:1px solid var(--border);
            font-family:var(--font-ui);font-size:13px;background:var(--bg-secondary);
            color:var(--text-secondary);cursor:pointer">
            Export Bookmarks &amp; Notes
          </button>
          <label style="
            padding:7px 14px;border-radius:6px;border:1px solid var(--border);
            font-family:var(--font-ui);font-size:13px;background:var(--bg-secondary);
            color:var(--text-secondary);cursor:pointer">
            Import Data
            <input type="file" accept=".json" style="display:none" onchange="App._importData(event)">
          </label>
        </div>
      </div>
    `;
  },

  _exportData() {
    const data = Storage.exportData();
    const blob = new Blob([data], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `folio-backup-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
  },

  _importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        Storage.importData(ev.target.result);
        alert("Data imported successfully!");
        this._renderStatsPanel();
      } catch (err) {
        alert("Invalid file format.");
      }
    };
    reader.readAsText(file);
  },

  /* ── Save/Load Settings ─────────────────────────────────── */
  _saveSettings() {
    const settings = {
      theme: Themes.current,
      fitMode: Reader.fitMode,
      blueLight: document.getElementById("blue-light-toggle").checked,
      breakReminder: document.getElementById("break-reminder-toggle").checked,
      ambientSound: this.ambientType,
    };
    Storage.set("settings", settings);
  },

  _loadSettings() {
    const settings = Storage.get("settings", {});

    // Blue light
    if (settings.blueLight) {
      document.getElementById("blue-light-toggle").checked = true;
      document.getElementById("blue-light-overlay").style.display = "block";
    }

    // Break reminder
    if (settings.breakReminder) {
      document.getElementById("break-reminder-toggle").checked = true;
      this.breakEnabled = true;
    }

    // Fit mode
    if (settings.fitMode) {
      Reader.fitMode = settings.fitMode;
      document.querySelectorAll(".fit-pill").forEach((p) => {
        p.classList.toggle("active", p.dataset.fit === settings.fitMode);
      });
    }

    // Ambient sound
    if (settings.ambientSound && settings.ambientSound !== "off") {
      document.querySelectorAll(".sound-pill").forEach((p) => {
        p.classList.toggle("active", p.dataset.sound === settings.ambientSound);
      });
      this._setAmbientSound(settings.ambientSound);
    }
  },

  /* ── PWA / Service Worker ───────────────────────────────── */
  _registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  },
};

/* ── Boot ───────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => App.init());
