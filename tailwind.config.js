/**
 * Tokens du design system NERV recopiés depuis @mdrbx/nerv-ui/tailwind.preset
 * (le fichier publié contient un glob dans son commentaire d'en-tête qui ferme
 * le bloc de commentaire trop tôt et fait planter le parseur — on inline donc).
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
    './node_modules/@mdrbx/nerv-ui/dist/*.{js,mjs}',
  ],
  theme: {
    extend: {
      colors: {
        'nerv-black': '#000000',
        'nerv-red': '#FF0000',
        'nerv-orange': '#FF9900',
        'nerv-green': '#00FF00',
        'nerv-cyan': '#00FFFF',
        'nerv-amber': '#FFAA00',
        'nerv-white': '#E0E0E0',
        'nerv-dark-gray': '#1A1A1A',
        'nerv-mid-gray': '#555555',
        'nerv-panel': '#0A0A0A',
        'nerv-purple': '#9933FF',
        'nerv-magenta': '#FF00FF',
        'nerv-lcd-green': '#39FF14',
        'bg-base': '#000000',
        'alert-red': '#FF0000',
        'text-orange': '#FF9900',
        'grid-green': '#00FF00',
        'data-blue': '#00FFFF',
        'magenta-wave': '#FF00FF',
        'lcd-green': '#39FF14',
      },
      fontFamily: {
        'nerv-display': ['Oswald', 'Impact', 'Arial Narrow', 'system-ui', 'sans-serif'],
        'nerv-mono': ['Fira Code', 'JetBrains Mono', 'Courier New', 'monospace'],
        'nerv-body': ['Barlow Condensed', 'Arial Narrow', 'system-ui', 'sans-serif'],
        'nerv-title': ['Noto Serif JP', 'Playfair Display', 'Georgia', 'Times New Roman', 'serif'],
      },
      keyframes: {
        'nerv-flicker': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.85' },
          '52%': { opacity: '0.4' },
          '54%': { opacity: '0.9' },
          '56%': { opacity: '0.3' },
          '58%': { opacity: '1' },
        },
        'nerv-blink-hard': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        'nerv-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        'nerv-glow': {
          '0%, 100%': {
            textShadow: '0 0 4px currentColor, 0 0 8px currentColor',
            filter: 'brightness(1)',
          },
          '50%': {
            textShadow: '0 0 8px currentColor, 0 0 20px currentColor, 0 0 40px currentColor',
            filter: 'brightness(1.2)',
          },
        },
        'cursor-blink': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        'hazard-scroll': {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '28.28px 0' },
        },
      },
      animation: {
        'nerv-flicker': 'nerv-flicker 3s infinite',
        'nerv-blink-hard': 'nerv-blink-hard 1s steps(1) infinite',
        'nerv-pulse': 'nerv-pulse 2s ease-in-out infinite',
        'nerv-glow': 'nerv-glow 2s ease-in-out infinite',
        'cursor-blink': 'cursor-blink 1s steps(1) infinite',
        'hazard-scroll': 'hazard-scroll 0.5s linear infinite',
      },
    },
  },
};
