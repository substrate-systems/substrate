import type { Config } from "tailwindcss";

/**
 * Substrate Design System v1
 * 
 * Infrastructural, systems-first, restrained, long-horizon.
 * All tokens are intentionally restricted to prevent visual drift.
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    // Override defaults with restricted palette
    colors: {
      transparent: "transparent",
      current: "currentColor",
      
      // Semantic background scale (dark to light)
      bg: {
        base: "#050505",      // Deepest black, page background
        surface: "#0a0a0a",   // Card/section backgrounds
        elevated: "#111111",  // Hover states, elevated surfaces
        subtle: "#171717",    // Subtle differentiation
      },
      
      // Semantic foreground scale (bright to dim)
      fg: {
        primary: "#fafafa",   // Primary text, headings
        secondary: "#a3a3a3", // Body text, descriptions
        tertiary: "#525252",  // Labels, captions, metadata
        muted: "#262626",     // Disabled, decorative
      },
      
      // Border scale
      border: {
        subtle: "rgba(255, 255, 255, 0.06)",
        default: "rgba(255, 255, 255, 0.10)",
        emphasis: "rgba(255, 255, 255, 0.20)",
        strong: "rgba(255, 255, 255, 0.40)",
      },
      
      // Accent (used sparingly)
      accent: {
        glow: "rgba(255, 255, 255, 0.03)",
        highlight: "rgba(255, 255, 255, 0.08)",
      },
    },
    
    // Restricted spacing scale (architectural, 8px base)
    spacing: {
      "0": "0",
      "1": "4px",
      "2": "8px",
      "3": "12px",
      "4": "16px",
      "6": "24px",
      "8": "32px",
      "12": "48px",
      "16": "64px",
      "24": "96px",
      "32": "128px",
      "40": "160px",
    },
    
    // Typography
    fontFamily: {
      sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      mono: ["var(--font-mono)", "ui-monospace", "monospace"],
    },
    
    fontSize: {
      // Display scale
      "display-lg": ["3.5rem", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "300" }],
      "display": ["2.5rem", { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "300" }],
      "display-sm": ["2rem", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "300" }],
      
      // Heading scale
      "heading-lg": ["1.5rem", { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "300" }],
      "heading": ["1.25rem", { lineHeight: "1.4", letterSpacing: "-0.01em", fontWeight: "300" }],
      "heading-sm": ["1.125rem", { lineHeight: "1.4", letterSpacing: "0", fontWeight: "300" }],
      
      // Body scale
      "body-lg": ["1.125rem", { lineHeight: "1.6", letterSpacing: "0", fontWeight: "300" }],
      "body": ["1rem", { lineHeight: "1.6", letterSpacing: "0", fontWeight: "300" }],
      "body-sm": ["0.875rem", { lineHeight: "1.5", letterSpacing: "0", fontWeight: "300" }],
      
      // Label scale (uppercase)
      "label": ["0.75rem", { lineHeight: "1.4", letterSpacing: "0.2em", fontWeight: "400" }],
      "label-sm": ["0.625rem", { lineHeight: "1.4", letterSpacing: "0.2em", fontWeight: "400" }],
    },
    
    fontWeight: {
      light: "300",
      normal: "400",
      medium: "500",
    },
    
    letterSpacing: {
      tighter: "-0.02em",
      tight: "-0.01em",
      normal: "0",
      wide: "0.1em",
      wider: "0.2em",
    },
    
    // Motion system
    transitionDuration: {
      "micro": "150ms",
      "default": "300ms",
      "emphasis": "600ms",
      "entrance": "900ms",
      "slow": "1200ms",
    },
    
    transitionTimingFunction: {
      "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
      "out": "cubic-bezier(0.33, 1, 0.68, 1)",
      "in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
    },
    
    // Border radius (minimal)
    borderRadius: {
      none: "0",
      sm: "2px",
      DEFAULT: "4px",
      full: "9999px",
    },
    
    // Opacity scale (restricted)
    opacity: {
      "0": "0",
      "2": "0.02",
      "4": "0.04",
      "6": "0.06",
      "10": "0.10",
      "15": "0.15",
      "20": "0.20",
      "40": "0.40",
      "60": "0.60",
      "80": "0.80",
      "100": "1",
    },
    
    // Blur scale (for materials)
    blur: {
      none: "0",
      sm: "4px",
      DEFAULT: "8px",
      lg: "16px",
      xl: "24px",
      "2xl": "40px",
      "3xl": "64px",
    },
    
    extend: {
      // Material backgrounds
      backgroundImage: {
        "material-curve": "url('/brand/materials/metal-curve-dark.jpg')",
        "material-lattice": "url('/brand/materials/metal-lattice-dark.jpg')",
        "material-structure": "url('/brand/materials/metal-structure-dark.jpg')",
        
        // Gradient overlays for masking materials
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-fade-b": "linear-gradient(to bottom, transparent, var(--tw-gradient-to))",
        "gradient-fade-t": "linear-gradient(to top, transparent, var(--tw-gradient-to))",
        "gradient-vignette": "radial-gradient(ellipse at center, transparent 0%, var(--tw-gradient-to) 70%)",
      },
      
      // Max-width for content
      maxWidth: {
        "content": "48rem",   // 768px - primary content width
        "content-lg": "64rem", // 1024px - wider content
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
