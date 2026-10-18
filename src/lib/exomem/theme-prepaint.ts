import { applyExomemTheme, isExomemPath } from "./theme";

if (isExomemPath(location.pathname)) applyExomemTheme(document.documentElement);
