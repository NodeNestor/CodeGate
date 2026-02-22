import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/client/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f5ff",
          100: "#e0ebff",
          200: "#b8d4fe",
          300: "#85b8fd",
          400: "#4a94fa",
          500: "#1a6ef5",
          600: "#0b52d4",
          700: "#0a41ab",
          800: "#0d378c",
          900: "#113074",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
