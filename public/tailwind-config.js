// Tailwind CDN configuration (must load AFTER the Tailwind CDN script)
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
      },
      colors: {
        court: {
          50: "#ecfdf5",
          100: "#d1fae5",
          200: "#a7f3d0",
          300: "#6ee7b7",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
          800: "#065f46",
          900: "#064e3b",
          950: "#022c22",
        },
        optic: {
          300: "#bef264",
          400: "#a3e635",
          500: "#84cc16",
        },
      },
    },
  },
};
