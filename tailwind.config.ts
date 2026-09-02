import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: "#F7F8FA",
        card: "#FFFFFF",
        border: "#E6E8EC",
        ink: "#1F2430",
        muted: "#6B7280",
        brand: {
          50: "#EFF6FF",
          100: "#DBEAFE",
          500: "#3B82F6",
          600: "#2563EB",
          700: "#1D4ED8",
        },
        good: { 50: "#ECFDF5", 500: "#10B981", 700: "#047857" },
        warn: { 50: "#FFFBEB", 500: "#F59E0B", 700: "#B45309" },
        bad: { 50: "#FEF2F2", 500: "#EF4444", 700: "#B91C1C" },
      },
      borderRadius: {
        xl2: "1.25rem",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
        softer: "0 4px 12px rgba(16,24,40,0.06)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
