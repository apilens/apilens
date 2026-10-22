// Shared by the server layout (pre-paint script) and the client toggle.
export const THEME_KEY = "apilens-theme";

/** Runs before first paint so the page never flashes the wrong theme. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}`;
