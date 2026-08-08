/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    // Tailwind v4 ships its own vendor prefixing (Lightning CSS), so autoprefixer is gone.
    "@tailwindcss/postcss": {},
  },
};

export default config;
