/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0a0a0f',
          card: '#12121a',
          elevated: '#1a1a26',
        },
        accent: {
          green: '#00ff88',
          greenDim: 'rgba(0,255,136,0.15)',
          red: '#ff4444',
          redDim: 'rgba(255,68,68,0.15)',
          yellow: '#ffcc00',
          blue: '#4488ff',
        },
        border: {
          subtle: 'rgba(255,255,255,0.06)',
          DEFAULT: 'rgba(255,255,255,0.1)',
        },
        text: {
          primary: '#e8e8f0',
          secondary: '#8888aa',
          muted: '#555577',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        display: ['Syne', 'sans-serif'],
      },
      animation: {
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
        'tick-up': 'tickUp 300ms ease-out forwards',
        'tick-down': 'tickDown 300ms ease-out forwards',
        shimmer: 'shimmer 1.5s infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.4', transform: 'scale(0.8)' },
        },
        tickUp: {
          '0%': { backgroundColor: 'rgba(0,255,136,0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
        tickDown: {
          '0%': { backgroundColor: 'rgba(255,68,68,0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
