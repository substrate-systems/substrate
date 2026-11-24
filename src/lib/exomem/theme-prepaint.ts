import { applyExomemTheme, isExomemPath, onProductHost } from "./theme";

const root = document.documentElement;
if (isExomemPath(location.pathname, onProductHost(root, location.hostname))) applyExomemTheme(root);
