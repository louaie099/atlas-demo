import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: "#F3F5F8",
        card: "#FFFFFF",
        border: "#DDE3EA",
        ink: "#14202B",
        muted: "#566574",
        // Sidebar chrome (Command Center redesign, 2026-10-21).
        navy: { 900: "#0E1A2B", 800: "#1D2D45", 700: "#243650", 600: "#33496A", text: "#B8C4D3", dim: "#9FB0C4" },
        brand: {
          50: "#EEF3FD",
          100: "#DCE8FB",
          200: "#9DB9EA",
          500: "#4A80E0",
          600: "#1F5FD1",
          700: "#12428F",
        },
        good: { 50: "#E3F4EC", 500: "#0F7B53", 700: "#0B5A3C" },
        warn: { 50: "#FFF1D6", 200: "#E8C27A", 500: "#C26A00", 700: "#7A4200" },
        bad: { 50: "#FDE7E5", 500: "#D13B30", 700: "#9B1C14" },
      },
      borderRadius: {
        xl2: "0.875rem",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
        softer: "0 4px 12px rgba(16,24,40,0.07)",
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
