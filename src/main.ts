import { getMapData, show3dMap } from "@mappedin/mappedin-js";
import theme from "./theme";

// Debug logging disabled in production
const isDev = import.meta.env.DEV;
const debug = isDev ? console.log : () => {};

// ============ Supabase Analytics (lightweight) ============
const SB_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const CITY = import.meta.env.VITE_CITY as string;
const SB_HEADERS = { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Prefer': 'return=minimal' };

const SESSION_ID = sessionStorage.getItem('sid') ?? (() => {
  const id = crypto.randomUUID();
  sessionStorage.setItem('sid', id);
  return id;
})();

// Visitatore persistente fra le sessioni (localStorage) -> "Visitatore 1, 2, …" nel report.
const VISITOR_ID = localStorage.getItem('vid') ?? (() => {
  const id = crypto.randomUUID();
  try { localStorage.setItem('vid', id); } catch { /* navigazione privata: resta per-sessione */ }
  return id;
})();

// events.session_id ha FK su sessions: ogni evento parte solo DOPO l'insert della sessione,
// altrimenti 409 e l'evento si perde (a Roma: 437 sessioni, solo 274 map_loaded).
let sessionReady: Promise<unknown> = Promise.resolve();

function trackEvent(name: string, props?: Record<string, unknown>): void {
  sessionReady.then(() => fetch(`${SB_URL}/rest/v1/events`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ session_id: SESSION_ID, city: CITY, event: name, payload: props ?? null }),
    keepalive: true,
  })).catch(() => {});
}

// Un solo deeplink_opened per sessione (loc può arrivare sia da ?loc= sia da postMessage)
let deeplinkTracked = false;
function trackDeeplink(loc: string): void {
  if (deeplinkTracked || !loc) return;
  deeplinkTracked = true;
  trackEvent('deeplink_opened', { loc });
}

function initSession(): void {
  const w = window.innerWidth;
  const ua = navigator.userAgent;
  // UTM inoltrati dal sito padre nell'URL dell'iframe (?utm_source=...&utm_medium=...&utm_campaign=...)
  const qp = new URLSearchParams(window.location.search);
  sessionReady = fetch(`${SB_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      session_id: SESSION_ID,
      visitor_id: VISITOR_ID,
      city: CITY,
      device_type: w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop',
      browser: /Chrome/.test(ua) ? 'chrome' : /Safari/.test(ua) ? 'safari' : /Firefox/.test(ua) ? 'firefox' : 'other',
      referrer: document.referrer || null,
      screen_w: window.screen.width,
      utm_source: qp.get('utm_source'),
      utm_medium: qp.get('utm_medium'),
      utm_campaign: qp.get('utm_campaign'),
      utm_content: qp.get('utm_content'),
    }),
    keepalive: true,
  }).catch(() => {});

  // Chiusura sessione affidabile: 'visibilitychange'->hidden e 'pagehide' partono
  // anche su mobile e dentro iframe, dove 'beforeunload' spesso non parte.
  // La PATCH è idempotente: l'ultima prima della chiusura vince (ended_at + duration_s).
  const endSession = () => {
    fetch(`${SB_URL}/rest/v1/sessions?session_id=eq.${SESSION_ID}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ ended_at: new Date().toISOString(), duration_s: Math.round((Date.now() - performance.timeOrigin) / 1000) }),
      keepalive: true,
    }).catch(() => {});
  };
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') endSession(); });
  addEventListener('pagehide', endSession);
}
// ===========================================================

const options = {
  key: "mik_ToUYegRDG72JiGZaA52e4071a",
  secret: import.meta.env.VITE_MAPPEDIN_SECRET as string,
  mapId: "6abe5bd76ba06d000b00e30c",
};

// State
let mapViewRef: any = null;
let mapDataRef: any = null;
let selectedSpace: any = null;
let selectedNonSpaceItem: any = null; // { name, coordinate } per annotations/doors
let directionFrom: any = null;
let directionTo: any = null;
let fromCoord: any = null;
let toCoord: any = null;
let allSpaces: any[] = [];
let allDoors: any[] = [];
let allAnnotations: any[] = [];
let allAreas: any[] = [];
let allConnections: any[] = [];
let allSearchableItems: any[] = []; // unisce spaces + annotations + doors per la ricerca
let entranceList: any[] = [];
let droppedPinMarker: any = null;
let directionsActive = false;
// Vista per zoom: detail = stand/servizi/POI/safety (visibili da vicino),
// far = blocco padiglione + topper logo + frecce ingressi (visibili da lontano)
let detailMarkers: any[] = [];
let farMarkers: any[] = [];
let blockDefs: { fc: any; opts: any }[] = [];
let blockShapes: any[] = [];
let blocksAdded = false;
let lastFar: boolean | null = null;
let refreshZoomView: () => void = () => {};
let tagMap: Record<string, any[]> = {};
let highlightedSpaces: any[] = [];
let highlightAnimInterval: any = null;
let searchMode: 'merceologie' | 'espositori' | 'servizi' = 'espositori';
let spaceExternalIdMap: Record<string, string> = {}; // spaceId → externalId
let spaceSlugMap: Record<string, any> = {};           // slug/externalId → space
let spaceProfileMap: Record<string, any> = {};        // spaceId → location-profile (description, logo, photos, links, ...)
let currentPhotoIndex = 0;
let currentPhotoList: string[] = [];

// Step-by-step navigation state
let navSteps: { action: string; text: string; coordinate: any; distance: number }[] = [];
let navCurrentStep = 0;
let navStepMarker: any = null; // marker "Sei qui" sulla mappa

// Marker partenza/arrivo per direzioni (senza percorso)
let directionStartMarker: any = null;
let directionEndMarker: any = null;

// Numeri stand espositori (chiave = nome uppercase normalizzato)
const STAND_NUMBERS: Record<string, number> = {
  "A-TONO": 29,
  "ADM": 55,
  "ADMIRAL PAY": 63,
  "AM AUTOMATIC MACHINES": 27,
  "ASSO - UMA.MI": 52,
  "BETPOINT": 37,
  "BIC ITALIA": 2,
  "BORDÈRA": 16,
  "BR.E.MA. - LEM": 34,
  "BRIGHTSTAR": 65,
  "C.R. COMMERCIAL - RELX": 28,
  "CROMA DESIGN": 20,
  "DEDRARREDO": 62,
  "DEL DUCA PRINT": 67,
  "DOLCE MANIA STORE - LA MORALIZIA": 75,
  "ECOMAP - ECOM.BROKER": 44,
  "ENTOURAGE - YOOZ": 8,
  "ETNA TOBACCO INTERNATIONAL": 76,
  "EVEREX": 39,
  "FASTER - LAVAVERDE": 21,
  "FIT - FEDERAZIONE ITALIANA TABACCAI": 54,
  "FREEDOM INTERNATIONAL": 3,
  "GI.LU.PI. - BETITALY": 19,
  "GIEMME": 71,
  "GRASSI INFORMATICA": 31,
  "GROOVY - SKE": 46,
  "I.D.E.A.": 69,
  "I.F.I.": 51,
  "ITAGENCY - DINNER LADY": 25,
  "KICKKICK - SVAPO&BASTA": 33,
  "KING - SMO-KING": 24,
  "LA VOCE DEL TABACCAIO": 64,
  "LASERVIDEO": 50,
  "LCK TEAM SPAGNA SL - BETWIN360": 22,
  "LOGISTA": 53,
  "LOSTECH GROUP": 18,
  "LOTTOMATICA": 4,
  "M&C DISTRIBUZIONE - AEREA": 15,
  "M.G. INFORMATICA": 11,
  "MELISSA EDIZIONI": 30,
  "MOONEY": 6,
  "NETWIN ITALIA": 57,
  "NUOVE FORME": 73,
  "PERFETTI VAN MELLE": 1,
  "PHILIP MORRIS ITALIA": 38,
  "POSTE ITALIANE": 23,
  "PREXISO - NEVORIA LAB": 74,
  "PUBLISTILE": 70,
  "REPLATZ - FASTBET": 45,
  "S.D.S.P. DI FOLCOLINI CRISTIANO": 56,
  "SERVIZI IN RETE 2001": 58,
  "SET - ELFBAR": 13,
  "SET - TUBINO": 14,
  "SHENZHEN SKE TECHNOLOGY": 72,
  "SID PARMA": 61,
  "SIGEL - SUPREM-E - LIK BAR": 32,
  "SISAL": 60,
  "SMOOKE FRANCE - MONSTER SVAPO": 5,
  "T HUB": 47,
  "T PER SEMPRE": 48,
  "TABACCHI GLOBAL SERVICE - GENIUS": 17,
  "TABAUNO": 59,
  "UBIFY": 66,
  "VANITÀ GIOIELLI": 68,
  "VAPORART": 12,
  "VAPOUR INTERNATIONAL - KIWI": 9,
  "VENUS - AIR BAR": 10,
  "VINCITU": 7,
  "VISION - VAPEITALIA - AVOMI": 40,
  "VITTORIA CONSULENZE - BETPASSION": 43,
  "VOILÀ": 26,
  "WINGAMING - STARYES": 42,
  "WURSI - WESTERN UNION": 49,
  "VDT": 64,
  // Nomi come sono su Mappedin (diversi dal CSV) + doppi stand con il proprio numero
  "VDT - LA VOCE DEL TABACCAIO": 64,
  "S.D.S.P.": 56,
  "VAPOUR - INTERNATIONAL KIWI": 9,
  "BR.E.MA. - LEM (A)": 34,
  "BR.E.MA. - LEM (B)": 35,
  "ITAGENCY": 36,
  "VISION - VAPEITALIA": 40,
  "VISION - AVOMI": 41,
};

// Nessun marchio per questa tappa (merceologie gestite come Search tags su Mappedin)
const BRAND_MAP: Record<string, string> = {};

function getStandNumber(name: string): number | undefined {
  const key = name.toUpperCase().trim().replace(/\s+/g, ' ');
  if (STAND_NUMBERS[key] !== undefined) return STAND_NUMBERS[key];
  // Ricerca parziale tollerante (ignora differenze di spaziatura interna)
  for (const [k, v] of Object.entries(STAND_NUMBERS)) {
    if (k.replace(/\s+/g, '') === key.replace(/\s+/g, '')) return v;
  }
  return undefined;
}

// Servizi rilevati automaticamente per parola chiave nel nome (case-insensitive).
// Tutto ciò che contiene una di queste parole è un servizio, non un espositore.
const SERVICE_KEYWORDS = [
  "toilet", "toilette", "bagno", "wc", "bar", "area", "ingresso", "uscita",
  "reception", "baby parking", "sala convegni", "registrazione", "premiazione",
  "saletta", "infopoint", "info point", "guardaroba", "self service",
];

function isServiceLocation(name: string): boolean {
  // Gli espositori sono SOLO quelli del CSV (STAND_NUMBERS): se ha un numero stand è un espositore,
  // MAI un servizio — così "SET - ELFBAR", "VENUS - AIR BAR", "...LIK BAR" (contengono "bar" ma
  // sono nel CSV) NON vengono scambiati per servizi.
  if (getStandNumber(name) !== undefined) return false;
  const lower = name.toLowerCase();
  return SERVICE_KEYWORDS.some(k => lower.includes(k));
}

// Punti di navigazione speciali (ingressi/uscite padiglione e fiera): marker cliccabili.
// Ingresso/uscita padiglione SOLO se il nome INIZIA con "ingresso pad"/"uscita pad"
// (così "TOILET INGRESSO PAD.4" NON è un ingresso).
function isSpecialNav(name: string): boolean {
  const l = name.toLowerCase().trim();
  return (l.includes("fiera") && (l.includes("ingresso") || l.includes("uscita") || l.includes("porta")))
    || l.startsWith("ingresso pad")
    || l.startsWith("uscita pad");
}

// Interpolazione lineare tra due colori hex (per animazione fluida)
function lerpHex(hex1: string, hex2: string, t: number): string {
  const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t).toString(16).padStart(2, '0');
  const g = Math.round(g1 + (g2 - g1) * t).toString(16).padStart(2, '0');
  const b = Math.round(b1 + (b2 - b1) * t).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

// Alias di ricerca: parole chiave alternative per alcune location
const SEARCH_ALIASES: Record<string, string[]> = {
  "toilet": ["toilette", "bagno", "wc", "gabinetto"],
  "baby parking": ["area", "area kids", "area bimbi", "bimbi", "bambini", "kids", "giochi", "parco giochi", "baby"],
  "area kids": ["area bimbi", "bambini", "bimbi", "giochi", "parco giochi"],
  "vdt": ["la voce del tabaccaio", "tabaccaio", "voce", "lvt"],
  "adm": ["agenzia delle dogane e dei monopoli", "agenzia", "dogane", "monopoli"],
  "fit": ["federazione", "federazione italiana tabaccai", "tabaccai", "italiana", "f.i.t."],
  "tabacchi global service": ["tgs"],
  "wursi": ["money transfer", "money"],
};

// Ricerca fuzzy: ignora punti, trattini, spazi (es. "brema" trova "BR.E.MA. - LEM")
// + supporto alias (es. "bagno" trova "Toilet pad. C1")
function matchesQuery(name: string, query: string): boolean {
  if (!query) return true;
  const nameLower = name.toLowerCase();
  if (nameLower.includes(query)) return true;
  // Fuzzy: ignora punteggiatura
  const nameNorm = nameLower.replace(/[.\s\-]+/g, '');
  const queryNorm = query.replace(/[.\s\-]+/g, '');
  if (queryNorm.length > 0 && nameNorm.includes(queryNorm)) return true;
  // Alias check
  for (const [key, aliases] of Object.entries(SEARCH_ALIASES)) {
    if (nameLower.includes(key)) {
      if (aliases.some(a => a.toLowerCase().includes(query))) return true;
    }
  }
  // Marchi → espositore: una query su un marchio matcha l'espositore relativo
  for (const [brand, exhibitor] of Object.entries(BRAND_MAP)) {
    if (exhibitor.toLowerCase() === nameLower && brand.includes(query)) return true;
  }
  return false;
}

function slugify(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function spaceUrlKey(space: any): string {
  return spaceExternalIdMap[space.id] || slugify(space.name);
}

// Pin cursor SVG encoded as data URI (omino/pin)
const PIN_CURSOR_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='42' viewBox='0 0 32 42'%3E%3Cpath d='M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z' fill='%23881814'/%3E%3Ccircle cx='16' cy='14' r='6' fill='white'/%3E%3C/svg%3E") 16 42, crosshair`;

async function init() {
  createUI();

  // Sessione subito (prima del caricamento): così timeout/errori/abbandoni hanno una sessione a cui agganciarsi
  initSession();
  // Watchdog: distingue le sessioni "vuote" per caricamento lento / errore / abbandono
  const loadWatchdog = setTimeout(() => trackEvent('map_load_timeout', { waited_ms: 8000 }), 8000);
  let mapData: any, mapView: any;
  try {
    mapData = await getMapData(options);
    mapView = await show3dMap(
      document.getElementById("mappedin-map") as HTMLDivElement,
      mapData,
      { theme } as any
    );
    clearTimeout(loadWatchdog);
  } catch (err) {
    clearTimeout(loadWatchdog);
    trackEvent('map_load_failed', { error: String((err as Error)?.message ?? err) });
    throw err;
  }
  mapDataRef = mapData;
  mapViewRef = mapView;

  // Nascondi subito il loader: la mappa è già renderizzata. I marker arrivano
  // un frame dopo (yield al browser) così il primo paint non resta bloccato.
  const loader = document.getElementById("map-loader");
  if (loader) {
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 500);
  }
  await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  trackEvent('map_loaded', { load_time_ms: Math.round(performance.now()) });
  const initialLoc = new URLSearchParams(window.location.search).get('loc');
  if (initialLoc) trackDeeplink(initialLoc);

  // Raccogli tutti gli spazi (una sola chiamata getByType, riusata sotto)
  const rawSpaces = mapData.getByType("space");
  allSpaces = rawSpaces.filter((s: any) => s.name);

  // Raccogli tutte le porte (doors) per trovare l'ingresso principale
  try {
    allDoors = mapData.getByType("door") || [];
  } catch {
    allDoors = [];
  }

  // Raccogli connections (stairway/elevator/escalator/ramp) con nome — usabili come servizi navigabili
  try {
    allConnections = (mapData.getByType("connection") || []).filter((c: any) => c.name);
  } catch {
    allConnections = [];
  }

  // Annotations (icone sicurezza, vie di fuga, ingresso principale)
  try {
    allAnnotations = mapData.getByType("annotation") || [];

    // Raccogli TUTTI gli ingressi padiglione (annotation/space/door) come punti di partenza
    entranceList = [];
    const _entSeen = new Set<string>();
    const _pushEnt = (name: string, coordinate: any, ref: any) => {
      if (!name || !name.toLowerCase().trim().startsWith("ingresso pad")) return;
      const key = name.toUpperCase().replace(/\s+/g, "");
      if (_entSeen.has(key)) return;
      _entSeen.add(key);
      entranceList.push({ name, coordinate: coordinate || null, ref: ref || null });
    };
    allAnnotations.forEach((a: any) => _pushEnt(a.name, a.coordinate, null));
    allSpaces.forEach((s: any) => _pushEnt(s.name, null, s));
    allDoors.forEach((d: any) => _pushEnt(d.name, null, d));

    // Popola i bottoni "Da:" (un ingresso per bottone), etichette in MAIUSCOLO
    const _entCont = document.getElementById("from-entrance-list");
    if (_entCont) {
      _entCont.innerHTML = entranceList.map((e, i) =>
        `<button class="from-option" data-type="entrance" data-entrance-idx="${i}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          ${e.name.toUpperCase()}
        </button>`
      ).join("");
    }

    // UN marker "INGRESSO" + freccia (vista lontana). Torino: padiglione unico → ancorato
    // all'annotation "INGRESSO PAD. 3" su Mappedin (fallback: coordinata misurata 2026-10-05).
    {
      const gapCoord = entranceList[0]?.coordinate || mapView.createCoordinate(45.029809, 7.663329);
      const ingressoHtml = `<div onclick="event.stopPropagation();window.handleEntranceArrowClick(0)" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;pointer-events:auto;">
        <svg viewBox="0 0 24 24" width="38" height="38" fill="#881814" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45));"><path d="M12 2 L22 21 L12 16.5 L2 21 Z"/></svg>
        <div style="background:#881814;color:#fff;padding:5px 18px;border-radius:7px;font-size:15px;font-weight:800;font-family:'Onest',sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.35);text-transform:uppercase;letter-spacing:1.2px;margin-top:-2px;">Ingresso</div>
      </div>`;
      farMarkers.push(mapView.Markers.add(gapCoord, ingressoHtml, { rank: "always-visible" }));
    }

    // Piazza le icone delle annotations sulla mappa
    allAnnotations.forEach((annotation: any) => {
      if (!annotation.coordinate) return;
      const name = annotation.name || '';
      const nameLower = name.toLowerCase();

      // POI speciali cliccabili: ingresso/uscita fiera + ingresso padiglione
      const isSpecialPoi = isSpecialNav(name);

      if (isSpecialPoi) {
        const isUscita = nameLower.includes('uscita');
        const bgColor = '#005461';
        const svgIcon = isUscita
          ? `<svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`
          : `<svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
        const label = name.length > 18 ? name.substring(0, 18) + '…' : name;
        const markerHtml = `
          <div onclick="event.stopPropagation(); window.handlePoiMarkerClick('${annotation.id}')"
            style="cursor:pointer;display:flex;flex-direction:column;align-items:center;pointer-events:auto;">
            <div style="background:${bgColor};border-radius:50%;width:15px;height:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.3);border:1px solid white;">
              ${svgIcon}
            </div>
            <div style="background:${bgColor};color:white;padding:1px 4px;border-radius:2px;font-size:7px;font-weight:700;font-family:'Onest',sans-serif;white-space:nowrap;margin-top:1px;box-shadow:0 1px 3px rgba(0,0,0,0.2);text-transform:uppercase;letter-spacing:0.3px;max-width:70px;overflow:hidden;text-overflow:ellipsis;">${label}</div>
            <div style="width:0;height:0;border-left:2px solid transparent;border-right:2px solid transparent;border-top:2px solid ${bgColor};"></div>
          </div>`;
        detailMarkers.push(mapView.Markers.add(annotation.coordinate, markerHtml, { rank: "always-visible" }));
      } else if (annotation.icon?.url) {
        // Icone standard non cliccabili (vie di fuga, ecc.)
        const iconHtml = `<img src="${annotation.icon.url}" alt="${annotation.type || name}" style="width:12px;height:12px;" />`;
        detailMarkers.push(mapView.Markers.add(annotation.coordinate, iconHtml, { rank: "always-visible" }));
      }
    });
  } catch (e) {
    debug("Nessuna annotation disponibile o errore:", e);
  }

  // POI marker cliccabili per PORTE speciali (door convertite in location: ingresso/uscita fiera)
  allDoors.forEach((door: any) => {
    if (!door.name) return;
    const nl = door.name.toLowerCase();
    const isSpecialDoor = isSpecialNav(door.name);
    if (!isSpecialDoor) return;
    const isUscita = nl.includes('uscita');
    const svgD = isUscita
      ? `<svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`
      : `<svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
    const lblD = door.name.length > 18 ? door.name.substring(0, 18) + '…' : door.name;
    const mHtmlD = `<div onclick="event.stopPropagation();window.handleDoorPoiClick('${door.id}')" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;pointer-events:auto;"><div style="background:#005461;border-radius:50%;width:15px;height:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.3);border:1px solid white;">${svgD}</div><div style="background:#005461;color:white;padding:1px 4px;border-radius:2px;font-size:7px;font-weight:700;font-family:'Onest',sans-serif;white-space:nowrap;margin-top:1px;box-shadow:0 1px 3px rgba(0,0,0,0.2);text-transform:uppercase;letter-spacing:0.3px;max-width:70px;overflow:hidden;text-overflow:ellipsis;">${lblD}</div><div style="width:0;height:0;border-left:2px solid transparent;border-right:2px solid transparent;border-top:2px solid #005461;"></div></div>`;
    try {
      detailMarkers.push(mapView.Markers.add(door, mHtmlD, { rank: "always-visible" }));
    } catch (e) {
      console.error('Door marker fallback:', door.name, e);
    }
  });

  // Aree (Padiglioni) — tint + blocco estruso. I badge PAD si creano dopo (ancorati all'area).
  try {
    allAreas = mapData.getByType("area") || [];
    debug("=== AREE ===");

    allAreas.forEach((area: any) => {
      const areaGeoJSON = area.geoJSON;

      if (areaGeoJSON) {
        const shapeFeatureCollection = {
          type: "FeatureCollection" as const,
          features: [
            {
              type: areaGeoJSON.type,
              properties: areaGeoJSON.properties,
              geometry: areaGeoJSON.geometry,
            },
          ],
        };

        // Tint piatto sottile, sempre visibile (terreno padiglione)
        mapView.Shapes.add(shapeFeatureCollection, {
          color: "#881814",
          altitude: 0.01,
          height: 0.01,
          opacity: 0.15,
        } as any);

        // Blocco solido estruso — aggiunto/rimosso in base allo zoom (vista lontana)
        blockDefs.push({
          fc: shapeFeatureCollection,
          opts: { color: "#881814", altitude: 0, height: 3, opacity: 0.92 },
        });

      }
    });
  } catch (e) {
    debug("Errore aree:", e);
  }

  // Badge PAD: nome padiglione ancorato all'AREA (anchor SDK robusto), sempre in primo piano
  // (zIndex alto). Bordo bianco per staccarlo dal blocco rosso. Fallback su area.center.
  allAreas.forEach((area: any) => {
    if (!area?.name) return;
    const padHtml = `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
      <div style="background:#881814;color:#fff;padding:4px 16px;border-radius:6px;border:2px solid #fff;font-size:14px;font-weight:800;font-family:'Onest',sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.45);text-transform:uppercase;letter-spacing:0.8px;">${area.name}</div>
      <div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-top:7px solid #fff;"></div>
    </div>`;
    let added = false;
    try {
      const m = mapView.Markers.add(area, padHtml, { rank: "always-visible", zIndex: 5000 } as any);
      farMarkers.push(m);
      added = true;
    } catch (e) {
      console.error('Badge PAD anchor-area fail:', area.name, e);
    }
    if (!added && area.center) {
      try {
        const m = mapView.Markers.add(area.center, padHtml, { rank: "always-visible", zIndex: 5000 } as any);
        farMarkers.push(m);
      } catch (e) {
        console.error('Badge PAD center fail:', area.name, e);
      }
    }
  });

  // Costruisce la lista unificata per la ricerca: spazi + annotations con nome + porte con nome
  allSearchableItems = [
    ...allSpaces.map((s: any) => ({ id: s.id, name: s.name, _type: "space", _ref: s, _isService: isServiceLocation(s.name) })),
    ...allAnnotations
      .filter((a: any) => {
        if (!a.name) return false;
        // Escludi le safety annotations (icone vie di fuga ecc.) — hanno icon URL e non sono POI speciali
        if (a.icon?.url) {
          return isSpecialNav(a.name);
        }
        return true;
      })
      .map((a: any) => ({ id: a.id, name: a.name, _type: "annotation", _ref: a, _isService: isServiceLocation(a.name) })),
    ...allDoors
      .filter((d: any) => d.name)
      .map((d: any) => ({ id: d.id, name: d.name, _type: "door", _ref: d, _isService: isServiceLocation(d.name) })),
    ...allConnections
      .map((c: any) => ({ id: c.id, name: c.name, _type: "connection", _ref: c, _isService: true })),
  ];

  // Marker cliccabili #881814 per location-spazio di ingresso/uscita fiera e padiglione
  rawSpaces.forEach((space: any) => {
    if (!space.name) return;
    const nl = space.name.toLowerCase();
    const isSpecialLoc = isSpecialNav(space.name);
    if (!isSpecialLoc) return;
    const isUscita = nl.includes('uscita');
    const svgIcon = isUscita
      ? `<svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`
      : `<svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
    const lbl = space.name.length > 18 ? space.name.substring(0, 18) + '…' : space.name;
    const mHtml = `<div onclick="event.stopPropagation();window.handleSpacePoiClick('${space.id}')" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;pointer-events:auto;"><div style="background:#005461;border-radius:50%;width:15px;height:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.3);border:1px solid white;">${svgIcon}</div><div style="background:#005461;color:white;padding:1px 4px;border-radius:2px;font-size:7px;font-weight:700;font-family:'Onest',sans-serif;white-space:nowrap;margin-top:1px;box-shadow:0 1px 3px rgba(0,0,0,0.2);text-transform:uppercase;letter-spacing:0.3px;max-width:70px;overflow:hidden;text-overflow:ellipsis;">${lbl}</div><div style="width:0;height:0;border-left:2px solid transparent;border-right:2px solid transparent;border-top:2px solid #005461;"></div></div>`;
    detailMarkers.push(mapView.Markers.add(space, mHtml, { rank: "always-visible" }));
  });

  // Rendi interattivi tutti gli spazi
  rawSpaces.forEach((space: any) => {
    mapView.updateState(space, {
      interactive: true,
      hoverColor: "#D27A31",
    });
  });

  // Build profile map ASAP (needed by label markers for logo)
  try {
    const earlyProfiles = mapData.getByType('location-profile') || [];
    earlyProfiles.forEach((profile: any) => {
      (profile.spaces || []).forEach((ps: any) => {
        if (ps?.id) spaceProfileMap[ps.id] = profile;
      });
    });
  } catch (_) { /* ignore */ }

  // Labels degli spazi (locations) — espositori arancione, servizi #005461
  // Usa Markers custom per posizionare il testo SEMPRE sopra il dot (evita il riposizionamento automatico del SDK)
  allSpaces.forEach((space: any) => {
    if (space.name) {
      // Salta gli spazi speciali (ingresso/uscita fiera, ingresso padiglione) che hanno già il loro marker POI
      const isSpecialLoc = isSpecialNav(space.name);
      if (isSpecialLoc) return;

      const isSvc = isServiceLocation(space.name);
      const labelColor = isSvc ? "#005461" : "#881814";
      const profile = spaceProfileMap[space.id];
      const logoUrl = profile?.logoImage?.url || profile?.logo || null;
      const textShadow = "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff";
      const standNum = isSvc ? undefined : getStandNumber(space.name);

      let labelHtml: string;
      if (standNum !== undefined) {
        // Espositore: numero stand SEMPRE visibile (pill 22px), nome solo da vicino (.map-names-visible)
        labelHtml = `
          <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
            <div class="marker-label-text" style="color:${labelColor};font-size:11px;font-weight:700;font-family:'Onest',sans-serif;text-align:center;text-shadow:${textShadow};max-width:120px;line-height:1.15;word-wrap:break-word;overflow-wrap:break-word;">${space.name}</div>
            <div class="marker-stand-num" style="min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;border-radius:11px;background:#fff;border:1.5px solid ${labelColor};color:${labelColor};font-size:11px;font-weight:800;font-family:'Onest',sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.25);margin-top:2px;">${standNum}</div>
          </div>`;
      } else if (logoUrl) {
        // Verticale: nome sopra + logo nel cerchietto sotto (espositori E servizi)
        labelHtml = `
          <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
            <div class="marker-label-text marker-label-svc" style="color:${labelColor};font-size:11px;font-weight:700;font-family:'Onest',sans-serif;text-align:center;text-shadow:${textShadow};max-width:120px;line-height:1.15;word-wrap:break-word;overflow-wrap:break-word;">${space.name}</div>
            <div style="width:26px;height:26px;border-radius:50%;background:#fff;border:1.5px solid ${labelColor};box-shadow:0 1px 3px rgba(0,0,0,0.28);overflow:hidden;display:flex;align-items:center;justify-content:center;margin-top:2px;flex-shrink:0;">
              <img src="${logoUrl}" alt="" style="width:86%;height:86%;object-fit:contain;" />
            </div>
          </div>`;
      } else {
        // Verticale: nome + pallino (default, nessun logo)
        labelHtml = `
          <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
            <div class="marker-label-text marker-label-svc" style="color:${labelColor};font-size:11px;font-weight:700;font-family:'Onest',sans-serif;text-align:center;text-shadow:${textShadow};max-width:120px;line-height:1.15;word-wrap:break-word;overflow-wrap:break-word;">${space.name}</div>
            <div style="width:10px;height:10px;border-radius:50%;background:${labelColor};border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.2);margin-top:1px;"></div>
          </div>`;
      }
      detailMarkers.push(mapView.Markers.add(space, labelHtml, { rank: "always-visible" }));
    }
  });

  // Labels per CONNECTIONS con nome (stairway/elevator/escalator/ramp) — trattate come servizi
  allConnections.forEach((conn: any) => {
    const coord = (conn.coordinates && conn.coordinates[0]) || conn.coordinate || null;
    if (!coord) return;
    const labelColor = "#005461";
    const textShadow = "-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff";
    const profile = (conn.locationProfiles && conn.locationProfiles[0]) || null;
    const logoUrl = profile?.logoImage?.url || profile?.logo || null;
    const iconBlock = logoUrl
      ? `<div style="width:26px;height:26px;border-radius:50%;background:#fff;border:1.5px solid ${labelColor};box-shadow:0 1px 3px rgba(0,0,0,0.28);overflow:hidden;display:flex;align-items:center;justify-content:center;margin-top:2px;flex-shrink:0;">
           <img src="${logoUrl}" alt="" style="width:86%;height:86%;object-fit:contain;" />
         </div>`
      : `<div style="width:10px;height:10px;border-radius:50%;background:${labelColor};border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.2);margin-top:1px;"></div>`;
    const labelHtml = `
      <div onclick="event.stopPropagation();window.handleConnectionClick('${conn.id}')" style="display:flex;flex-direction:column;align-items:center;cursor:pointer;pointer-events:auto;">
        <div class="marker-label-text marker-label-svc" style="color:${labelColor};font-size:11px;font-weight:700;font-family:'Onest',sans-serif;text-align:center;text-shadow:${textShadow};max-width:120px;line-height:1.15;word-wrap:break-word;overflow-wrap:break-word;">${conn.name}</div>
        ${iconBlock}
      </div>`;
    try {
      detailMarkers.push(mapView.Markers.add(coord, labelHtml, { rank: "always-visible" }));
    } catch (e) { console.error('Connection label fail:', conn.name, e); }
  });

  // Click handler
  mapView.on("click", async (event: any) => {
    const clickedSpace = event?.spaces?.[0];

    // Se stiamo aspettando il dropped pin
    if (waitingForPin) {
      placeDroppedPin(event.coordinate);
      return;
    }

    // Se il pannello direzioni e' aperto ma non aspettiamo pin,
    // e clicchiamo su uno spazio, usalo come partenza (origin)
    if (directionsActive && clickedSpace && !directionTo && !toCoord) {
      setToDestination(clickedSpace, null, clickedSpace.name);
      document.getElementById("directions-search-dest")!.style.display = "none";
      return;
    }
    if (directionsActive && clickedSpace && !directionFrom && !fromCoord) {
      setFromOrigin(clickedSpace);
      return;
    }

    // Click normale su spazio -> seleziona
    if (clickedSpace) {
      // Se il pannello direzioni non e' aperto, seleziona normalmente
      if (!directionsActive) {
        selectSpace(clickedSpace);
      }
    } else if (!directionsActive) {
      // Click su area vuota -> chiudi solo la tendina di ricerca
      const results = document.getElementById("search-results");
      if (results) results.style.display = "none";
    }
  });

  // ============ BUILD TAG MAP + SLUG MAP ============
  // Usa location-profile che contiene searchTags, externalId e il collegamento .spaces
  try {
    const locationProfiles = mapData.getByType('location-profile') || [];
    locationProfiles.forEach((profile: any) => {
      const profileSpaces: any[] = profile.spaces || [];
      profileSpaces.forEach((profileSpace: any) => {
        const space = allSpaces.find((s: any) => s.id === profileSpace.id);
        if (!space) return;
        // Slug map (externalId ha priorità)
        if (profile.externalId) {
          spaceExternalIdMap[space.id] = profile.externalId;
          spaceSlugMap[profile.externalId] = space;
        }
        const slug = slugify(space.name);
        if (!spaceSlugMap[slug]) spaceSlugMap[slug] = space;
        // Tag map
        if (!profile.searchTags || profile.searchTags.length === 0) return;
        profile.searchTags.forEach((tag: string) => {
          const key = tag.toLowerCase().trim();
          if (!tagMap[key]) tagMap[key] = [];
          if (!tagMap[key].includes(space)) tagMap[key].push(space);
        });
      });
    });
    // Aggiungi slug per spazi non coperti da location-profile
    allSpaces.forEach((space: any) => {
      const slug = slugify(space.name);
      if (!spaceSlugMap[slug]) spaceSlugMap[slug] = space;
    });
  } catch (e) {
    console.error('[MERCEOLOGIE] Errore:', e);
  }

  // Auto-seleziona location da URL (?loc=slug-o-id)
  const urlLoc = new URLSearchParams(window.location.search).get('loc');
  if (urlLoc) {
    const locSpace = allSpaces.find((s: any) => s.id === urlLoc)
      || spaceSlugMap[urlLoc]
      || spaceSlugMap[decodeURIComponent(urlLoc)];
    if (locSpace) {
      setTimeout(() => selectSpace(locSpace), 900);
    }
  }

  // Ascolta messaggi dal parent (iframe) per deep-link
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data && e.data.type === 'mappedin-set-loc' && e.data.loc) {
      const loc = e.data.loc;
      const space = allSpaces.find((s: any) => s.id === loc)
        || spaceSlugMap[loc]
        || spaceSlugMap[decodeURIComponent(loc)];
      if (space) {
        trackDeeplink(loc);
        selectSpace(space);
      }
    }
  });

  // Double-tap to zoom (tablet/smartphone — no pinch needed)
  const mapEl = document.getElementById("mappedin-map")!;
  let lastTapTime = 0;
  mapEl.addEventListener("touchend", (e: TouchEvent) => {
    // Only single-finger taps count
    if (e.touches.length > 0) return;
    const now = Date.now();
    const delta = now - lastTapTime;
    lastTapTime = now;
    if (delta > 0 && delta < 350) {
      // Double tap detected — zoom in by 1.5 levels
      e.preventDefault();
      const cam = mapView.Camera as any;
      const currentZoom = cam.zoomLevel;
      if (typeof currentZoom === "number") {
        cam.animateTo({ zoomLevel: Math.min(currentZoom + 1.5, 23) }, { duration: 300 });
      }
    }
  }, { passive: false });

  // Vista per zoom (evento camera-change): da lontano blocchi padiglione + topper + INGRESSO,
  // da vicino stand/servizi. Soglia 18.0 (~17.7 vista intera). Durante le indicazioni si
  // forza SEMPRE la vista vicina (espositori), così i blocchi non coprono il percorso.
  const addBlocks = () => {
    blockDefs.forEach(d => { try { blockShapes.push(mapView.Shapes.add(d.fc, d.opts as any)); } catch { } });
  };
  const removeBlocks = () => {
    blockShapes.forEach(s => { try { mapView.Shapes.remove(s); } catch { } });
    blockShapes = [];
  };
  // Soglia bassa: i blocchi padiglione (+ badge PAD) compaiono SOLO se si zooma molto
  // fuori dalla vista iniziale; al min zoom di default si vedono direttamente gli espositori.
  const FAR_ZOOM_THRESHOLD = 16.5;
  const applyZoomVisibility = (z: number) => {
    const far = z <= FAR_ZOOM_THRESHOLD && !directionsActive;
    if (far === lastFar) return;
    lastFar = far;
    if (far) mapEl.classList.remove("map-zoomed-in");
    else mapEl.classList.add("map-zoomed-in");
    detailMarkers.forEach(m => { try { mapView.updateState(m, { enabled: !far }); } catch { } });
    farMarkers.forEach(m => { try { mapView.updateState(m, { enabled: far }); } catch { } });
    if (far && !blocksAdded) { addBlocks(); blocksAdded = true; }
    else if (!far && blocksAdded) { removeBlocks(); blocksAdded = false; }
  };
  const getZoom = () => {
    const cam = mapView.Camera as any;
    return typeof cam.zoomLevel === "number" ? cam.zoomLevel : 17.7;
  };
  // Nomi espositori: visibili solo da vicino (sotto la soglia restano i soli numeri stand,
  // i servizi hanno sempre il nome). Soglia più alta su mobile: schermo stretto, meno spazio.
  const isMobileViewport = window.innerWidth <= 600;
  const NAME_ZOOM_THRESHOLD = isMobileViewport ? 18.9 : 18.2;
  let lastNames: boolean | null = null;
  const applyNameVisibility = (z: number) => {
    // Con le indicazioni attive la vista intera (focusOn allSpaces) renderebbe i numeri un
    // ammasso che copre il percorso: sotto soglia restano solo i servizi (CSS .map-directions).
    mapEl.classList.toggle("map-directions", directionsActive);
    const show = z >= NAME_ZOOM_THRESHOLD;
    if (show === lastNames) return;
    lastNames = show;
    mapEl.classList.toggle("map-names-visible", show);
  };
  // Hook richiamabile quando cambia lo stato indicazioni (forza ricalcolo)
  refreshZoomView = () => { lastFar = null; applyZoomVisibility(getZoom()); applyNameVisibility(getZoom()); };
  mapView.on("camera-change", (t: any) => {
    if (t && typeof t.zoomLevel === "number") { applyZoomVisibility(t.zoomLevel); applyNameVisibility(t.zoomLevel); }
  });
  // Mobile: vista iniziale centrata sull'ingresso del padiglione, zoom intermedio (solo numeri stand).
  // Desktop: vista intera di default del SDK.
  // L'ingresso sta sul bordo del padiglione: il centro viene spostato del 30% verso il
  // baricentro degli stand, così lo schermo inquadra l'ingresso E le prime file.
  if (isMobileViewport && entranceList[0]?.coordinate && !new URLSearchParams(window.location.search).get('loc')) {
    try {
      const ent = entranceList[0].coordinate;
      const centers = allSpaces.map((sp: any) => sp.center).filter((c: any) => c && typeof c.latitude === 'number');
      let center = ent;
      if (centers.length) {
        const cLat = centers.reduce((a: number, c: any) => a + c.latitude, 0) / centers.length;
        const cLng = centers.reduce((a: number, c: any) => a + c.longitude, 0) / centers.length;
        center = mapView.createCoordinate(ent.latitude + (cLat - ent.latitude) * 0.3, ent.longitude + (cLng - ent.longitude) * 0.3);
      }
      mapView.Camera.set({ center, zoomLevel: 18.4 });
    } catch { /* ignore */ }
  }
  applyZoomVisibility(getZoom()); // stato iniziale
  applyNameVisibility(getZoom());

  debug("Mappa caricata con successo!");
}

// ============================================
// Seleziona uno spazio e mostra il pannello info
// ============================================
function selectSpace(space: any) {
  clearHighlightedSpaces();
  clearSelection();
  selectedSpace = space;

  mapViewRef.updateState(space, {
    interactive: true,
    color: "#EF8B38",
    hoverColor: "#D27A31",
  });

  // Zoom moderato: centra sulla location con contesto visibile
  mapViewRef.Camera.animateTo(
    { center: space.center, zoomLevel: 19.0 },
    { duration: 800 }
  );
  showLocationPanel(space);
  window.history.replaceState(null, '', '?loc=' + encodeURIComponent(spaceUrlKey(space)));
  if (window.parent !== window) window.parent.postMessage({ type: 'mappedin-loc', loc: spaceUrlKey(space) }, '*');
}

function clearSelection() {
  // Reset colore dello spazio precedentemente selezionato
  if (selectedSpace && mapViewRef) {
    mapViewRef.updateState(selectedSpace, {
      interactive: true,
      color: "initial",
      hoverColor: "#D27A31",
    });
  }
  selectedSpace = null;
  selectedNonSpaceItem = null;
}

function clearHighlightedSpaces() {
  if (highlightAnimInterval) {
    clearInterval(highlightAnimInterval);
    highlightAnimInterval = null;
  }
  highlightedSpaces.forEach((space: any) => {
    mapViewRef?.updateState(space, { interactive: true, color: "initial", hoverColor: "#D27A31" });
  });
  highlightedSpaces = [];
  const banner = document.getElementById("tag-filter-banner");
  if (banner) banner.style.display = "none";
}

function highlightSpacesByTag(tag: string) {
  clearHighlightedSpaces();
  clearSelection();
  const spaces = tagMap[tag] || [];
  if (spaces.length === 0) return;
  highlightedSpaces = spaces;
  spaces.forEach((space: any) => {
    mapViewRef?.updateState(space, { interactive: true, color: "#EF8B38", hoverColor: "#D27A31" });
  });
  // Pulsazione fluida con sine wave: da #EF8B38 (giallo) a #FCE8D7 (giallo chiaro)
  const animStart = Date.now();
  highlightAnimInterval = setInterval(() => {
    const elapsed = (Date.now() - animStart) / 1000;
    // Sine wave: periodo ~2.4s, valore da 0 a 1
    const t = (Math.sin(elapsed * Math.PI * 0.83) + 1) / 2;
    const color = lerpHex("#EF8B38", "#FCE8D7", t);
    highlightedSpaces.forEach((space: any) => {
      mapViewRef?.updateState(space, { interactive: true, color, hoverColor: "#D27A31" });
    });
  }, 80);
  if (mapViewRef && spaces.length > 0) {
    mapViewRef.Camera.focusOn(spaces, {
      duration: 600,
      padding: { top: 80, bottom: 80, left: 80, right: 80 },
    });
  }
  // Mostra banner filtro attivo
  const banner = document.getElementById("tag-filter-banner");
  const label = document.getElementById("tag-filter-label");
  if (banner && label) {
    label.textContent = tag.charAt(0).toUpperCase() + tag.slice(1) + ` (${spaces.length} stand)`;
    banner.style.display = "flex";
  }
}

function handlePoiMarkerClick(annotationId: string) {
  const annotation = allAnnotations.find((a: any) => a.id === annotationId);
  if (!annotation) return;
  clearHighlightedSpaces();
  clearSelection();
  if (annotation.coordinate) {
    selectedNonSpaceItem = { name: annotation.name, coordinate: annotation.coordinate, ref: null };
    mapViewRef?.Camera.focusOn(annotation.coordinate, { duration: 500 });
    setTimeout(() => {
      if (!mapViewRef?.Camera) return;
      const cam = mapViewRef.Camera as any;
      const z = cam.zoom ?? cam.zoomLevel ?? cam.distance;
      if (typeof z === 'number' && z > 0) {
        cam.set({ zoom: z * 3, duration: 400 });
      }
    }, 600);
  }
  showLocationPanel({ name: annotation.name });
  window.history.replaceState(null, '', '?loc=' + encodeURIComponent(annotation.id));
  if (window.parent !== window) window.parent.postMessage({ type: 'mappedin-loc', loc: annotation.id }, '*');
}

function handleSpacePoiClick(spaceId: string) {
  const space = allSpaces.find((s: any) => s.id === spaceId);
  if (space) selectSpace(space);
}

function handleDoorPoiClick(doorId: string) {
  const door = allDoors.find((d: any) => d.id === doorId);
  if (!door) return;
  clearHighlightedSpaces();
  clearSelection();
  selectedNonSpaceItem = { name: door.name, coordinate: null, ref: door };
  try {
    mapViewRef?.Camera.focusOn(door, { duration: 500 });
    setTimeout(() => {
      if (!mapViewRef?.Camera) return;
      const cam = mapViewRef.Camera as any;
      const z = cam.zoom ?? cam.zoomLevel ?? cam.distance;
      if (typeof z === 'number' && z > 0) cam.set({ zoom: z * 3, duration: 400 });
    }, 600);
  } catch { }
  showLocationPanel({ name: door.name });
  window.history.replaceState(null, '', '?loc=' + encodeURIComponent(door.id));
  if (window.parent !== window) window.parent.postMessage({ type: 'mappedin-loc', loc: door.id }, '*');
}

function handleConnectionClick(connId: string) {
  const conn = allConnections.find((c: any) => c.id === connId);
  if (!conn) return;
  const coord = (conn.coordinates && conn.coordinates[0]) || conn.coordinate || null;
  clearHighlightedSpaces();
  clearSelection();
  selectedNonSpaceItem = { name: conn.name, coordinate: coord, ref: conn };
  try {
    if (coord) mapViewRef?.Camera.focusOn(coord, { duration: 500 });
  } catch { }
  showLocationPanel(conn);
  window.history.replaceState(null, '', '?loc=' + encodeURIComponent(conn.id));
  if (window.parent !== window) window.parent.postMessage({ type: 'mappedin-loc', loc: conn.id }, '*');
}

function handleEntranceArrowClick(i: number) {
  const ent = entranceList[i];
  if (!ent || !mapViewRef) return;
  // Zoom dentro al padiglione → la vista vicina mostra gli stand, la freccia si nasconde
  if (ent.coordinate) {
    mapViewRef.Camera.animateTo({ center: ent.coordinate, zoomLevel: 19.2 }, { duration: 700 });
  } else if (ent.ref) {
    try { mapViewRef.Camera.focusOn(ent.ref, { duration: 600 }); } catch { }
    setTimeout(() => { try { mapViewRef.Camera.animateTo({ zoomLevel: 19.4 }, { duration: 400 }); } catch { } }, 650);
  }
}

function clearAllState() {
  clearHighlightedSpaces();
  clearSelection();
  directionFrom = null;
  directionTo = null;
  fromCoord = null;
  toCoord = null;
  waitingForPin = false;
  directionsActive = false;

  // Rimuovi marker dropped pin
  if (droppedPinMarker && mapViewRef) {
    mapViewRef.Markers.remove(droppedPinMarker);
    droppedPinMarker = null;
  }

  // Rimuovi cursore pin
  document.getElementById("mappedin-map")?.classList.remove("pin-cursor");

  // Pulisci navigazione e marker direzioni
  if (mapViewRef) {
    mapViewRef.Navigation.clear();
  }
  clearDirectionMarkers();

  // Chiudi stepper
  closeNavStepper();

  // Ripristina vista per zoom (riattiva blocchi se siamo da lontano)
  refreshZoomView();
}

// ============================================
// UI Creation
// ============================================
function createUI() {
  const container = document.createElement("div");
  container.id = "ui-container";
  container.innerHTML = `
    <!-- Barra di ricerca -->
    <div id="search-container">
      <div id="search-box">
        <svg id="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#999" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" id="search-input" placeholder="Cerca espositori e servizi" autocomplete="off" />
        <button id="search-clear" style="display:none;">&times;</button>
      </div>
      <div id="search-mode-header" style="display:none;"></div>
      <div id="search-results" style="display:none;"></div>
      <div id="tag-filter-banner" style="display:none;">
        <span id="tag-filter-label"></span>
        <button id="tag-filter-clear">&times; Rimuovi filtro</button>
      </div>
    </div>

    <!-- Pannello Location -->
    <div id="location-panel" style="display:none;">
      <div id="location-drag-handle" aria-label="Espandi pannello">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
      </div>
      <div id="location-photos" style="display:none;">
        <button id="location-photo-prev" class="photo-nav" aria-label="Foto precedente">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button id="location-photo-next" class="photo-nav" aria-label="Foto successiva">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button id="location-close-photos" aria-label="Chiudi">&times;</button>
        <img id="location-photo-img" alt="" decoding="async" />
      </div>
      <div id="location-header">
        <img id="location-logo" alt="" style="display:none;" />
        <div id="location-title">
          <h3 id="location-name"></h3>
          <div id="location-stand" style="display:none;"></div>
        </div>
        <button id="location-close">&times;</button>
      </div>
      <div id="location-description" style="display:none;"></div>
      <div id="location-info"></div>
      <div id="location-actions">
        <button id="btn-directions" class="action-btn">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="3 11 22 2 13 21 11 13 3 11"/>
          </svg>
          Indicazioni
        </button>
      </div>
    </div>

    <!-- Pannello Direzioni -->
    <div id="directions-panel" style="display:none;">
      <div id="directions-header">
        <button id="directions-close">&times;</button>
        <h3>Indicazioni</h3>
      </div>
      <div id="directions-form">
        <div id="directions-fields">
          <div class="direction-row">
            <span class="direction-dot from-dot"></span>
            <div class="direction-field" id="from-field">
              <label>Da:</label>
              <div id="from-options">
                <div id="from-top-row">
                  <div id="from-entrance-list"></div>
                  <button class="from-option" data-type="search">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    Cerca punto di partenza
                  </button>
                </div>
                <button class="from-option" data-type="pin">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                  </svg>
                  Scegli sulla mappa il punto da cui parti
                </button>
              </div>
              <span id="from-value" class="field-value" style="display:none;"></span>
              <button id="from-reset" style="display:none;">Cambia</button>
            </div>
          </div>
          <button id="btn-swap" title="Inverti partenza e destinazione">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 18V6"/>
              <path d="M4 9l3-3 3 3"/>
              <path d="M17 6v12"/>
              <path d="M14 15l3 3 3-3"/>
            </svg>
          </button>
          <div class="direction-row">
            <span class="direction-dot to-dot"></span>
            <div class="direction-field" id="to-field">
              <label>A:</label>
              <span id="to-value" class="field-value is-placeholder">Scegli la destinazione</span>
              <button id="to-reset" style="display:none;">Cambia</button>
            </div>
          </div>
        </div>
      </div>
      <div id="directions-info" style="display:none;">
        <div id="directions-distance"></div>
        <div id="directions-time"></div>
      </div>
      <div id="directions-search-dest" style="display:none;">
        <input type="text" id="dest-search-input" placeholder="Cerca destinazione..." autocomplete="off" />
        <div id="dest-search-results"></div>
      </div>
      <div id="dropped-pin-hint" style="display:none;">
        <div class="hint-content">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="#881814">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3" fill="#fff"/>
          </svg>
          <span>Clicca sulla mappa per posizionare il punto</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(container);

  // Cover strip per nascondere il watermark Mappedin nel canvas (bottom-left)
  const logoCover = document.createElement("div");
  logoCover.id = "mappedin-logo-cover";
  document.body.appendChild(logoCover);

  // Logo T2000 in Tour - sostituisce il logo Mappedin
  const logoLink = document.createElement("a");
  logoLink.id = "custom-logo";
  logoLink.href = "https://www.t2000intour.it";
  logoLink.target = "_blank";
  logoLink.rel = "noopener";
  logoLink.innerHTML = `<img src="/t2000-logo.svg" alt="T2000 in Tour" /><span id="custom-logo-label">Torino 2026</span>`;
  document.body.appendChild(logoLink);

  setTimeout(() => {
    setupSearchListeners();
    setupLocationPanelListeners();
    setupDirectionsPanelListeners();
  }, 0);
}

// ============================================
// Search
// ============================================
function setupSearchListeners() {
  const input = document.getElementById("search-input") as HTMLInputElement;
  const results = document.getElementById("search-results")!;
  const modeHeader = document.getElementById("search-mode-header")!;
  const clear = document.getElementById("search-clear")!;
  const expandedTags = new Set<string>();

  function renderModeToggle(): string {
    return `<div class="search-mode-toggle">
      <button class="mode-btn${searchMode === 'espositori' ? ' active' : ''}" data-mode="espositori">Espositori</button>
      <button class="mode-btn mode-btn-mid${searchMode === 'merceologie' ? ' active' : ''}" data-mode="merceologie">Merceologie</button>
      <button class="mode-btn${searchMode === 'servizi' ? ' active active-servizi' : ''}" data-mode="servizi">Servizi</button>
    </div>`;
  }

  const sortByName = (a: any, b: any) => a.name.localeCompare(b.name, 'it');
  const sortTagsByKey = (a: [string, any[]], b: [string, any[]]) => a[0].localeCompare(b[0], 'it');

  function renderMerceologieList(tags: [string, any[]][]): string {
    if (tags.length === 0) return '<div class="search-item no-results">Nessun risultato</div>';
    return [...tags].sort(sortTagsByKey).map(([tag, spaces]) => {
      const sortedSpaces = [...(spaces as any[])].sort(sortByName);
      const isExpanded = expandedTags.has(tag);
      const expandIcon = isExpanded
        ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`
        : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
      let tagHtml = `<div class="search-item tag-result" data-tag="${tag}">
        <span class="result-dot dot-tag"></span>
        <span class="tag-label">${tag.charAt(0).toUpperCase() + tag.slice(1)}</span>
        <span class="tag-badge">${sortedSpaces.length}</span>
        <button class="tag-expand-btn" data-tag="${tag}" title="${isExpanded ? 'Comprimi' : 'Espandi lista'}">${expandIcon}</button>
      </div>`;
      if (isExpanded) {
        tagHtml += sortedSpaces.map((space: any) => {
          const num = getStandNumber(space.name);
          const numBadge = num !== undefined ? `<span class="stand-badge">Stand n°${num}</span>` : '';
          return `<div class="search-item tag-location-item" data-item-id="${space.id}" data-item-type="space" data-parent-tag="${tag}">
            <span class="result-dot dot-space" style="margin-left:12px;"></span><span style="flex:1">${space.name}</span>${numBadge}
          </div>`;
        }).join("");
      }
      return tagHtml;
    }).join("");
  }

  function renderEspositori(items: any[]): string {
    if (items.length === 0) return '<div class="search-item no-results">Nessun risultato</div>';
    return [...items].sort(sortByName).map((item: any) => {
      const standNum = getStandNumber(item.name);
      const badge = standNum !== undefined
        ? `<span class="stand-badge">Stand n°${standNum}</span>`
        : '';
      return `<div class="search-item espositori-item" data-item-id="${item.id}" data-item-type="${item._type}">
        <span class="result-dot dot-space"></span><span class="espositori-name">${item.name}</span>${badge}
      </div>`;
    }).join("");
  }

  function renderServizi(items: any[]): string {
    if (items.length === 0) return '<div class="search-item no-results">Nessun risultato</div>';
    return [...items].sort(sortByName).map((item: any) =>
      `<div class="search-item servizi-item" data-item-id="${item.id}" data-item-type="${item._type}">
        <span class="result-dot dot-service"></span>${item.name}
      </div>`
    ).join("");
  }

  // Ricerca unificata cross-categoria: mostra tutti i risultati raggruppati per tipo
  function renderUnified(query: string): string {
    const espositori = allSearchableItems
      .filter((i: any) => !i._isService && matchesQuery(i.name, query))
      .sort(sortByName);
    const servizi = allSearchableItems
      .filter((i: any) => i._isService && matchesQuery(i.name, query))
      .sort(sortByName);
    const merceologieTags = Object.entries(tagMap).filter(([tag, spaces]) =>
      tag.includes(query) || (spaces as any[]).some((s: any) => matchesQuery(s.name, query))
    );

    if (espositori.length === 0 && servizi.length === 0 && merceologieTags.length === 0) {
      return '<div class="search-item no-results">Nessun risultato</div>';
    }

    let html = '';
    if (espositori.length > 0) {
      html += `<div class="search-section-header">Espositori (${espositori.length})</div>`;
      html += renderEspositori(espositori);
    }
    if (servizi.length > 0) {
      html += `<div class="search-section-header">Servizi (${servizi.length})</div>`;
      html += renderServizi(servizi);
    }
    if (merceologieTags.length > 0) {
      html += `<div class="search-section-header">Merceologie</div>`;
      html += renderMerceologieList(merceologieTags);
    }
    return html;
  }

  function attachModeListeners() {
    modeHeader.querySelectorAll(".mode-btn").forEach(btn => {
      btn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        searchMode = (btn as HTMLElement).dataset.mode as 'merceologie' | 'espositori' | 'servizi';
        renderCurrentResults();
      });
    });
  }

  function showResultsWithToggle(itemsHtml: string) {
    modeHeader.innerHTML = renderModeToggle();
    modeHeader.style.display = "block";
    results.innerHTML = itemsHtml;
    results.style.display = "block";
    attachModeListeners();
  }

  function showResultsNoToggle(itemsHtml: string) {
    modeHeader.style.display = "none";
    results.innerHTML = itemsHtml;
    results.style.display = "block";
  }

  function hideSearchResults() {
    modeHeader.style.display = "none";
    results.style.display = "none";
  }

  function renderCurrentResults() {
    const query = input.value.trim().toLowerCase();
    if (query.length > 0) {
      // Ricerca unificata: mostra tutto ciò che corrisponde, raggruppato
      showResultsNoToggle(renderUnified(query));
    } else {
      // Sfoglia per tab
      let itemsHtml: string;
      if (searchMode === 'merceologie') {
        itemsHtml = renderMerceologieList(Object.entries(tagMap));
      } else if (searchMode === 'espositori') {
        itemsHtml = renderEspositori(allSearchableItems.filter((i: any) => !i._isService));
      } else {
        itemsHtml = renderServizi(allSearchableItems.filter((i: any) => i._isService));
      }
      showResultsWithToggle(itemsHtml);
    }
  }

  // Debounce timer per tracciare la ricerca solo quando l'utente ha smesso di digitare
  let searchTrackTimer: ReturnType<typeof setTimeout> | null = null;

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clear.style.display = query ? "block" : "none";
    if (query.length < 1) {
      hideSearchResults();
      return;
    }
    renderCurrentResults();

    // Traccia la ricerca dopo 800ms di pausa (evita un evento per ogni lettera)
    if (searchTrackTimer) clearTimeout(searchTrackTimer);
    searchTrackTimer = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) return;
      const espositori = allSearchableItems.filter((i: any) => !i._isService && matchesQuery(i.name, q));
      const servizi = allSearchableItems.filter((i: any) => i._isService && matchesQuery(i.name, q));
      const totalResults = espositori.length + servizi.length;
      trackEvent('search_performed', {
        search_term: q,
        results_count: totalResults,
        found: totalResults > 0,
      });
    }, 800);
  });

  function onSearchOpen() {
    if (selectedSpace || selectedNonSpaceItem) {
      clearSelection();
      hideLocationPanel();
    }
  }

  input.addEventListener("click", onSearchOpen);
  input.addEventListener("focus", () => {
    onSearchOpen();
    renderCurrentResults();
  });

  results.addEventListener("click", (e: Event) => {
    // Intercetta prima il click sul bottone expand/collapse
    const expandBtn = (e.target as HTMLElement).closest(".tag-expand-btn") as HTMLElement;
    if (expandBtn) {
      e.stopPropagation();
      const tag = expandBtn.dataset.tag!;
      if (expandedTags.has(tag)) {
        expandedTags.delete(tag);
      } else {
        expandedTags.add(tag);
      }
      renderCurrentResults();
      return;
    }

    const target = (e.target as HTMLElement).closest(".search-item") as HTMLElement;
    if (!target || target.classList.contains("no-results")) return;

    // Click su singola location sotto una merceologia
    if (target.classList.contains("tag-location-item")) {
      const itemId = target.dataset.itemId;
      const space = allSpaces.find((s: any) => s.id === itemId);
      if (space) {
        selectSpace(space);
        input.value = "";
        hideSearchResults();
        clear.style.display = "none";
      }
      return;
    }

    // Click su merceologia/tag (header) — evidenzia sulla mappa
    if (target.classList.contains("tag-result")) {
      const tag = target.dataset.tag!;
      highlightSpacesByTag(tag);
      input.value = "";
      hideSearchResults();
      clear.style.display = "none";
      return;
    }

    const itemId = target.dataset.itemId;
    const itemType = target.dataset.itemType;
    const item = allSearchableItems.find((i: any) => i.id === itemId && i._type === itemType);
    if (item) {
      if (item._type === "space") {
        selectSpace(item._ref);
      } else {
        clearSelection();
        if (item._type === "annotation" && item._ref.coordinate) {
          selectedNonSpaceItem = { name: item.name, coordinate: item._ref.coordinate, ref: null };
          mapViewRef?.Camera.focusOn(item._ref.coordinate);
        } else if (item._type === "door") {
          selectedNonSpaceItem = { name: item.name, coordinate: null, ref: item._ref };
          try { mapViewRef?.Camera.focusOn(item._ref); } catch (_) { /* ignore */ }
        } else if (item._type === "connection") {
          const cCoord = (item._ref.coordinates && item._ref.coordinates[0]) || item._ref.coordinate || null;
          selectedNonSpaceItem = { name: item.name, coordinate: cCoord, ref: item._ref };
          try { if (cCoord) mapViewRef?.Camera.focusOn(cCoord); } catch (_) { /* ignore */ }
        }
        showLocationPanel(item._ref || { name: item.name });
      }
      input.value = "";
      hideSearchResults();
      clear.style.display = "none";
    }
  });

  clear.addEventListener("click", () => {
    input.value = "";
    hideSearchResults();
    clear.style.display = "none";
    input.focus();
  });

  document.addEventListener("click", (e: Event) => {
    const searchContainer = document.getElementById("search-container")!;
    if (!searchContainer.contains(e.target as Node)) {
      hideSearchResults();
    }
  });

  document.getElementById("tag-filter-clear")?.addEventListener("click", () => {
    clearHighlightedSpaces();
  });
}

// ============================================
// Location Panel
// ============================================
function setupLocationPanelListeners() {
  document.getElementById("location-close")!.addEventListener("click", () => {
    hideLocationPanel();
    clearSelection();
  });

  document.getElementById("btn-directions")!.addEventListener("click", () => {
    if (selectedSpace) {
      openDirectionsPanel(selectedSpace);
    } else if (selectedNonSpaceItem) {
      openDirectionsPanelFromCoord(selectedNonSpaceItem);
    }
  });

  document.getElementById("location-photo-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    changeLocationPhoto(-1);
  });
  document.getElementById("location-photo-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    changeLocationPhoto(1);
  });
  document.getElementById("location-close-photos")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const wrap = document.getElementById("location-photos")!;
    wrap.style.display = "none";
  });

  // Bottom-sheet toggle on mobile (drag handle + header)
  const togglePanelExpanded = () => {
    const panel = document.getElementById("location-panel")!;
    panel.classList.toggle("expanded");
  };
  document.getElementById("location-drag-handle")?.addEventListener("click", togglePanelExpanded);
  // Tap on header (but not on close button) toggles too
  document.getElementById("location-header")?.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.closest("#location-close")) return;
    if (window.matchMedia("(max-width: 600px)").matches) {
      togglePanelExpanded();
    }
  });
}

function showLocationPanel(space: any) {
  const panel = document.getElementById("location-panel")!;
  const profile = (space?.id ? spaceProfileMap[space.id] : null)
    || (space?.locationProfiles && space.locationProfiles[0])
    || null;

  // Name
  document.getElementById("location-name")!.textContent = space.name || "Spazio senza nome";

  // Numero stand (solo espositori), sotto il nome
  const standEl = document.getElementById("location-stand")!;
  const standNum = space.name ? getStandNumber(space.name) : undefined;
  if (standNum !== undefined) {
    standEl.textContent = `Stand ${standNum}`;
    standEl.style.display = "block";
  } else {
    standEl.textContent = "";
    standEl.style.display = "none";
  }

  // Logo (in header, next to name)
  const logoEl = document.getElementById("location-logo") as HTMLImageElement;
  const logoUrl = profile?.logoImage?.url || profile?.logo || null;
  if (logoUrl) {
    logoEl.src = logoUrl;
    logoEl.style.display = "block";
  } else {
    logoEl.removeAttribute("src");
    logoEl.style.display = "none";
  }

  // Description
  const descEl = document.getElementById("location-description")!;
  if (profile?.description) {
    descEl.textContent = profile.description;
    descEl.style.display = "block";
  } else {
    descEl.textContent = "";
    descEl.style.display = "none";
  }

  // Photos carousel
  const photoUrls: string[] = (profile?.images || [])
    .map((img: any) => img?.url)
    .filter((u: any) => typeof u === 'string' && u.length > 0);
  renderPhotosCarousel(photoUrls);

  // Info rows (website, phone, social, links/email)
  renderLocationInfo(profile);

  panel.style.display = "block";
  panel.classList.remove("expanded"); // start collapsed on mobile
  document.getElementById("directions-panel")!.style.display = "none";
  document.getElementById("search-container")!.style.display = "block";

  trackEvent('location_opened', {
    location_name: space.name || 'sconosciuto',
  });
}

function renderPhotosCarousel(urls: string[]) {
  currentPhotoList = urls;
  currentPhotoIndex = 0;
  const wrap = document.getElementById("location-photos")!;
  const img = document.getElementById("location-photo-img") as HTMLImageElement;
  const prev = document.getElementById("location-photo-prev")!;
  const next = document.getElementById("location-photo-next")!;
  if (urls.length === 0) {
    wrap.style.display = "none";
    img.removeAttribute("src");
    return;
  }
  wrap.style.display = "block";
  img.src = urls[0];
  const multi = urls.length > 1;
  prev.style.display = multi ? "flex" : "none";
  next.style.display = multi ? "flex" : "none";
}

function changeLocationPhoto(delta: number) {
  if (currentPhotoList.length === 0) return;
  currentPhotoIndex = (currentPhotoIndex + delta + currentPhotoList.length) % currentPhotoList.length;
  const img = document.getElementById("location-photo-img") as HTMLImageElement;
  img.src = currentPhotoList[currentPhotoIndex];
}

// Detect social platform from URL → returns icon SVG
function socialIconFor(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('instagram.')) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`;
  }
  if (u.includes('facebook.')) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>`;
  }
  if (u.includes('linkedin.')) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>`;
  }
  if (u.includes('x.com') || u.includes('twitter.')) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.244 2H21.5l-7.5 8.57L22.5 22h-6.844l-5.36-7.01L4.156 22H.9l8.02-9.16L1.5 2h7.016l4.844 6.41L18.244 2zm-2.398 18h1.86L7.224 4h-2L15.846 20z"/></svg>`;
  }
  if (u.includes('youtube.') || u.includes('youtu.be')) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>`;
  }
  if (u.includes('tiktok.')) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.69a8.16 8.16 0 0 0 4.77 1.52V6.7a4.85 4.85 0 0 1-1.84 0z"/></svg>`;
  }
  // Generic share icon
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLocationInfo(profile: any) {
  const info = document.getElementById("location-info")!;
  if (!profile) { info.innerHTML = ""; return; }

  const rows: string[] = [];

  // Website
  const website: any = profile.website;
  if (website?.url) {
    const display = website.name || website.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    rows.push(`<a class="info-row" href="${escAttr(website.url)}" target="_blank" rel="noopener">
      <span class="info-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span>
      <span class="info-text">${escAttr(display)}</span>
    </a>`);
  }

  // Phone
  if (profile.phone) {
    rows.push(`<a class="info-row" href="tel:${escAttr(String(profile.phone).replace(/[^+\d]/g, ''))}">
      <span class="info-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span>
      <span class="info-text">${escAttr(String(profile.phone))}</span>
    </a>`);
  }

  // Social
  const socialList: any[] = Array.isArray(profile.social) ? profile.social : [];
  const socialItems = socialList
    .map((s: any) => (typeof s === 'string' ? s : (s?.url || s?.link || '')))
    .filter((u: string) => typeof u === 'string' && u.length > 0);
  if (socialItems.length > 0) {
    const icons = socialItems.map((url: string) => `<a href="${escAttr(url)}" target="_blank" rel="noopener" class="info-social-link" aria-label="social">${socialIconFor(url)}</a>`).join('');
    rows.push(`<div class="info-row info-social">
      <span class="info-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg></span>
      <span class="info-text info-socials">${icons}</span>
    </div>`);
  }

  // Links (mailto, generic)
  const links: any[] = Array.isArray(profile.links) ? profile.links : [];
  links.forEach((link: any) => {
    const url = link?.url || '';
    if (!url) return;
    const isMail = /^mailto:/i.test(url);
    const display = link.name || (isMail ? url.replace(/^mailto:/i, '') : url);
    const icon = isMail
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    rows.push(`<a class="info-row" href="${escAttr(url)}" ${isMail ? '' : 'target="_blank" rel="noopener"'}>
      <span class="info-icon">${icon}</span>
      <span class="info-text">${escAttr(display)}</span>
    </a>`);
  });

  info.innerHTML = rows.join('');
}

function hideLocationPanel() {
  document.getElementById("location-panel")!.style.display = "none";
  window.history.replaceState(null, '', window.location.pathname);
  if (window.parent !== window) window.parent.postMessage({ type: 'mappedin-loc', loc: null }, '*');
}

// ============================================
// Directions Panel
// ============================================
let waitingForPin = false;
// La lista di ricerca è condivisa: indica se la scelta va in "Da:" o in "A:"
let destSearchFor: "from" | "to" = "from";
const TO_PLACEHOLDER = "Scegli la destinazione";

function setupDirectionsPanelListeners() {
  document.getElementById("directions-close")!.addEventListener("click", () => {
    closeDirectionsPanel();
  });

  document.getElementById("btn-swap")!.addEventListener("click", () => {
    swapDirections();
  });

  document.getElementById("from-reset")!.addEventListener("click", () => {
    resetFromField();
  });

  document.getElementById("to-reset")!.addEventListener("click", () => {
    resetToField();
  });

  document.getElementById("from-options")!.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest(".from-option") as HTMLElement | null;
    if (!btn) return;
    handleFromOption(btn.dataset.type!, btn.dataset.entranceIdx ? parseInt(btn.dataset.entranceIdx, 10) : 0);
  });

  // Dest search
  const destInput = document.getElementById("dest-search-input") as HTMLInputElement;
  const destResults = document.getElementById("dest-search-results")!;

  function renderDestItems(query: string) {
    const items = query.length < 1
      ? [...allSearchableItems].sort((a: any, b: any) => a.name.localeCompare(b.name, 'it'))
      : allSearchableItems
        .filter((item: any) => matchesQuery(item.name, query))
        .sort((a: any, b: any) => a.name.localeCompare(b.name, 'it'));
    destResults.innerHTML = items
      .map((item: any) =>
        `<div class="search-item dest-item" data-item-id="${item.id}" data-item-type="${item._type}">
          <span class="result-dot dot-${item._isService ? 'service' : item._type}"></span>${item.name}
        </div>`
      )
      .join("");
  }

  destInput?.addEventListener("focus", () => {
    if (destInput.value.trim().length < 1) {
      renderDestItems("");
    }
  });

  destInput?.addEventListener("input", () => {
    const query = destInput.value.trim().toLowerCase();
    renderDestItems(query);
  });

  destResults.addEventListener("click", (e: Event) => {
    const target = (e.target as HTMLElement).closest(".dest-item") as HTMLElement;
    if (!target) return;

    const itemId = target.dataset.itemId;
    const itemType = target.dataset.itemType;
    const item = allSearchableItems.find((i: any) => i.id === itemId && i._type === itemType);
    if (item && destSearchFor === "to") {
      if (item._type === "annotation" && item._ref.coordinate) {
        setToDestination(null, item._ref.coordinate, item.name);
      } else {
        setToDestination(item._ref, null, item.name);
      }
      document.getElementById("directions-search-dest")!.style.display = "none";
    } else if (item) {
      if (item._type === "space") {
        setFromOrigin(item._ref);
      } else if (item._type === "annotation" && item._ref.coordinate) {
        directionFrom = null;
        fromCoord = item._ref.coordinate;
        document.getElementById("from-value")!.textContent = item.name;
        document.getElementById("from-value")!.style.display = "block";
        document.getElementById("from-options")!.style.display = "none";
        document.getElementById("from-reset")!.style.display = "inline-block";
        drawDirections();
      } else if (item._type === "door") {
        setFromOrigin(item._ref);
      } else if (item._type === "connection") {
        setFromOrigin(item._ref);
      }
      document.getElementById("directions-search-dest")!.style.display = "none";
    }
  });
}

function setFromOrigin(space: any) {
  directionFrom = space;
  fromCoord = null;
  // Rimuovi dropped pin marker se esistente
  if (droppedPinMarker && mapViewRef) {
    mapViewRef.Markers.remove(droppedPinMarker);
    droppedPinMarker = null;
  }
  document.getElementById("from-value")!.textContent = space.name;
  document.getElementById("from-value")!.style.display = "block";
  document.getElementById("from-options")!.style.display = "none";
  document.getElementById("from-reset")!.style.display = "inline-block";
  document.getElementById("dropped-pin-hint")!.style.display = "none";
  drawDirections();
}

function resetFromField() {
  directionFrom = null;
  fromCoord = null;
  waitingForPin = false;
  // Rimuovi dropped pin marker
  if (droppedPinMarker && mapViewRef) {
    mapViewRef.Markers.remove(droppedPinMarker);
    droppedPinMarker = null;
  }
  mapViewRef?.Navigation?.clear();
  closeNavStepper();
  document.getElementById("from-value")!.style.display = "none";
  document.getElementById("from-reset")!.style.display = "none";
  document.getElementById("from-options")!.style.display = "flex";
  if (destSearchFor === "from") document.getElementById("directions-search-dest")!.style.display = "none";
  document.getElementById("dropped-pin-hint")!.style.display = "none";
  document.getElementById("directions-info")!.style.display = "none";
  document.getElementById("mappedin-map")!.classList.remove("pin-cursor");
}

// Imposta "A:" (spazio/door/connection oppure coordinata di un'annotation)
function setToDestination(ref: any, coord: any, name: string) {
  directionTo = ref;
  toCoord = ref ? null : coord;
  // Evidenzia la nuova destinazione al posto della vecchia
  clearSelection();
  if (ref && allSpaces.includes(ref)) {
    selectedSpace = ref;
    mapViewRef?.updateState(ref, { interactive: true, color: "#EF8B38", hoverColor: "#D27A31" });
  }
  const tv = document.getElementById("to-value")!;
  tv.textContent = name;
  tv.classList.remove("is-placeholder");
  document.getElementById("to-reset")!.style.display = "inline-block";
  destSearchFor = "from";
  drawDirections();
}

function resetToField() {
  directionTo = null;
  toCoord = null;
  clearSelection(); // il vecchio espositore non resta evidenziato
  mapViewRef?.Navigation?.clear();
  clearDirectionMarkers();
  closeNavStepper();
  const tv = document.getElementById("to-value")!;
  tv.textContent = TO_PLACEHOLDER;
  tv.classList.add("is-placeholder");
  document.getElementById("to-reset")!.style.display = "none";
  document.getElementById("directions-info")!.style.display = "none";
  // Se "Da:" era in attesa del pin sulla mappa, annulla: ora si sceglie "A:"
  if (waitingForPin) {
    waitingForPin = false;
    document.getElementById("dropped-pin-hint")!.style.display = "none";
    document.getElementById("mappedin-map")!.classList.remove("pin-cursor");
    if (!directionFrom && !fromCoord) document.getElementById("from-options")!.style.display = "flex";
  }
  // Mostra la ricerca destinazione per sceglierne una nuova
  destSearchFor = "to";
  document.getElementById("directions-search-dest")!.style.display = "block";
  const dInput = document.getElementById("dest-search-input") as HTMLInputElement;
  dInput.value = "";
  dInput.placeholder = "Cerca destinazione...";
  if (window.innerWidth > 600) dInput.focus(); // su mobile niente tastiera automatica
  const dResults = document.getElementById("dest-search-results")!;
  dResults.innerHTML = [...allSearchableItems]
    .sort((a: any, b: any) => a.name.localeCompare(b.name, 'it'))
    .map((item: any) =>
      `<div class="search-item dest-item" data-item-id="${item.id}" data-item-type="${item._type}">
        <span class="result-dot dot-${item._isService ? 'service' : item._type}"></span>${item.name}
      </div>`)
    .join('');
  dResults.style.display = "block";
}

// Apre il pannello indicazioni partendo da un'annotation (coordinate) o una door (ref Mappedin)
function openDirectionsPanelFromCoord(item: { name: string; coordinate: any; ref: any }) {
  hideLocationPanel();
  document.getElementById("search-container")!.style.display = "none";

  const panel = document.getElementById("directions-panel")!;
  panel.style.display = "block";
  directionsActive = true;
  refreshZoomView(); // forza vista vicina (espositori), niente blocchi durante le indicazioni

  // Set "A:" con l'item selezionato (la destinazione)
  if (item.ref) {
    directionTo = item.ref;
    toCoord = null;
  } else {
    directionTo = null;
    toCoord = item.coordinate;
  }
  document.getElementById("to-value")!.textContent = item.name;
  document.getElementById("to-reset")!.style.display = "inline-block";
  document.getElementById("to-value")!.classList.remove("is-placeholder");
  destSearchFor = "from";

  // Reset "Da:" — mostra le opzioni di partenza
  resetFromField();
}

function openDirectionsPanel(space: any) {
  hideLocationPanel();
  document.getElementById("search-container")!.style.display = "none";

  const panel = document.getElementById("directions-panel")!;
  panel.style.display = "block";
  directionsActive = true;
  refreshZoomView(); // forza vista vicina (espositori), niente blocchi durante le indicazioni

  // Set "A:" con lo spazio selezionato (la destinazione)
  directionTo = space;
  toCoord = null;
  document.getElementById("to-value")!.textContent = space.name;
  document.getElementById("to-reset")!.style.display = "inline-block";
  document.getElementById("to-value")!.classList.remove("is-placeholder");
  destSearchFor = "from";

  // Reset "Da:" — mostra le opzioni di partenza
  resetFromField();
}

function closeDirectionsPanel() {
  document.getElementById("directions-panel")!.style.display = "none";
  document.getElementById("search-container")!.style.display = "block";
  document.getElementById("mappedin-map")!.classList.remove("pin-cursor");
  clearAllState();
}

function handleFromOption(type: string, entranceIdx = 0) {
  if (type === "pin") {
    // Attiva modalita dropped pin: cursore personalizzato + click sulla mappa
    waitingForPin = true;
    document.getElementById("from-options")!.style.display = "none";
    document.getElementById("dropped-pin-hint")!.style.display = "block";
    // Cambia cursore della mappa in un pin
    document.getElementById("mappedin-map")!.classList.add("pin-cursor");
  } else if (type === "entrance") {
    selectEntranceAsOrigin(entranceIdx);
  } else if (type === "search") {
    waitingForPin = false;
    destSearchFor = "from";
    (document.getElementById("dest-search-input") as HTMLInputElement).placeholder = "Cerca punto di partenza...";
    document.getElementById("from-options")!.style.display = "none";
    document.getElementById("directions-search-dest")!.style.display = "block";
    const dInput = document.getElementById("dest-search-input") as HTMLInputElement;
    dInput.value = "";
    // Mostra subito tutte le location disponibili
    const dResults = document.getElementById("dest-search-results")!;
    dResults.innerHTML = [...allSearchableItems]
      .sort((a: any, b: any) => a.name.localeCompare(b.name, 'it'))
      .map((item: any) =>
        `<div class="search-item dest-item" data-item-id="${item.id}" data-item-type="${item._type}">
          <span class="result-dot dot-${item._isService ? 'service' : item._type}"></span>${item.name}
        </div>`
      )
      .join("");
    dInput.focus();
  }
}

// ============================================
// Dropped Pin - click sulla mappa con cursore personalizzato
// ============================================
function placeDroppedPin(coordinate: any) {
  waitingForPin = false;
  fromCoord = coordinate;
  directionFrom = null;

  // Rimuovi marker precedente
  if (droppedPinMarker && mapViewRef) {
    mapViewRef.Markers.remove(droppedPinMarker);
  }

  // Aggiungi marker pin sulla mappa
  const pinHtml = `
    <div style="display:flex;flex-direction:column;align-items:center;">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="#22cc44" stroke="#fff" stroke-width="1">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
        <circle cx="12" cy="10" r="3" fill="#fff"/>
      </svg>
    </div>
  `;
  droppedPinMarker = mapViewRef.Markers.add(coordinate, pinHtml);

  // Aggiorna UI
  document.getElementById("from-value")!.textContent = "Punto sulla mappa";
  document.getElementById("from-value")!.style.display = "block";
  document.getElementById("from-options")!.style.display = "none";
  document.getElementById("from-reset")!.style.display = "inline-block";
  document.getElementById("dropped-pin-hint")!.style.display = "none";
  document.getElementById("mappedin-map")!.classList.remove("pin-cursor");

  drawDirections();
}

// ============================================
// Ingressi come punto di partenza (uno o più padiglioni)
// ============================================
function selectEntranceAsOrigin(idx: number) {
  const ent = entranceList[idx];
  if (!ent) return;
  if (ent.coordinate) {
    directionFrom = null;
    fromCoord = ent.coordinate;
  } else if (ent.ref) {
    directionFrom = ent.ref;
    fromCoord = null;
  } else {
    return;
  }
  const fv = document.getElementById("from-value")!;
  fv.textContent = ent.name.toUpperCase();
  fv.style.display = "block";
  document.getElementById("from-options")!.style.display = "none";
  document.getElementById("from-reset")!.style.display = "inline-block";
  drawDirections();
}

// ============================================
// Swap
// ============================================
function swapDirections() {
  const tempFrom = directionFrom;
  const tempFromCoord = fromCoord;
  const tempTo = directionTo;
  const tempToCoord = toCoord;

  directionFrom = tempTo;
  fromCoord = tempToCoord;
  directionTo = tempFrom;
  toCoord = tempFromCoord;

  // Aggiorna UI: scambia i nomi mostrati (ingressi/annotation non hanno .name sul ref)
  const fv = document.getElementById("from-value")!;
  const tv = document.getElementById("to-value")!;
  const oldFromName = fv.style.display !== "none" ? fv.textContent : "";
  const oldToName = tv.classList.contains("is-placeholder") ? "" : tv.textContent;
  const fromName = oldToName || directionFrom?.name || (fromCoord ? "Punto sulla mappa" : "—");
  const toName = oldFromName || directionTo?.name || (toCoord ? "Punto sulla mappa" : TO_PLACEHOLDER);

  document.getElementById("from-value")!.textContent = fromName;
  document.getElementById("to-value")!.textContent = toName;
  document.getElementById("to-value")!.classList.toggle("is-placeholder", !directionTo && !toCoord);
  document.getElementById("to-reset")!.style.display = (directionTo || toCoord) ? "inline-block" : "none";

  if (directionFrom || fromCoord) {
    document.getElementById("from-value")!.style.display = "block";
    document.getElementById("from-options")!.style.display = "none";
    document.getElementById("from-reset")!.style.display = "inline-block";
  } else {
    document.getElementById("from-value")!.style.display = "none";
    document.getElementById("from-options")!.style.display = "flex";
    document.getElementById("from-reset")!.style.display = "none";
  }

  // Ricalcola direzioni
  if ((directionFrom || fromCoord) && (directionTo || toCoord)) {
    drawDirections();
  }
}

// ============================================
// Step-by-step navigation helpers
// ============================================

// Distribuisce punti equidistanti lungo il percorso (coordinate dalle istruzioni)
// Ogni ~10m crea un checkpoint. Lo stepper mostra solo il pin e avanti/indietro.
function buildNavSteps(directions: any, fromName: string, toName: string): typeof navSteps {
  const steps: typeof navSteps = [];
  const instructions = directions.instructions || [];
  const totalDist = directions.distance || 0;

  // Estrai tutte le coordinate con distanza cumulativa
  const coords: { coord: any; cumDist: number }[] = [];
  let cum = 0;
  for (const ins of instructions) {
    if (ins.coordinate) {
      coords.push({ coord: ins.coordinate, cumDist: cum });
      cum += (ins.distance || 0);
    }
  }

  if (coords.length === 0) {
    steps.push({ action: 'departure', text: `Partenza: ${fromName}`, coordinate: null, distance: 0 });
    steps.push({ action: 'arrival', text: `Arrivo: ${toName}`, coordinate: null, distance: totalDist });
    return steps;
  }

  // Partenza
  steps.push({ action: 'departure', text: `Partenza: ${fromName}`, coordinate: coords[0].coord, distance: 0 });

  // Punti intermedi: uno ogni ~10m (min 1, max ~8 per non averne troppi)
  const STEP_INTERVAL = Math.max(10, totalDist / 8);
  let nextThreshold = STEP_INTERVAL;
  for (let i = 1; i < coords.length - 1; i++) {
    if (coords[i].cumDist >= nextThreshold) {
      const remaining = Math.round(totalDist - coords[i].cumDist);
      steps.push({
        action: 'waypoint',
        text: `${Math.round(coords[i].cumDist)}m percorsi · ${remaining}m rimanenti`,
        coordinate: coords[i].coord,
        distance: Math.round(coords[i].cumDist - (steps[steps.length - 1]?.distance || 0)),
      });
      nextThreshold = coords[i].cumDist + STEP_INTERVAL;
    }
  }

  // Arrivo
  steps.push({
    action: 'arrival',
    text: `Arrivo: ${toName}`,
    coordinate: coords[coords.length - 1].coord,
    distance: totalDist,
  });

  return steps;
}

// Aggiorna l'UI dello stepper (pannello in basso) — solo pin + avanti/indietro
function updateNavStepperUI() {
  const panel = document.getElementById('nav-stepper');
  if (!panel || navSteps.length === 0) return;

  const step = navSteps[navCurrentStep];
  const total = navSteps.length;
  const isFirst = navCurrentStep === 0;
  const isLast = navCurrentStep === total - 1;
  const lower = (step.action || '').toLowerCase();

  // Icona
  let icon: string;
  if (lower === 'departure') {
    icon = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#881814" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="#881814"/></svg>`;
  } else if (lower === 'arrival') {
    icon = `<svg viewBox="0 0 24 24" width="24" height="24" fill="#881814" stroke="#fff" stroke-width="1"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="#fff"/></svg>`;
  } else {
    icon = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#881814" stroke-width="2.5"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="#881814"/></svg>`;
  }

  panel.innerHTML = `
    <div id="nav-step-content">
      <div id="nav-step-icon">${icon}</div>
      <div id="nav-step-info">
        <div id="nav-step-text">${step.text}</div>
        <div id="nav-step-meta">Passo ${navCurrentStep + 1} di ${total}</div>
      </div>
    </div>
    <div id="nav-step-progress">
      ${navSteps.map((_, i) => `<div class="nav-dot${i === navCurrentStep ? ' active' : ''}${i < navCurrentStep ? ' done' : ''}"></div>`).join('')}
    </div>
    <div id="nav-step-actions">
      <button id="nav-prev" ${isFirst ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        Indietro
      </button>
      <button id="nav-here" class="${isLast ? 'nav-arrived' : ''}">
        ${isLast ? 'Chiudi' : 'Avanti'}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;

  // Event listeners
  document.getElementById('nav-prev')?.addEventListener('click', () => navigateStep(-1));
  document.getElementById('nav-here')?.addEventListener('click', () => {
    if (isLast) {
      // Traccia il completamento della navigazione
      const toName = document.getElementById("to-value")?.textContent?.trim()
        || navSteps[navSteps.length - 1]?.text || 'destinazione';
      trackEvent('nav_completed', {
        to_name: toName,
        steps_total: navSteps.length,
      });
      closeNavStepper();
    } else {
      navigateStep(1);
    }
  });
}

// Vai allo step precedente/successivo
function navigateStep(delta: number) {
  const newStep = navCurrentStep + delta;
  if (newStep < 0 || newStep >= navSteps.length) return;
  navCurrentStep = newStep;
  updateNavStepperUI();
  focusOnCurrentStep();
}

// Focalizza la camera sullo step corrente
function focusOnCurrentStep() {
  if (!mapViewRef) return;
  const step = navSteps[navCurrentStep];
  if (step?.coordinate) {
    // Rimuovi marker precedente
    if (navStepMarker) {
      try { mapViewRef.Markers.remove(navStepMarker); } catch { }
      navStepMarker = null;
    }
    // Aggiungi marker "sei qui" pulsante
    if (navCurrentStep > 0 && navCurrentStep < navSteps.length - 1) {
      const markerHtml = `<div style="display:flex;align-items:center;justify-content:center;">
        <div style="width:18px;height:18px;border-radius:50%;background:#881814;border:3px solid #fff;box-shadow:0 0 0 3px rgba(136,24,20,0.3),0 2px 8px rgba(0,0,0,0.3);"></div>
      </div>`;
      navStepMarker = mapViewRef.Markers.add(step.coordinate, markerHtml, { rank: "always-visible" });
    }
    mapViewRef.Camera.focusOn(step.coordinate, { duration: 500 });
    // Zoom ravvicinato
    setTimeout(() => {
      if (!mapViewRef?.Camera) return;
      const cam = mapViewRef.Camera as any;
      const z = cam.zoom ?? cam.zoomLevel ?? cam.distance;
      if (typeof z === 'number' && z > 0) cam.set({ zoom: z * 1.8, duration: 400 });
    }, 600);
  }
}

// Mostra il pannello stepper
// @ts-expect-error riservata per uso futuro
function showNavStepper(directions: any, fromName: string, toName: string) {
  navSteps = buildNavSteps(directions, fromName, toName);
  navCurrentStep = 0;

  let panel = document.getElementById('nav-stepper');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'nav-stepper';
    document.body.appendChild(panel);
  }
  panel.style.display = 'block';
  updateNavStepperUI();

  // Nascondi il pannello direzioni completo e mostra la barra compatta
  const dirPanel = document.getElementById('directions-panel');
  if (dirPanel) dirPanel.style.display = 'none';
  showNavSummaryBar(fromName, toName);

  // Focus sul primo step dopo un breve delay (lascia che la mappa disegni il percorso)
  setTimeout(() => focusOnCurrentStep(), 800);
}

// Barra compatta in alto durante la navigazione
function showNavSummaryBar(fromName: string, toName: string) {
  let bar = document.getElementById('nav-summary-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'nav-summary-bar';
    document.body.appendChild(bar);
  }

  const dist = document.getElementById("directions-distance")?.textContent || '';
  const time = document.getElementById("directions-time")?.textContent || '';

  bar.innerHTML = `
    <div id="nav-summary-collapsed">
      <div id="nav-summary-route">
        <span class="nav-summary-dot from"></span>
        <span class="nav-summary-name">${fromName}</span>
        <svg class="nav-summary-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#888" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>
        <span class="nav-summary-dot to"></span>
        <span class="nav-summary-name">${toName}</span>
      </div>
      <div id="nav-summary-actions">
        <button id="nav-summary-toggle" title="Dettagli percorso">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button id="nav-summary-close" title="Chiudi navigazione">&times;</button>
      </div>
    </div>
    <div id="nav-summary-expanded" style="display:none;">
      <div class="nav-summary-detail-row">
        <span class="nav-summary-dot from"></span>
        <div class="nav-summary-detail">
          <span class="nav-summary-label">Da:</span>
          <span class="nav-summary-value">${fromName}</span>
        </div>
      </div>
      <div class="nav-summary-detail-row">
        <span class="nav-summary-dot to"></span>
        <div class="nav-summary-detail">
          <span class="nav-summary-label">A:</span>
          <span class="nav-summary-value">${toName}</span>
        </div>
      </div>
      ${dist || time ? `<div class="nav-summary-info">${dist}${dist && time ? ' · ' : ''}${time}</div>` : ''}
    </div>
  `;
  bar.style.display = 'block';
  bar.classList.remove('expanded');

  // Event listeners
  document.getElementById('nav-summary-toggle')?.addEventListener('click', () => {
    const expanded = document.getElementById('nav-summary-expanded')!;
    const chevron = document.querySelector('#nav-summary-toggle svg') as SVGElement;
    if (bar!.classList.contains('expanded')) {
      bar!.classList.remove('expanded');
      expanded.style.display = 'none';
      chevron.style.transform = '';
    } else {
      bar!.classList.add('expanded');
      expanded.style.display = 'block';
      chevron.style.transform = 'rotate(180deg)';
    }
  });

  document.getElementById('nav-summary-close')?.addEventListener('click', () => {
    closeNavStepper();
    closeDirectionsPanel();
  });
}

function hideNavSummaryBar() {
  const bar = document.getElementById('nav-summary-bar');
  if (bar) {
    bar.style.display = 'none';
    bar.classList.remove('expanded');
  }
}

// Chiudi il pannello stepper
function closeNavStepper() {
  navSteps = [];
  navCurrentStep = 0;
  if (navStepMarker && mapViewRef) {
    try { mapViewRef.Markers.remove(navStepMarker); } catch { }
    navStepMarker = null;
  }
  const panel = document.getElementById('nav-stepper');
  if (panel) panel.style.display = 'none';

  // Rimuovi barra compatta e ripristina pannello direzioni
  hideNavSummaryBar();
  const dirPanel = document.getElementById('directions-panel');
  if (dirPanel && directionsActive) dirPanel.style.display = 'block';
}

// ============================================
// Draw Directions - con createMarkers custom per evitare icona scala
// ============================================
async function drawDirections() {
  if (!mapViewRef || !mapDataRef) return;

  const from = directionFrom || fromCoord;
  const to = directionTo || toCoord;

  if (!from || !to) return;

  // Pulisci navigazione precedente e marker direzioni
  mapViewRef.Navigation.clear();
  clearDirectionMarkers();

  try {
    const directions = await mapDataRef.getDirections(from, to, { smoothing: true });

    if (directions) {
      // Traccia il percorso richiesto (GA4)
      const gaFromName = document.getElementById("from-value")?.textContent?.trim() || directionFrom?.name || 'Punto selezionato';
      const gaToName = document.getElementById("to-value")?.textContent?.trim() || directionTo?.name || 'Punto selezionato';
      trackEvent('route_started', {
        from_name: gaFromName,
        to_name: gaToName,
        distance_m: Math.round(directions.distance || 0),
      });

      // NON disegnare il percorso — mostra solo marker partenza (omino) e arrivo (bandierina)
      const fromName = gaFromName;
      const toName = gaToName;

      // Marker partenza: omino verde
      const startMarkerHtml = `
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div class="dir-marker-blink" style="background:#22a84b;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2.5px solid white;animation:dir-marker-blink 1.6s ease-in-out infinite;">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #22a84b;margin-top:-1px;"></div>
          <div style="background:#22a84b;color:white;padding:3px 8px 2px 8px;border-radius:4px;font-family:'Onest',sans-serif;white-space:nowrap;margin-top:2px;box-shadow:0 1px 4px rgba(0,0,0,0.2);max-width:140px;overflow:hidden;text-overflow:ellipsis;text-align:center;line-height:1.15;">
            <div style="font-size:9px;font-weight:800;letter-spacing:0.5px;opacity:0.95;">IO SONO QUI</div>
            <div style="font-size:10px;font-weight:700;">${fromName}</div>
          </div>
        </div>`;

      // Marker arrivo: bandierina rossa
      const endMarkerHtml = `
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div class="dir-marker-blink" style="background:#d62828;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2.5px solid white;animation:dir-marker-blink 1.6s ease-in-out infinite;">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>
            </svg>
          </div>
          <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #d62828;margin-top:-1px;"></div>
          <div style="background:#d62828;color:white;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;font-family:'Onest',sans-serif;white-space:nowrap;margin-top:2px;box-shadow:0 1px 4px rgba(0,0,0,0.2);max-width:120px;overflow:hidden;text-overflow:ellipsis;">${toName}</div>
        </div>`;

      // Posiziona marker sulla mappa.
      // Connection (stairway/elevator) ha .coordinates[] ma NON .center → estrai esplicitamente
      // la coordinata, altrimenti Markers.add fallisce silenziosamente.
      const resolveMarkerTarget = (t: any): any => {
        if (!t) return null;
        if (typeof t.latitude === 'number') return t; // già una Coordinate
        if (t.center) return t; // Space/Door: SDK gestisce
        if (t.coordinates && t.coordinates[0]) return t.coordinates[0]; // Connection
        if (t.coordinate) return t.coordinate; // Annotation
        return t;
      };
      const fromTarget = resolveMarkerTarget(directionFrom || fromCoord);
      const toTarget = resolveMarkerTarget(directionTo || toCoord);
      directionStartMarker = mapViewRef.Markers.add(fromTarget, startMarkerHtml, { rank: "always-visible" });
      directionEndMarker = mapViewRef.Markers.add(toTarget, endMarkerHtml, { rank: "always-visible" });

      // Zoom per mostrare entrambi i marker a schermo intero
      // Zoom fluido: focusOn centra sui target, poi animateTo allarga dolcemente la vista
      const focusTargets: any[] = [];
      if (directionFrom) focusTargets.push(directionFrom);
      if (fromCoord) focusTargets.push(fromCoord);
      if (directionTo) focusTargets.push(directionTo);
      if (toCoord) focusTargets.push(toCoord);

      if (focusTargets.length >= 1) {
        // Calcola le coordinate geografiche dei target
        const coords: { latitude: number; longitude: number }[] = [];
        focusTargets.forEach((t: any) => {
          const c = t.center
            || (t.coordinates && t.coordinates[0])
            || t.coordinate
            || t;
          if (c && typeof c.latitude === 'number') coords.push(c);
        });

        setTimeout(() => {
          if (coords.length >= 2) {
            // Inquadra TUTTA la piantina (un solo movimento), lasciando libero lo spazio
            // del pannello indicazioni: a sinistra su desktop, in basso su mobile.
            const panel = document.getElementById("directions-panel")?.getBoundingClientRect();
            const mobile = window.innerWidth <= 600;
            const pad = 16;
            mapViewRef.Camera.focusOn(allSpaces, {
              duration: 800,
              screenOffsets: {
                top: mobile ? pad : 70,
                bottom: mobile && panel ? window.innerHeight - panel.top + pad : pad,
                left: !mobile && panel ? panel.right + pad : pad,
                right: pad,
              },
            });
          } else {
            mapViewRef.Camera.animateTo(
              { center: coords[0], zoomLevel: 19.5 },
              { duration: 600 }
            );
          }
        }, 200);
      }

      // Nascondi solo le info distanza/tempo (il pannello direzioni resta visibile per permettere di chiudere)
      document.getElementById("directions-info")!.style.display = "none";

    } else {
      document.getElementById("directions-info")!.innerHTML =
        '<div style="color:#cc3333;padding:0;">Nessun percorso trovato</div>';
      document.getElementById("directions-info")!.style.display = "flex";
    }
  } catch (err) {
    console.error("Errore nel calcolo delle direzioni:", err);
  }
}

function clearDirectionMarkers() {
  if (directionStartMarker && mapViewRef) {
    try { mapViewRef.Markers.remove(directionStartMarker); } catch { }
    directionStartMarker = null;
  }
  if (directionEndMarker && mapViewRef) {
    try { mapViewRef.Markers.remove(directionEndMarker); } catch { }
    directionEndMarker = null;
  }
}

// ============================================
// CSS Styles
// ============================================
function injectStyles() {
  // Google Fonts: Onest già caricato via <link> in index.html (no duplicato qui)
  const style = document.createElement("style");
  style.textContent = `* { font-family: 'Onest', sans-serif; }

    #ui-container {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1000;
      pointer-events: none;
    }

    #ui-container > * {
      pointer-events: auto;
    }

    /* Search */
    #search-container {
      position: fixed;
      top: 16px;
      left: 16px;
      width: 340px;
      z-index: 1001;
    }

    #search-box {
      display: flex;
      align-items: center;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.15);
      padding: 10px 14px;
      gap: 10px;
    }

    #search-icon {
      flex-shrink: 0;
    }

    #search-input {
      flex: 1;
      border: none;
      outline: none;
      font-size: 15px;
      font-family: 'Onest', sans-serif;
      background: transparent;
      color: #54595F;
    }

    #search-input::placeholder {
      color: #aaa;
    }

    #search-clear {
      background: none;
      border: none;
      font-size: 20px;
      color: #999;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }

    #search-mode-header {
      background: #f8f8f8;
      border-radius: 8px 8px 0 0;
      box-shadow: 0 2px 12px rgba(0,0,0,0.12);
      margin-top: 2px;
      border-bottom: 1px solid #e8f4ff;
    }

    #search-results {
      background: #fff;
      border-radius: 0 0 8px 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      max-height: 280px;
      overflow-y: auto;
      margin-top: 0;
    }

    .search-item {
      padding: 12px 16px;
      cursor: pointer;
      font-size: 14px;
      color: #54595F;
      font-family: 'Onest', sans-serif;
      border-bottom: 1px solid #f0f0f0;
      transition: background 0.15s;
      text-transform: uppercase;
    }

    .search-item:hover {
      background: #e8f4ff;
    }

    .search-item.no-results {
      color: #999;
      cursor: default;
    }

    .search-item.no-results:hover {
      background: transparent;
    }

    /* Location Panel */
    #location-panel {
      position: fixed;
      top: 76px;
      left: 16px;
      width: 340px;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.15);
      overflow: hidden;
      font-family: 'Onest', sans-serif;
      z-index: 1001;
    }

    #location-header {
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid #eee;
    }

    #location-title {
      flex: 1;
      min-width: 0;
    }

    #location-header h3 {
      margin: 0;
      font-size: 17px;
      color: #54595F;
      text-transform: uppercase;
    }

    #location-stand {
      margin-top: 3px;
      font-size: 13px;
      font-weight: 700;
      color: #881814;
      letter-spacing: 0.3px;
    }

    #location-close {
      background: none;
      border: none;
      font-size: 22px;
      color: #999;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      order: 2;
    }

    #location-actions {
      padding: 12px 20px;
    }

    /* Drag handle hidden on desktop */
    #location-drag-handle { display: none; }

    /* Photos carousel */
    #location-photos {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      background: #f0f0f0;
      overflow: hidden;
      border-radius: 14px 14px 0 0;
    }
    #location-photo-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .photo-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(136,24,20,0.85);
      color: #fff;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
      transition: background 0.2s;
    }
    .photo-nav:hover { background: rgba(136,24,20,1); }
    #location-photo-prev { left: 8px; }
    #location-photo-next { right: 8px; }
    #location-close-photos {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(136,24,20,0.85);
      color: #fff;
      border: none;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      z-index: 2;
    }
    #location-close-photos:hover { background: rgba(136,24,20,1); }

    /* Logo in header */
    #location-logo {
      width: 36px;
      height: 36px;
      border-radius: 6px;
      object-fit: contain;
      background: #fff;
      border: 1px solid #eee;
      flex-shrink: 0;
    }

    /* Description */
    #location-description {
      padding: 4px 20px 12px;
      font-size: 13px;
      color: #54595F;
      line-height: 1.4;
    }

    /* Info rows */
    #location-info {
      padding: 0 8px;
    }
    .info-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 12px;
      color: #54595F;
      text-decoration: none;
      font-size: 13px;
      border-top: 1px solid #f0f0f0;
      transition: background 0.15s;
    }
    .info-row:hover { background: #f7fbfe; }
    .info-icon {
      color: #881814;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .info-text {
      flex: 1;
      word-break: break-word;
    }
    .info-socials {
      display: flex;
      gap: 14px;
    }
    .info-social-link {
      color: #881814;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s;
    }
    .info-social-link:hover { color: #0e5a91; }

    .action-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 12px 16px;
      background: #881814;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: 'Onest', sans-serif;
      transition: background 0.2s;
      justify-content: center;
    }

    .action-btn:hover {
      background: #701410;
    }

    /* Directions Panel */
    #directions-panel {
      position: fixed;
      top: 16px;
      left: 16px;
      width: 340px;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.15);
      overflow: visible;
      font-family: 'Onest', sans-serif;
      z-index: 1002;
    }

    #directions-header {
      padding: 14px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid #eee;
    }

    #directions-header h3 {
      margin: 0;
      font-size: 16px;
      color: #54595F;
      flex: 1;
    }

    #directions-close {
      background: none;
      border: none;
      font-size: 22px;
      color: #999;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      order: 2;
    }

    #directions-form {
      padding: 16px 20px;
    }

    #directions-fields {
      display: flex;
      flex-direction: column;
      gap: 8px;
      position: relative;
    }

    .direction-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .direction-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-top: 6px;
      flex-shrink: 0;
    }

    .from-dot {
      background: #22cc44;
      box-shadow: 0 0 0 3px rgba(34,204,68,0.2);
    }

    .to-dot {
      background: #ff4444;
      box-shadow: 0 0 0 3px rgba(255,68,68,0.2);
    }

    .direction-field {
      flex: 1;
    }

    .direction-field label {
      font-size: 11px;
      color: #888;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .field-value {
      display: block;
      font-size: 15px;
      color: #54595F;
      margin-top: 2px;
      font-weight: 500;
      text-transform: uppercase;
    }

    .field-value.is-placeholder {
      color: #aaa;
      font-size: 13px;
      font-weight: 400;
      text-transform: none;
    }

    #to-reset {
      background: none;
      border: none;
      color: #881814;
      font-size: 12px;
      cursor: pointer;
      padding: 2px 0;
      font-family: 'Onest', sans-serif;
      text-decoration: underline;
    }

    #btn-swap {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      background: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 50%;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
      padding: 0;
    }

    #btn-swap:hover {
      background: #eee;
      border-color: #ccc;
    }

    #from-options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 6px;
    }

    /* Prima riga: ingresso/i + cerca affiancati; sotto "scegli sulla mappa" */
    #from-top-row {
      display: flex;
      flex-direction: row;
      gap: 6px;
    }
    #from-top-row > .from-option[data-type="search"] {
      flex: 1 1 0;
      min-width: 0;
      justify-content: center;
      text-align: center;
      font-size: 12px;
      padding: 10px 8px;
      line-height: 1.15;
    }
    #from-entrance-list {
      display: flex;
      flex: 1 1 0;
      min-width: 0;
      flex-direction: row;
      gap: 6px;
      flex-wrap: wrap;
    }
    #from-entrance-list .from-option {
      flex: 1 1 0;
      min-width: 0;
      justify-content: center;
      text-align: center;
      font-size: 12px;
      padding: 10px 8px;
      line-height: 1.15;
    }

    #from-reset {
      background: none;
      border: none;
      color: #881814;
      font-size: 12px;
      cursor: pointer;
      padding: 2px 0;
      font-family: 'Onest', sans-serif;
      text-decoration: underline;
    }

    .from-option,
    .to-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: #f8f8f8;
      border: 1px solid #e8e8e8;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      color: #444;
      font-family: 'Onest', sans-serif;
      transition: all 0.15s;
    }

    .from-option:hover,
    .to-option:hover {
      background: #e3eff8;
      border-color: #881814;
      color: #881814;
    }

    /* Directions Info */
    #directions-info {
      padding: 12px 20px;
      border-top: 1px solid #eee;
      display: flex;
      gap: 20px;
    }

    #directions-distance,
    #directions-time {
      font-size: 13px;
      color: #54595F;
    }

    /* Dest Search */
    #directions-search-dest {
      padding: 0 20px 16px;
    }

    #dest-search-input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 14px;
      font-family: 'Onest', sans-serif;
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }

    #dest-search-input:focus {
      border-color: #881814;
    }

    #dest-search-results {
      max-height: 220px;
      overflow-y: auto;
      margin-top: 4px;
    }

    .dest-item {
      padding: 10px 12px;
      cursor: pointer;
      font-size: 13px;
      color: #54595F;
      border-bottom: 1px solid #f0f0f0;
      transition: background 0.15s;
    }

    .dest-item:hover {
      background: #e8f4ff;
    }

    /* Dropped Pin Hint */
    #dropped-pin-hint {
      padding: 10px 20px 16px;
    }

    .hint-content {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: #e3eff8;
      border-radius: 8px;
      font-size: 13px;
      color: #881814;
    }

    /* Pin Cursor - cursore personalizzato quando si posiziona il dropped pin */
    #mappedin-map.pin-cursor,
    #mappedin-map.pin-cursor * {
      cursor: ${PIN_CURSOR_SVG} !important;
    }

    /* Nomi espositori nascosti finché non si zooma abbastanza (.map-names-visible via JS);
       i servizi (.marker-label-svc) mostrano sempre il nome. */
    .marker-label-text {
      display: none;
      text-transform: uppercase;
    }
    #mappedin-map.map-names-visible .marker-label-text,
    .marker-label-text.marker-label-svc {
      display: block;
    }
    #mappedin-map.map-directions:not(.map-names-visible) .marker-stand-num {
      display: none !important; /* batte il display:flex inline */
    }

    /* Nascondi attributions Mappedin (DOM) */
    .mappedin-ctrl-attrib,
    .mappedin-ctrl-attrib-bottom-right,
    [class*="mappedin-ctrl-attrib"] {
      opacity: 0 !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }

    /* Copri il logo Mappedin renderizzato nel canvas (bottom-left) */
    #mappedin-logo-cover {
      position: fixed;
      bottom: 0;
      left: 0;
      width: 320px;
      height: 46px;
      background: #f5f5f5;
      z-index: 100;
      pointer-events: none;
    }

    /* Logo custom T2000 */
    #custom-logo {
      position: fixed;
      bottom: 14px;
      left: 14px;
      z-index: 9999;
      display: block;
      text-decoration: none;
      background: rgba(255,255,255,0.92);
      border-radius: 8px;
      padding: 5px 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      transition: box-shadow 0.2s, transform 0.2s;
    }

    #custom-logo:hover {
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      transform: translateY(-1px);
    }

    #custom-logo-label {
      display: block;
      text-align: center;
      font-weight: bold;
      font-size: 16px;
      color: #005461;
      margin-top: 4px;
      letter-spacing: 1px;
      white-space: nowrap;
    }

    #custom-logo img {
      height: 52px;
      width: auto;
      display: block;
    }

    /* Banner filtro merceologia attivo */
    #tag-filter-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
      padding: 8px 12px;
      background: #fff5ef;
      border: 1.5px solid #881814;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      color: #881814;
      font-family: 'Onest', sans-serif;
    }

    #tag-filter-clear {
      background: none;
      border: none;
      color: #881814;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Onest', sans-serif;
      white-space: nowrap;
    }
    #tag-filter-clear:hover {
      background: #ffe5d4;
    }

    /* Toggle modalità ricerca */
    .search-mode-toggle {
      display: flex;
      gap: 0;
      padding: 8px 12px 6px;
      background: #f8f8f8;
      border-bottom: 1px solid #e8f4ff;
    }

    .mode-btn {
      flex: 1;
      padding: 6px 10px;
      border: 1.5px solid #ddd;
      background: #fff;
      font-size: 12px;
      font-weight: 600;
      color: #888;
      cursor: pointer;
      font-family: 'Onest', sans-serif;
      transition: all 0.15s;
    }
    .mode-btn:first-child {
      border-radius: 6px 0 0 6px;
    }
    .mode-btn:not(:last-child) {
      border-right: none;
    }
    .mode-btn:last-child {
      border-radius: 0 6px 6px 0;
    }
    .mode-btn-mid {
      border-radius: 0;
    }
    .mode-btn.active {
      background: #881814;
      border-color: #881814;
      color: #fff;
    }
    .mode-btn.active-servizi {
      background: #005461;
      border-color: #005461;
    }
    .mode-btn:hover:not(.active) {
      background: #f0f0f0;
      color: #555;
    }

    /* Dot colorati nei risultati di ricerca */
    .result-dot {
      display: inline-block;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      margin-right: 8px;
      flex-shrink: 0;
      vertical-align: middle;
      position: relative;
      top: -1px;
    }

    .dot-space {
      background: #881814 !important;
    }

    .dot-annotation {
      background: #005461 !important;
    }

    .dot-door {
      background: #005461 !important;
    }

    .dot-tag {
      background: #881814;
      border-radius: 3px;
    }

    .dot-service {
      background: #005461 !important;
    }

    .search-item {
      display: flex;
      align-items: center;
    }

    .tag-result {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tag-label {
      flex: 1;
      font-weight: 700;
      font-size: 13px;
      color: #333;
    }

    .tag-expand-btn {
      background: none;
      border: 1.5px solid #881814;
      border-radius: 4px;
      color: #881814;
      cursor: pointer;
      padding: 2px 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-left: 6px;
      transition: background 0.15s, color 0.15s;
      line-height: 1;
    }

    .tag-expand-btn:hover {
      background: #881814;
      color: #fff;
    }

    .tag-badge {
      font-size: 11px;
      color: #fff;
      background: #881814;
      padding: 2px 7px;
      border-radius: 10px;
      white-space: nowrap;
      font-weight: 600;
    }

    .espositori-item,
    .servizi-item {
      font-size: 12px;
    }

    .espositori-name {
      flex: 1;
    }

    .stand-badge {
      font-size: 10px;
      color: #881814;
      background: #fff;
      border: 1.5px solid #881814;
      padding: 2px 6px;
      border-radius: 10px;
      white-space: nowrap;
      font-weight: 600;
      margin-left: 6px;
      flex-shrink: 0;
    }

    .tag-location-item {
      padding-left: 28px !important;
      font-size: 13px;
      color: #444;
      border-left: 3px solid #881814;
      margin-left: 12px;
    }
    .tag-location-item:hover {
      background: #fff5ef !important;
    }

    .search-section-header {
      padding: 6px 16px 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #881814;
      background: #f4f9fd;
      border-bottom: 1px solid #e8f4ff;
    }

    /* Copy link button */
    .copy-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 16px;
      background: transparent;
      color: #881814;
      border: 1.5px solid #881814;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: 'Onest', sans-serif;
      transition: all 0.2s;
      justify-content: center;
      margin-top: 8px;
      box-sizing: border-box;
    }

    .copy-btn:hover {
      background: #e3eff8;
    }

    .copy-btn.copied {
      background: #881814;
      color: #fff;
      border-color: #881814;
    }

    /* Step-by-step Navigation Stepper */
    #nav-stepper {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: #fff;
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -4px 24px rgba(0,0,0,0.15);
      z-index: 10000;
      padding: 16px 20px calc(16px + env(safe-area-inset-bottom, 0px));
      font-family: 'Onest', sans-serif;
      display: none;
    }

    #nav-step-content {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 12px;
    }

    #nav-step-icon {
      flex-shrink: 0;
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: #e8f4ff;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #nav-step-info {
      flex: 1;
      min-width: 0;
    }

    #nav-step-text {
      font-size: 16px;
      font-weight: 600;
      color: #333;
      line-height: 1.3;
    }

    #nav-step-meta {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }

    #nav-step-progress {
      display: flex;
      gap: 4px;
      margin-bottom: 14px;
      padding: 0 2px;
    }

    .nav-dot {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: #e0e0e0;
      transition: background 0.3s;
    }

    .nav-dot.active {
      background: #881814;
    }

    .nav-dot.done {
      background: #7ebce6;
    }

    #nav-step-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    #nav-prev, #nav-next {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      border: 1.5px solid #ddd;
      background: #f8f8f8;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #555;
      transition: all 0.15s;
      flex-shrink: 0;
      padding: 0;
    }

    #nav-prev:hover:not(:disabled), #nav-next:hover:not(:disabled) {
      background: #e8f4ff;
      border-color: #881814;
      color: #881814;
    }

    #nav-prev:disabled, #nav-next:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    #nav-here {
      flex: 1;
      padding: 12px 16px;
      background: #881814;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      font-family: 'Onest', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.2s;
    }

    #nav-here:hover {
      background: #701410;
    }

    #nav-here.nav-arrived {
      background: #22cc44;
    }

    #nav-here.nav-arrived:hover {
      background: #1da838;
    }

    /* ===== NAV SUMMARY BAR: barra compatta durante la navigazione ===== */
    #nav-summary-bar {
      position: fixed;
      top: 8px;
      left: 8px;
      right: 8px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.15);
      z-index: 1002;
      font-family: 'Onest', sans-serif;
      display: none;
      overflow: hidden;
    }

    #nav-summary-collapsed {
      display: flex;
      align-items: center;
      padding: 10px 12px;
      gap: 8px;
    }

    #nav-summary-route {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
    }

    .nav-summary-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .nav-summary-dot.from {
      background: #22cc44;
    }
    .nav-summary-dot.to {
      background: #ff4444;
    }

    .nav-summary-name {
      font-size: 13px;
      font-weight: 500;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 120px;
    }

    .nav-summary-arrow {
      flex-shrink: 0;
    }

    #nav-summary-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    #nav-summary-toggle {
      background: none;
      border: 1px solid #e0e0e0;
      border-radius: 50%;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #666;
      padding: 0;
      transition: all 0.2s;
    }
    #nav-summary-toggle:hover {
      background: #f0f0f0;
      border-color: #ccc;
    }
    #nav-summary-toggle svg {
      transition: transform 0.25s;
    }

    #nav-summary-close {
      background: none;
      border: none;
      font-size: 20px;
      color: #999;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #nav-summary-close:hover {
      color: #cc3333;
    }

    #nav-summary-expanded {
      padding: 0 14px 12px;
      border-top: 1px solid #f0f0f0;
    }

    .nav-summary-detail-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0 0;
    }

    .nav-summary-detail {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .nav-summary-label {
      font-size: 10px;
      color: #888;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .nav-summary-value {
      font-size: 13px;
      font-weight: 500;
      color: #333;
    }

    .nav-summary-info {
      font-size: 12px;
      color: #666;
      padding: 6px 0 0 16px;
    }

    /* ===== MOBILE RESPONSIVE ===== */
    @media (max-width: 600px) {
      /* Pannello direzioni: ancora in basso su mobile (evita sovrapposizione con logo+tappa in alto) */
      #directions-panel {
        width: calc(100% - 16px) !important;
        left: 8px !important;
        right: 8px !important;
        top: auto !important;
        bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
        max-height: calc(100vh - 80px);
        overflow-y: auto;
      }

      /* Search container su mobile */
      #search-container {
        width: calc(100% - 16px) !important;
        left: 8px !important;
      }

      /* Location panel: popup card flottante con margini (mobile) */
      #location-panel {
        width: calc(100% - 24px) !important;
        left: 12px !important;
        right: 12px !important;
        top: auto !important;
        /* sopra i controlli Mappedin in basso (widget accessibilità sx + keyhole dx) */
        bottom: calc(64px + env(safe-area-inset-bottom, 0px)) !important;
        border-radius: 14px;
        max-height: 55vh;
        overflow-y: auto;
        transition: max-height 0.3s ease;
        box-shadow: 0 6px 24px rgba(0,0,0,0.22);
        z-index: 10000 !important;
      }
      #location-panel.expanded {
        max-height: 80vh;
      }
      #location-drag-handle {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 28px;
        cursor: pointer;
        position: sticky;
        top: 0;
        background: #fff;
        z-index: 3;
        color: #881814;
      }
      #location-drag-handle svg {
        transition: transform 0.3s ease;
        animation: chevron-pulse 1.2s ease-in-out infinite;
      }
      #location-panel.expanded #location-drag-handle svg {
        transform: rotate(180deg);
        animation: none;
      }
      @keyframes chevron-pulse {
        0%, 100% { transform: translateY(0); opacity: 0.6; }
        50% { transform: translateY(-3px); opacity: 1; }
      }

      /* Lampeggio leggero per marker partenza/arrivo direzioni */
      .dir-marker-blink {
        animation: dir-marker-blink 1.6s ease-in-out infinite;
      }
      @keyframes dir-marker-blink {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%      { opacity: 0.55; transform: scale(0.92); }
      }

      /* Collapsed preview: foto ridotta + descrizione tagliata; nascondi info rows */
      #location-panel:not(.expanded) #location-photos {
        aspect-ratio: auto !important;
        height: 130px;
      }
      #location-panel:not(.expanded) #location-description {
        display: -webkit-box !important;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #location-panel:not(.expanded) #location-info {
        display: none !important;
      }

      /* Mobile: logo T2000 sopra search bar, piccolo + orizzontale */
      #custom-logo {
        position: fixed !important;
        top: 8px !important;
        left: 8px !important;
        bottom: auto !important;
        padding: 3px 8px !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: 6px !important;
        z-index: 1002 !important;
      }
      #custom-logo img {
        height: 26px !important;
      }
      #custom-logo-label {
        margin-top: 0 !important;
        font-size: 11px !important;
        letter-spacing: 0.5px !important;
      }

      /* Search bar scende sotto al logo */
      #search-container {
        top: 50px !important;
      }

      /* Logo cover Mappedin: rimane sotto al popup */
      #mappedin-logo-cover {
        z-index: 100 !important;
      }
    }

    /* Landscape mobile: massima compattezza verticale */
    @media (max-height: 500px) {
      #nav-stepper {
        padding: 6px 12px calc(6px + env(safe-area-inset-bottom, 0px)) !important;
      }
      #nav-step-content {
        margin-bottom: 4px !important;
      }
      #nav-step-progress {
        display: none !important;
      }
      #nav-step-icon {
        width: 28px !important;
        height: 28px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

(window as any).handlePoiMarkerClick = handlePoiMarkerClick;
(window as any).handleSpacePoiClick = handleSpacePoiClick;
(window as any).handleDoorPoiClick = handleDoorPoiClick;
(window as any).handleConnectionClick = handleConnectionClick;
(window as any).handleEntranceArrowClick = handleEntranceArrowClick;
injectStyles();
init();
