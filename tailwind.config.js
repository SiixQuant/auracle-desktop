/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Preflight (Tailwind's global reset) is OFF on purpose: the launcher
  // already ships a hand-built design system in src/styles/app.css, and
  // Tailwind's base reset would clobber it. We only want the utility
  // classes for the sign-in screen, not a competing reset.
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
