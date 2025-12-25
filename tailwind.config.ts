import type { Config } from "tailwindcss";

/**
 * Substrate Design System v1
 * 
 * Extends Tailwind defaults with custom semantic tokens.
 * Standard Tailwind classes remain available for flexibility.
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Custom semantic colors (extend, don't replace)
      colors: {
        bg: {
          base: "#050505",
          surface: "#0a0a0a",
          elevated: "#111111",
          subtle: "#171717",
        },
        fg: {
          primary: "#fafafa",
          secondary: "#a3a3a3",
          tertiary: "#525252",
          muted: "#262626",
        },
        border: {
          subtle: "rgba(255, 255, 255, 0.06)",
          default: "rgba(255, 255, 255, 0.10)",
          emphasis: "rgba(255, 255, 255, 0.20)",
          strong: "rgba(255, 255, 255, 0.40)",
        },
        accent: {
          glow: "rgba(255, 255, 255, 0.03)",
          highlight: "rgba(255, 255, 255, 0.08)",
        },
      },
      
      // Custom typography tokens
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      
      fontSize: {
        "display-lg": ["3.5rem", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "300" }],
        "display": ["2.5rem", { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "300" }],
        "display-sm": ["2rem", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "300" }],
        "heading-lg": ["1.5rem", { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "300" }],
        "heading": ["1.25rem", { lineHeight: "1.4", letterSpacing: "-0.01em", fontWeight: "300" }],
        "heading-sm": ["1.125rem", { lineHeight: "1.4", letterSpacing: "0", fontWeight: "300" }],
        "body-lg": ["1.125rem", { lineHeight: "1.6", letterSpacing: "0", fontWeight: "300" }],
        "body": ["1rem", { lineHeight: "1.6", letterSpacing: "0", fontWeight: "300" }],
        "body-sm": ["0.875rem", { lineHeight: "1.5", letterSpacing: "0", fontWeight: "300" }],
        "label": ["0.75rem", { lineHeight: "1.4", letterSpacing: "0.2em", fontWeight: "400" }],
        "label-sm": ["0.625rem", { lineHeight: "1.4", letterSpacing: "0.2em", fontWeight: "400" }],
      },
      
      // Custom motion tokens
      transitionDuration: {
        "micro": "150ms",
        "emphasis": "600ms",
        "entrance": "900ms",
        "slow": "1200ms",
      },
      
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
        "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
        "out": "cubic-bezier(0.33, 1, 0.68, 1)",
      },
      
      // Material backgrounds and noise
      backgroundImage: {
        "material-curve": "url('/brand/materials/metal-curve-dark.jpg')",
        "material-lattice": "url('/brand/materials/metal-lattice-dark.jpg')",
        "material-structure": "url('/brand/materials/metal-structure-dark.jpg')",
        "noise": "url('/brand/materials/noise.svg')",
      },
      
      // Content widths
      maxWidth: {
        "shell": "72rem",
        "shell-sm": "48rem",
      },
      
      // Z-index scale
      zIndex: {
        "base": "0",
        "elevated": "10",
        "overlay": "20",
        "modal": "30",
        "toast": "40",
      },
    },
  },
  plugins: [],
};

export default config;
