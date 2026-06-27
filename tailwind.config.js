/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./docs.html', './index.html', './js/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      maxWidth: {
        '8xl': '90rem',
      },
    },
  },
  plugins: [],
};
