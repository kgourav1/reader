// ui-controller.js

export const initUI = () => {
  let focusTimer;

  // Reset focus mode timer on mouse move or touch
  const resetFocusTimer = () => {
    document.body.classList.remove("focus-mode");
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      document.body.classList.add("focus-mode");
    }, 3000); // 3 seconds to disappear
  };

  window.addEventListener("mousemove", resetFocusTimer);
  window.addEventListener("touchstart", resetFocusTimer);
  window.addEventListener("keydown", resetFocusTimer);

  // Start initial timer
  resetFocusTimer();

  // Theme Switcher
  const themes = ["light", "sepia", "dark"];
  let currentThemeIndex = 0;

  document.getElementById("btn-theme").addEventListener("click", () => {
    currentThemeIndex = (currentThemeIndex + 1) % themes.length;
    document.documentElement.setAttribute(
      "data-theme",
      themes[currentThemeIndex],
    );
  });

  // Sidebar Toggle
  document.getElementById("btn-sidebar").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("hidden");
  });

  // Fullscreen Toggle
  document.getElementById("btn-fullscreen").addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  });
};
