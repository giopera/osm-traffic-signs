const map = L.map('map', {
  zoomControl: true,
  tap: false,
}).setView([43.72, 10.40], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const definitionsPath = 'data/IT.json';
const lastUpdatedEl = document.getElementById('last-updated');
let signDefinitions = {};
const trafficLayer = L.layerGroup().addTo(map);
const overpassEndpoint = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
const hash = new L.Hash(map);

let isFetchingOverpass = false;
let pendingOverpassBounds = null;
// Element store and cache: keep latest elements by OSM id and cache positive bbox results.
const elementStore = new Map(); // key: `${type}-${id}` => element
const overpassCache = []; // entries: { bounds: L.LatLngBounds, keys: Set<string> }

function parseTrafficSign(value) {
  const tags = String(value).trim().split(';');
  const result = [];
  tags.forEach(tag => {
    const match = tag.match(/^IT:([^\[]+)(?:\[(.*?)\])?$/i);
    if (!match) return;

    result.push({
      country: 'IT',
      code: match[1].trim(),
      value: match[2] ? match[2].trim() : null,
    });
  });
  return result;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

function buildSvgDataUrl(svg) {
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
  return `data:image/svg+xml;charset=UTF-8,${encoded}`;
}

function createSignSvg(definition, value) {
  if (!definition) {
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><circle cx='60' cy='60' r='52' fill='#f8fafc' stroke='#9ca3af' stroke-width='10'/><text x='60' y='68' text-anchor='middle' font-family='Inter, sans-serif' font-size='16' fill='#4b5563'>Unknown</text></svg>`;
  }

  let svg = definition.svgTemplate;
  if (value) {
    svg = svg.replace(/{value}/g, escapeSvg(value));
  }
  return svg.replace(/{value}/g, '');
}

function getSvgDimensionsFromMarkup(svgText) {
  if (!svgText || typeof svgText !== 'string') {
    return { width: 1, height: 1 };
  }

  const widthMatch = svgText.match(/\swidth=["']?([0-9]+(?:\.[0-9]+)?)\s*(?:px)?["']?/i);
  const heightMatch = svgText.match(/\sheight=["']?([0-9]+(?:\.[0-9]+)?)\s*(?:px)?["']?/i);
  const viewBoxMatch = svgText.match(/viewBox=["']?([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)["']?/i);

  if (widthMatch && heightMatch) {
    const width = Number.parseFloat(widthMatch[1]);
    const height = Number.parseFloat(heightMatch[1]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  if (viewBoxMatch) {
    const [, , , width, height] = viewBoxMatch;
    const parsedWidth = Number.parseFloat(width);
    const parsedHeight = Number.parseFloat(height);
    if (Number.isFinite(parsedWidth) && Number.isFinite(parsedHeight) && parsedWidth > 0 && parsedHeight > 0) {
      return { width: parsedWidth, height: parsedHeight };
    }
  }

  return { width: 1, height: 1 };
}

function measureSvgDimensions(iconUrl) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const width = img.naturalWidth || img.width || 1;
        const height = img.naturalHeight || img.height || 1;
        resolve({ width, height });
      };
      img.onerror = async () => {
        try {
          const response = await fetch(iconUrl);
          if (!response.ok) {
            resolve({ width: 1, height: 1 });
            return;
          }
          const svgText = await response.text();
          resolve(getSvgDimensionsFromMarkup(svgText));
        } catch (error) {
          console.warn('Unable to measure SVG dimensions for', iconUrl, error);
          resolve({ width: 1, height: 1 });
        }
      };
      img.src = iconUrl;
    } catch (error) {
      console.warn('Unable to create image for', iconUrl, error);
      resolve({ width: 1, height: 1 });
    }
  });
}

async function createMarkerIcon(parsedSigns, rotationAngle = 0) {
  const signs = Array.isArray(parsedSigns) ? parsedSigns : [parsedSigns];
  const baseUrl = '/images/';
  const preferredWidth = 30;

  const enhancedSigns = await Promise.all(signs.map(async (sign) => {
    const iconUrl = `${baseUrl}${sign.country}/${sign.code}.svg`;
    const { width, height } = await measureSvgDimensions(iconUrl);
    const ratio = width > 0 && height > 0 ? width / height : 1;
    const renderedHeight = preferredWidth / ratio;

    return {
      ...sign,
      iconUrl,
      width: preferredWidth,
      height: renderedHeight,
    };
  }));

  const totalHeight = enhancedSigns.reduce((total, sign) => total + sign.height + 2, 0) - 2;

  const imagesHtml = enhancedSigns
    .map((sign) => `
      <div class="sign-wrapper" style="width:${sign.width}px;height:${sign.height}px;">
        <img src="${sign.iconUrl}" alt="${sign.code}" class="traffic-sign-img" style="width:${sign.width}px;height:${sign.height}px;" />
      </div>
    `)
    .join('');

  return L.divIcon({
    html: `<div class="signpost-stack">${imagesHtml}</div>`,
    className: 'traffic-sign-marker',
    iconSize: [preferredWidth, totalHeight],
    iconAnchor: [preferredWidth / 2, 0],
    popupAnchor: [preferredWidth / 4, 0],
    rotationAngle: rotationAngle,
  });
}

function getElementLatLng(element) {
  if (element.type === 'node' && element.lat != null && element.lon != null) {
    return [element.lat, element.lon];
  }
  if (element.center && element.center.lat != null && element.center.lon != null) {
    return [element.center.lat, element.center.lon];
  }
  return null;
}

function formatItalianTimestamp(timestampValue) {
  if (!timestampValue) {
    return 'non disponibile';
  }

  const date = new Date(timestampValue);
  if (Number.isNaN(date.getTime())) {
    return 'non disponibile';
  }

  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function updateLastUpdatedDisplay(timestampValue) {
  if (!lastUpdatedEl) {
    return;
  }

  const value = formatItalianTimestamp(timestampValue);
  lastUpdatedEl.textContent = `Dati OSM aggiornati: ${value}`;
}

function fetchOverpassSigns(bounds) {
  // TODO: Caching
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(',');
  const query = `
[out:json][timeout:25];
(
  node["traffic_sign"~"^IT:"](${bbox});
  way["traffic_sign"~"^IT:"](${bbox});
  relation["traffic_sign"~"^IT:"](${bbox});
);
out center;
`;

  return fetch(overpassEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({ data: query }),
  }).then((response) => {
    if (!response.ok) {
      throw new Error('Overpass query failed');
    }
    return response.json();
  });
}

async function renderTrafficSigns(elements) {
  trafficLayer.clearLayers();

  const markers = await Promise.all(elements.map(async (element) => {
    if (!element.tags || !element.tags.traffic_sign) {
      return null;
    }

    const coords = getElementLatLng(element);
    if (!coords) {
      return null;
    }

    const signTag = element.tags.traffic_sign;
    const parsed = parseTrafficSign(signTag);
    const parsedArr = Array.isArray(parsed) ? parsed : [parsed];
    const title = parsedArr.map(s => s.code).filter(Boolean).join(', ') || 'Traffic sign';

    const marker = L.marker(coords, {
      icon: await createMarkerIcon(parsedArr, element.tags.direction ? parseFloat(element.tags.direction) : 0),
      title: title,
    });

    // Build a richer popup: title, raw tag, optional name, OSM link, and tags table
    const osmUrl = `https://www.openstreetmap.org/${element.type}/${element.id}`;

    let tagsTable = '<table class="tags-table" style="border-collapse:collapse;width:100%"><thead><tr><th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Key</th><th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Value</th></tr></thead><tbody>';
    Object.keys(element.tags).forEach((k) => {
      tagsTable += `<tr><td style="vertical-align:top;border-bottom:1px solid #f0f0f0;padding:4px">${escapeHtml(k)}</td><td style="vertical-align:top;border-bottom:1px solid #f0f0f0;padding:4px">${escapeHtml(element.tags[k])}</td></tr>`;
    });
    tagsTable += '</tbody></table>';

    const popupHtml = `
      <div class="traffic-popup">
        <div style="font-weight:600;margin-bottom:6px">${escapeHtml(title || 'IT sign')}</div>
        ${element.tags.name ? `<div style="margin-bottom:6px">${escapeHtml(element.tags.name)}</div>` : ''}
        <div>${tagsTable}</div>
        <div style="margin-bottom:6px"><a href="${osmUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(element.type)} #${escapeHtml(String(element.id))}</a></div>
      </div>
    `;

    marker.bindPopup(popupHtml, { maxWidth: 480 });
    return marker;
  }));

  markers.filter(Boolean).forEach((marker) => marker.addTo(trafficLayer));
}

function updateTrafficSigns(boundsParam) {
  if (map.getZoom() < 15) {
    return;
  }

  const bounds = (boundsParam && typeof boundsParam.getSouth === 'function')
    ? boundsParam
    : map.getBounds();
  const reqBounds = L.latLngBounds(bounds);

  // Check cache first: if we have a cached bbox that fully contains
  // the requested bounds, use cached elements (filtered to the
  // requested bounds) and skip Overpass.
  const cacheEntry = overpassCache.find((entry) => entry.bounds.contains(reqBounds));
  if (cacheEntry) {
    const cachedElements = [];
    cacheEntry.keys.forEach((key) => {
      const el = elementStore.get(key);
      if (!el) return;
      const coords = getElementLatLng(el);
      if (!coords) return;
      if (reqBounds.contains(L.latLng(coords[0], coords[1]))) {
        cachedElements.push(el);
      }
    });
    renderTrafficSigns(cachedElements);
    return;
  }

  if (isFetchingOverpass) {
    pendingOverpassBounds = L.latLngBounds(reqBounds);
    return;
  }

  isFetchingOverpass = true;
  fetchOverpassSigns(reqBounds)
    .then(async (data) => {
      const timestamp = data?.osm3s?.timestamp_osm_base;
      if (timestamp) {
        updateLastUpdatedDisplay(timestamp);
      }

      if (!Array.isArray(data.elements)) {
        return;
      }

      const elements = data.elements;
      if (elements.length > 0) {
        // Update elementStore with latest elements (deduplicate by type-id)
        const keys = [];
        elements.forEach((el) => {
          const key = `${el.type}-${el.id}`;
          elementStore.set(key, el);
          keys.push(key);
        });

        // Save cache entry for these bounds
        const cacheBounds = L.latLngBounds(reqBounds);
        overpassCache.push({ bounds: cacheBounds, keys: new Set(keys) });
      }

      await renderTrafficSigns(elements);
    })
    .catch((error) => {
      console.warn('Unable to load traffic sign markers from Overpass:', error);
    })
    .finally(() => {
      isFetchingOverpass = false;
      if (pendingOverpassBounds) {
        const nextBounds = pendingOverpassBounds;
        pendingOverpassBounds = null;
        // Trigger the next fetch for the most recent bounds.
        updateTrafficSigns(nextBounds);
      }
    });
}

function debounce(fn, wait) {
  let timeout = null;
  return (...args) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => fn(...args), wait);
  };
}

const debouncedUpdateTrafficSigns = debounce(updateTrafficSigns, 750);
map.on('moveend', debouncedUpdateTrafficSigns);

function initialize() {
  fetch(definitionsPath)
    .then((response) => {
      if (!response.ok) {
        throw new Error('Unable to load sign definitions');
      }
      return response.json();
    })
    .then((definitions) => {
      signDefinitions = definitions;
    })
    .catch((error) => {
      console.warn('Unable to load sign definitions, using fallback markers only.', error);
      signDefinitions = {};
    })
    .finally(() => {
      updateTrafficSigns();
    });
}

initialize();
