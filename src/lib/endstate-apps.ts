// Dynamic list of apps Endstate can back up settings for. Sourced live from the
// engine repo's `modules/apps/` directory so it stays current as modules are added,
// with a notable-apps fallback if GitHub is unreachable at build/revalidate time.

const REPO = "Artexis10/endstate";
const APPS_PATH = "modules/apps";

// Slugs that don't title-case cleanly. Everything else is derived from the slug.
const DISPLAY_OVERRIDES: Record<string, string> = {
  vscode: "VS Code",
  vscodium: "VSCodium",
  "obs-studio": "OBS Studio",
  "davinci-resolve": "DaVinci Resolve",
  foobar2000: "foobar2000",
  mpv: "mpv",
  "mpc-be": "MPC-BE",
  "mpc-hc": "MPC-HC",
  "7zip": "7-Zip",
  aida64: "AIDA64",
  "gpu-z": "GPU-Z",
  "core-temp": "Core Temp",
  "yt-dlp": "yt-dlp",
  "oh-my-posh": "Oh My Posh",
  k9s: "K9s",
  btop: "btop",
  eza: "eza",
  bat: "bat",
  npm: "npm",
  pip: "pip",
  pnpm: "pnpm",
  "wps-office": "WPS Office",
  "xnviewmp": "XnView MP",
  "fl-studio": "FL Studio",
  ssms: "SQL Server Management Studio",
  "3ds-max": "3ds Max",
  kicad: "KiCad",
  freecad: "FreeCAD",
  openscad: "OpenSCAD",
  "git-bash": "Git Bash",
  "github-cli": "GitHub CLI",
  "aws-cli": "AWS CLI",
  "bash-profile": "Bash profile",
  "powershell-profile": "PowerShell profile",
  "ssh-config": "SSH config",
  "wsl-config": "WSL config",
  kubeconfig: "kubeconfig",
  wsl: "WSL",
  "paint-net": "Paint.NET",
  "notepad-plus-plus": "Notepad++",
  translucenttb: "TranslucentTB",
  copyq: "CopyQ",
  "em-client": "eM Client",
};

// Notable fallback if the GitHub listing can't be fetched (build with no network).
// The live list is normally 300+; this keeps the page useful in the rare failure case.
const FALLBACK_SLUGS = [
  "vscode", "neovim", "git", "windows-terminal", "powertoys", "sublime-text",
  "obsidian", "logseq", "blender", "davinci-resolve", "ableton-live", "fl-studio",
  "obs-studio", "gimp", "krita", "inkscape", "audacity", "reaper", "discord",
  "spotify", "vlc", "mpv", "foobar2000", "musicbee", "steam-less", "retroarch",
  "dolphin-emulator", "pcsx2", "qbittorrent", "keepassxc", "cryptomator",
  "docker-desktop", "wireshark", "putty", "winscp", "sharex", "rainmeter",
  "intellij-idea", "pycharm", "webstorm", "dbeaver",
];

function toDisplayName(slug: string): string {
  if (DISPLAY_OVERRIDES[slug]) return DISPLAY_OVERRIDES[slug];
  return slug
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export type SupportedApp = { slug: string; name: string };

function toApps(slugs: string[]): SupportedApp[] {
  return slugs
    .map((slug) => ({ slug, name: toDisplayName(slug) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export async function getSupportedApps(): Promise<SupportedApp[]> {
  try {
    const token = process.env.GITHUB_TOKEN;
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${APPS_PATH}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "substratesystems.io",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        next: { revalidate: 86400 },
      },
    );
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const entries = (await res.json()) as { name: string; type: string }[];
    const slugs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    if (slugs.length === 0) throw new Error("empty listing");
    return toApps(slugs);
  } catch {
    return toApps(FALLBACK_SLUGS);
  }
}
