# Mappa T2000 in Tour Catania 2026

Mappa interattiva 3D per mostrare gli espositori della Fiera T2000 di Catania 2026 usando [Mappedin JS v6](https://www.npmjs.com/package/@mappedin/mappedin-js).

## Features Implementate

- **Mappa interattiva 3D** con pan, zoom, rotate
- **Profili espositori** con logo, descrizione, foto, link, sito, telefono, social
- **Ricerca** per espositori, servizi, merceologie (fuzzy matching + alias)
- **Navigazione wayfinding** tra punti (partenza/destinazione)
- **Mobile responsive** - bottom sheet collapsibile, popup floating
- **Performance optimized** - vendor code-splitting, font preload, DNS prefetch, lazy-loading
- **Analytics** GA4 integrato
- **Auto-deploy** via Netlify da GitHub

## Prerequisiti

- [Node.js](https://nodejs.org/) v18+
- npm o yarn

## Setup

```bash
git clone https://github.com/apiedipubblicita/pianta-digitale-catania.git
cd pianta-digitale-catania
npm install
npm run dev
```

Apri `http://localhost:5173`

## Build & Deploy

```bash
npm run build
```

Netlify auto-deploy on push to main branch.

## Project Structure

```
src/
├── main.ts          # Map init, location panel, search, routing logic
├── theme.ts         # Mappedin SDK theme (colori, font, UI config)
index.html           # HTML entry + GA4 + performance tags
vite.config.ts       # Build config con @mappedin vendor splitting
```

## Dati

**Location profile** da Mappedin SDK:
- `description` - descrizione espositore
- `logoImage.url` - logo circolare sulla mappa
- `images[]` - foto carousel
- `website`, `phone` - contatti
- `links[]` - sito, social (Instagram, Facebook, LinkedIn, X, YouTube, TikTok, email)

**Stand numbers** - mapping statico STAND_NUMBERS per normalizz. nomi espositori

## Mobile Optimizations

**UI & Layout**
- Responsive bottom sheet 12px margins, safe-area-inset, collapsibile max-height (55vh closed, 80vh open)
- Logo repositioned 26px height, z-index managed vs. panel (z-index 10000)
- viewport-fit=cover per notch support su iPhone

**Performance**
- Font preload - Onest wght 300-700 preload per ridurre FOUT
- DNS prefetch + preconnect - app.mappedin.com, tiles.mappedin.com, styles.mappedin.com
- Lazy images - Photo carousel on-demand caricamento, decoding="async" per non bloccare main thread
- Debug logging disabled in production - riduce bundle size
- Vendor code-splitting - @mappedin SDK separato, caricato solo se necessario

**PWA Support**
- theme-color meta tag - barra browser colorata su Android
- apple-mobile-web-app-capable - installabile come web app su iOS
- apple-mobile-web-app-status-bar-style - black-translucent status bar
- apple-touch-icon - icon custom quando aggiunto a home screen

**Spinner**
- Loading animation nascosta dopo map init

## Performance Metrics (Mobile)

- Map API load: ~600-900ms (Mappedin SDK, unavoidable)
- Main bundle: 58ms
- Mappedin vendor bundle: 157ms
- Preconnect: riduce DNS handshake ~100-200ms
- Font preload: evita layout shift

## Scripts

| Command | Descrizione |
|---------|-------------|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview build locale |

## Limiti & Prossimi Step

**Bottlenecks non ottimizzabili**
- Mappedin API cold load ~600ms su mobile (SDK fa 2 richieste, seconda cached ~295ms)
- Mappedin vendor bundle 996KB gzipped (core della mappa 3D, unavoidable)
- Roboto font 102KB gzipped (incluso dal SDK, non controllabile)

**Future improvements**
- Service Worker - offline caching, aggressive asset caching, background sync
- Progressive rendering - mostrare mappa raster (JPG) mentre carica SDK 3D
- Image optimization - CDN image resizing, WebP con fallback PNG
- Lazy-load routing/search - split in chunk separato, caricato on-demand
- Tile preloading - prefetch tiles adiacenti while user pan
- Bandwidth detection - serve lower quality tiles on slow connections (navigator.connection API)

## Deployment

Netlify auto-deploy:
1. Push to GitHub main
2. Netlify CI/CD runs `npm run build`
3. Deploy live in ~2-5 min

## Resources

- [Mappedin Docs](https://developer.mappedin.com/web-sdk/getting-started)
- [Mappedin API Ref](https://docs.mappedin.com/web/v6/latest/)
- [Vite Docs](https://vitejs.dev/)
