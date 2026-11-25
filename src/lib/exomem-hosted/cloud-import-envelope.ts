import {
  ORIGIN_LABEL_MAX,
  SERIES_FILE,
  type ImportSeries,
  type UploadBrowserFamily,
  type UploadDeviceFamily,
  type UploadOrigin,
} from "../exomem/cloud-filing-contract";
import type { ImportFile } from "./cloud-import-browser";
import type { ImportSelection } from "./cloud-import-selection";

/** The parts of `navigator` that name the uploading device and browser. */
export type BrowserIdentity = {
  userAgent: string;
  maxTouchPoints?: number;
  /** User-Agent Client Hints, low entropy only; Safari and Firefox do not offer them. */
  userAgentData?: { mobile: boolean; platform: string; brands: { brand: string }[] };
};

// The tokens below are vendor-fixed product names in Client Hints brands and User-Agent strings.
// They map onto the contract's closed families; anything unmatched is `other`. A full
// user-agent parser would add a dependency to choose among five values.
const DESKTOP_PLATFORMS = ["Windows", "macOS", "Linux", "Chrome OS"];

function deviceFamily(identity: BrowserIdentity): UploadDeviceFamily {
  const hints = identity.userAgentData;
  if (hints?.mobile) return "phone";
  if (hints?.platform === "Android") return "tablet";
  if (hints && DESKTOP_PLATFORMS.includes(hints.platform)) return "desktop";
  const ua = identity.userAgent;
  if (/iPhone|iPod/.test(ua)) return "phone";
  // iPadOS Safari presents itself as a Mac; only a touch screen tells them apart.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (identity.maxTouchPoints ?? 0) > 1))
    return "tablet";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "phone" : "tablet";
  if (/Windows|Macintosh|Linux|CrOS/.test(ua)) return "desktop";
  return "other";
}

function browserFamily(identity: BrowserIdentity): UploadBrowserFamily {
  const brands = identity.userAgentData?.brands.map(({ brand }) => brand) ?? [];
  if (brands.includes("Microsoft Edge")) return "edge";
  if (brands.includes("Google Chrome")) return "chrome";
  // A Chromium brand without Chrome's or Edge's is another vendor's browser.
  if (brands.includes("Chromium")) return "other";
  const ua = identity.userAgent;
  if (/Edg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return "safari";
  return "other";
}

/** The origin the series file states: the person's optional words and the coarse families. */
export function uploadOrigin(identity: BrowserIdentity, label: string): UploadOrigin {
  const words = label.trim().slice(0, ORIGIN_LABEL_MAX);
  return {
    ...(words ? { label: words } : {}),
    device_family: deviceFamily(identity),
    browser_family: browserFamily(identity),
  };
}

/**
 * The archive's members: the series file first, then the selection. The series file asks the
 * cell to file the import, names the collection and states the origin. The person's label names
 * a collection only when the selection gives none of its own.
 */
export function importArchive(
  selection: ImportSelection,
  collection: string | null,
  origin: UploadOrigin
): ImportFile[] {
  const name = collection ?? origin.label;
  const series: ImportSeries = {
    ...(name ? { label: name } : {}),
    paths: selection.files.map(({ path }) => path),
    filing: "cell",
    origin,
  };
  const file = new File([JSON.stringify(series)], SERIES_FILE, { type: "application/json" });
  return [{ path: SERIES_FILE, file, reserved: true }, ...selection.files];
}
