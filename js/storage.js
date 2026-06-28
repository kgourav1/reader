/**
 * storage.js — Folio PDF Reader
 * Handles all persistence: IndexedDB for PDF files, localStorage for settings/stats
 */

const DB_NAME = "FolioReader";
const DB_VERSION = 2;
const STORE_PDFS = "pdfs";
const STORE_META = "meta";

let db = null;

/* ── IndexedDB Setup ──────────────────────────────────────── */
const Storage = {
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_PDFS)) {
          database.createObjectStore(STORE_PDFS, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(STORE_META)) {
          database.createObjectStore(STORE_META, { keyPath: "id" });
        }
      };

      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };

      req.onerror = () => reject(req.error);
    });
  },

  /* ── PDF Binary Storage ─────────────────────────────────── */
  async savePDF(id, arrayBuffer, meta = {}) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PDFS], "readwrite");
      const store = tx.objectStore(STORE_PDFS);
      const req = store.put({
        id,
        data: arrayBuffer,
        meta,
        savedAt: Date.now(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async getPDF(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PDFS], "readonly");
      const store = tx.objectStore(STORE_PDFS);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async deletePDF(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PDFS], "readwrite");
      const store = tx.objectStore(STORE_PDFS);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async getAllPDFMeta() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PDFS], "readonly");
      const store = tx.objectStore(STORE_PDFS);
      const results = [];
      const req = store.openCursor();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          results.push({
            id: cursor.value.id,
            meta: cursor.value.meta,
            savedAt: cursor.value.savedAt,
          });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  /* ── LocalStorage Helpers ───────────────────────────────── */
  set(key, value) {
    try {
      localStorage.setItem(`folio_${key}`, JSON.stringify(value));
    } catch (e) {
      /* storage full */
    }
  },

  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`folio_${key}`);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },

  remove(key) {
    localStorage.removeItem(`folio_${key}`);
  },

  /* ── Book-specific getters/setters ──────────────────────── */
  getBookProgress(bookId) {
    const all = this.get("progress", {});
    return all[bookId] || { page: 1, timestamp: Date.now() };
  },

  setBookProgress(bookId, page) {
    const all = this.get("progress", {});
    all[bookId] = { page, timestamp: Date.now() };
    this.set("progress", all);
  },

  getBookmarks(bookId) {
    const all = this.get("bookmarks", {});
    return all[bookId] || [];
  },

  setBookmarks(bookId, bookmarks) {
    const all = this.get("bookmarks", {});
    all[bookId] = bookmarks;
    this.set("bookmarks", all);
  },

  getNotes(bookId) {
    const all = this.get("notes", {});
    return all[bookId] || [];
  },

  setNotes(bookId, notes) {
    const all = this.get("notes", {});
    all[bookId] = notes;
    this.set("notes", all);
  },

  /* ── Recent books ───────────────────────────────────────── */
  addRecent(bookId, title) {
    const recents = this.get("recents", []);
    const filtered = recents.filter((r) => r.id !== bookId);
    filtered.unshift({ id: bookId, title, openedAt: Date.now() });
    this.set("recents", filtered.slice(0, 20));
  },

  getRecents() {
    return this.get("recents", []);
  },

  /* ── Export / Import ────────────────────────────────────── */
  exportData() {
    const keys = [
      "bookmarks",
      "notes",
      "progress",
      "stats",
      "settings",
      "recents",
    ];
    const data = {};
    keys.forEach((k) => {
      data[k] = this.get(k);
    });
    return JSON.stringify(data, null, 2);
  },

  importData(jsonStr) {
    const data = JSON.parse(jsonStr);
    Object.entries(data).forEach(([k, v]) => {
      if (v !== null) this.set(k, v);
    });
  },
};
