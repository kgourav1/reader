/**
 * stats.js — Folio PDF Reader
 * Tracks reading sessions, words-per-minute, streaks, daily goals
 */

const Stats = {
  // Average words per page in a book (approximation)
  WORDS_PER_PAGE: 250,
  WPM_DEFAULT: 250,

  _sessionStart: null,
  _sessionPages: 0,
  _breakTimer: null,
  _breakCallback: null,

  /* ── Session Management ─────────────────────────────────── */
  startSession(bookId) {
    this._sessionStart = Date.now();
    this._sessionPages = 0;
    this._bookId = bookId;
    this._recordToday();
    this._startBreakTimer();
  },

  endSession() {
    if (!this._sessionStart) return;

    const duration = (Date.now() - this._sessionStart) / 60000; // minutes
    const stats = this._load();

    stats.totalMinutes = (stats.totalMinutes || 0) + duration;
    stats.totalPages = (stats.totalPages || 0) + this._sessionPages;

    // Update WPM based on session
    if (duration > 1 && this._sessionPages > 0) {
      const wordsRead = this._sessionPages * this.WORDS_PER_PAGE;
      const wpm = Math.round(wordsRead / duration);
      const prevWpm = stats.avgWpm || this.WPM_DEFAULT;
      stats.avgWpm = Math.round(prevWpm * 0.7 + wpm * 0.3); // rolling average
    }

    this._save(stats);
    this._stopBreakTimer();
    this._sessionStart = null;
  },

  recordPageRead(page) {
    this._sessionPages++;
    const stats = this._load();
    const today = this._todayKey();
    if (!stats.dailyPages) stats.dailyPages = {};
    stats.dailyPages[today] = (stats.dailyPages[today] || 0) + 1;
    this._save(stats);
  },

  /* ── Break Reminder ─────────────────────────────────────── */
  setBreakCallback(fn) {
    this._breakCallback = fn;
  },

  _startBreakTimer() {
    this._stopBreakTimer();
    this._breakTimer = setTimeout(
      () => {
        if (this._breakCallback) this._breakCallback();
      },
      30 * 60 * 1000,
    ); // 30 minutes
  },

  _stopBreakTimer() {
    if (this._breakTimer) {
      clearTimeout(this._breakTimer);
      this._breakTimer = null;
    }
  },

  /* ── Reading Streak ─────────────────────────────────────── */
  _recordToday() {
    const stats = this._load();
    const today = this._todayKey();
    if (!stats.readDays) stats.readDays = [];
    if (!stats.readDays.includes(today)) {
      stats.readDays.push(today);
      stats.readDays = stats.readDays.slice(-365); // keep 1 year
    }
    this._save(stats);
  },

  getStreak() {
    const stats = this._load();
    const days = new Set(stats.readDays || []);
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 365; i++) {
      const key = this._dateKey(d);
      if (days.has(key)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  },

  getLongestStreak() {
    const stats = this._load();
    const days = [...new Set(stats.readDays || [])].sort();
    if (days.length === 0) return 0;

    let longest = 1,
      current = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1]);
      const curr = new Date(days[i]);
      const diff = (curr - prev) / (1000 * 60 * 60 * 24);
      if (diff === 1) {
        current++;
        longest = Math.max(longest, current);
      } else {
        current = 1;
      }
    }
    return longest;
  },

  /* ── WPM & Time Estimates ───────────────────────────────── */
  getWPM() {
    const stats = this._load();
    return stats.avgWpm || this.WPM_DEFAULT;
  },

  estimateReadingTime(pagesLeft) {
    const wpm = this.getWPM();
    const wordsLeft = pagesLeft * this.WORDS_PER_PAGE;
    const minutes = Math.round(wordsLeft / wpm);
    if (minutes < 60) return `${minutes}m left`;
    const h = Math.floor(minutes / 60),
      m = minutes % 60;
    return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
  },

  estimateFinishDate(pagesLeft) {
    const stats = this._load();
    const dailyPages = stats.dailyPages || {};
    const recent = Object.values(dailyPages).slice(-7);
    const avgDaily =
      recent.length > 0
        ? recent.reduce((a, b) => a + b, 0) / recent.length
        : 20;

    if (avgDaily < 1) return "Finish date unknown";
    const daysLeft = Math.ceil(pagesLeft / avgDaily);
    const finishDate = new Date();
    finishDate.setDate(finishDate.getDate() + daysLeft);
    return finishDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  },

  /* ── Calendar Data ──────────────────────────────────────── */
  getCalendarData(days = 70) {
    const stats = this._load();
    const readDays = new Set(stats.readDays || []);
    const result = [];
    const d = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(d);
      date.setDate(date.getDate() - i);
      const key = this._dateKey(date);
      result.push({ key, read: readDays.has(key), today: i === 0 });
    }
    return result;
  },

  /* ── Summary Stats ──────────────────────────────────────── */
  getSummary() {
    const stats = this._load();
    return {
      totalMinutes: Math.round(stats.totalMinutes || 0),
      totalPages: stats.totalPages || 0,
      avgWpm: stats.avgWpm || this.WPM_DEFAULT,
      streak: this.getStreak(),
      longestStreak: this.getLongestStreak(),
      todayPages: this._getTodayPages(),
      totalHours: Math.round(((stats.totalMinutes || 0) / 60) * 10) / 10,
    };
  },

  _getTodayPages() {
    const stats = this._load();
    const today = this._todayKey();
    return (stats.dailyPages || {})[today] || 0;
  },

  /* ── Helpers ────────────────────────────────────────────── */
  _todayKey() {
    return this._dateKey(new Date());
  },

  _dateKey(date) {
    return date.toISOString().split("T")[0];
  },

  _load() {
    return Storage.get("stats", {});
  },
  _save(data) {
    Storage.set("stats", data);
  },
};
