/**
 * themes.js — Folio PDF Reader
 * Manages all visual themes and reading mode preferences
 */

const Themes = {
  THEMES: ["light", "dark", "sepia", "paper", "oled"],
  current: "light",

  init() {
    const saved = Storage.get("settings", {}).theme || "light";
    this.apply(saved);
  },

  apply(themeName) {
    if (!this.THEMES.includes(themeName)) themeName = "light";
    this.current = themeName;

    // Remove all theme classes
    document.body.classList.remove(...this.THEMES.map((t) => `theme-${t}`));
    document.body.classList.add(`theme-${themeName}`);

    // Update settings buttons
    document.querySelectorAll(".swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === themeName);
    });

    // Persist
    const settings = Storage.get("settings", {});
    settings.theme = themeName;
    Storage.set("settings", settings);
  },

  toggle() {
    // Simple toggle: light ↔ dark
    const next = this.current === "dark" ? "light" : "dark";
    this.apply(next);
  },

  isDark() {
    return ["dark", "oled"].includes(this.current);
  },

  // Returns appropriate canvas background for PDF rendering
  getCanvasBackground() {
    switch (this.current) {
      case "sepia":
        return "#F4ECD8";
      case "oled":
        return "#111111";
      default:
        return "#FFFFFF";
    }
  },
};
