const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors',
      },
    },
    layers: [{
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
    }],
  },
  center: [10.4, 43.72],
  zoom: 6,
  bearing: 0,
  pitch: 0,
});

map.addControl(new maplibregl.NavigationControl({
  showCompass: true,
  showZoom: true,
  visualizePitch: false,
}), 'top-left');

map.addControl(new maplibregl.FullscreenControl(), 'top-right');

const definitionsPath = 'data/IT.json';
const lastUpdatedEl = document.getElementById('last-updated');
let signDefinitions = {};
const overpassEndpoint = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
const trafficMarkers = [];
const elementStore = new Map();
const overpassCache = [];

let isFetchingOverpass = false;
let pendingBounds = null;

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
  const preferredWidth = 30;
  const normalizedAngle = Number.isFinite(rotationAngle) ? Number(rotationAngle) : 0;

  const enhancedSigns = await Promise.all(signs.map(async (sign) => {
    const iconUrl = `/images/${sign.country}/${sign.code}.svg`;
    const { width, height } = await measureSvgDimensions(iconUrl);
    const ratio = width > 0 && height > 0 ? width / height : 1;
    return {
      ...sign,
      iconUrl,
      width: preferredWidth,
      height: preferredWidth / ratio,
    };
  }));

  const totalHeight = enhancedSigns.reduce((total, sign) => total + sign.height + 2, 0) - 2;
  const wrapper = document.createElement('div');
  wrapper.className = 'traffic-sign-marker';
  wrapper.style.width = `${preferredWidth}px`;
  wrapper.style.height = `${Math.max(totalHeight, preferredWidth)}px`;
  wrapper.style.pointerEvents = 'auto';
  wrapper.style.overflow = 'visible';

  const stack = document.createElement('div');
  stack.className = 'signpost-stack';
  stack.style.display = 'flex';
  stack.style.flexDirection = 'column';
  stack.style.alignItems = 'center';
  stack.style.gap = '2px';
  stack.style.width = `${preferredWidth}px`;

  enhancedSigns.forEach((sign) => {
    const signWrap = document.createElement('div');
    signWrap.className = 'sign-wrapper';
    signWrap.style.width = `${sign.width}px`;
    signWrap.style.height = `${sign.height}px`;
    signWrap.style.display = 'flex';
    signWrap.style.alignItems = 'center';
    signWrap.style.justifyContent = 'center';

    const img = document.createElement('img');
    img.src = sign.iconUrl;
    img.alt = sign.code;
    img.className = 'traffic-sign-img';
    img.style.width = `${sign.width}px`;
    img.style.height = `${sign.height}px`;
    img.style.display = 'block';
    img.style.objectFit = 'contain';
    img.style.filter = 'drop-shadow(0px 2px 3px rgba(0, 0, 0, 0.3))';
    img.style.transform = `rotate(${normalizedAngle}deg)`;
    img.style.transformOrigin = 'center center';

    signWrap.appendChild(img);
    stack.appendChild(signWrap);
  });

  wrapper.appendChild(stack);
  return wrapper;
}

function getElementLatLng(element) {
  if (element.type === 'node' && element.lat != null && element.lon != null) {
    return [element.lon, element.lat];
  }
  if (element.center && element.center.lat != null && element.center.lon != null) {
    return [element.center.lon, element.center.lat];
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
  trafficMarkers.forEach((marker) => marker.remove());
  trafficMarkers.length = 0;

  for (const element of elements) {
    if (!element.tags || !element.tags.traffic_sign) {
      continue;
    }

    const coords = getElementLatLng(element);
    if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
      continue;
    }

    const signTag = element.tags.traffic_sign;
    const parsed = parseTrafficSign(signTag);
    const parsedArr = Array.isArray(parsed) ? parsed : [parsed];
    const title = parsedArr.map(s => s.code).filter(Boolean).join(', ') || 'Traffic sign';
    const rawDirection = Number.parseFloat(element.tags.direction);
    const safeDirection = Number.isFinite(rawDirection) ? rawDirection : 0;
    const markerEl = await createMarkerIcon(parsedArr, safeDirection);
    const marker = new maplibregl.Marker({
      element: markerEl,
      anchor: 'center',
    })
      .setLngLat(coords)
      .addTo(map);

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

    const popup = new maplibregl.Popup({ maxWidth: '480px', closeButton: true })
      .setHTML(popupHtml);
    marker.setPopup(popup);
    marker.getElement().addEventListener('click', () => {
      marker.togglePopup();
    });

    trafficMarkers.push(marker);
  }
}

function updateTrafficSigns(boundsParam) {
  if (map.getZoom() < 15) {
    return;
  }

  const bounds = boundsParam || map.getBounds();
  const reqBounds = new maplibregl.LngLatBounds([
    [bounds.getWest(), bounds.getSouth()],
    [bounds.getEast(), bounds.getNorth()],
  ]);

  const cacheEntry = overpassCache.find((entry) => entry.bounds.contains(reqBounds));
  if (cacheEntry) {
    const cachedElements = [];
    cacheEntry.keys.forEach((key) => {
      const el = elementStore.get(key);
      if (!el) return;
      const coords = getElementLatLng(el);
      if (!coords) return;
      if (reqBounds.contains(coords)) cachedElements.push(el);
    });
    renderTrafficSigns(cachedElements);
    return;
  }

  if (isFetchingOverpass) {
    pendingBounds = reqBounds;
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
        const keys = [];
        elements.forEach((el) => {
          const key = `${el.type}-${el.id}`;
          elementStore.set(key, el);
          keys.push(key);
        });

        overpassCache.push({
          bounds: new maplibregl.LngLatBounds(reqBounds),
          keys: new Set(keys),
        });
      }

      await renderTrafficSigns(elements);
    })
    .catch((error) => {
      console.warn('Unable to load traffic sign markers from Overpass:', error);
    })
    .finally(() => {
      isFetchingOverpass = false;
      if (pendingBounds) {
        const nextBounds = pendingBounds;
        pendingBounds = null;
        updateTrafficSigns(nextBounds);
      }
    });
}

function debounce(fn, wait) {
  let timeout = null;
  return (...args) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

const debouncedUpdateTrafficSigns = debounce(() => updateTrafficSigns(map.getBounds()), 750);
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

map.on('load', initialize);
