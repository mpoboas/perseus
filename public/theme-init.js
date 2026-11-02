// Runs before first paint so the window never flashes the wrong theme.
// An external file because the production CSP forbids inline scripts.
(function () {
  try {
    var pref = localStorage.getItem("perseus.theme");
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = pref === "light" || pref === "dark" ? pref : dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = "dark";
  }
})();
