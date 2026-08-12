const map = L.map('map', {
  zoomControl: true,
  tap: false,
}).setView([43.72, 10.40], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const definitionsPath = 'data/IT.json';
let signDefinitions = {};
const trafficLayer = L.layerGroup().addTo(map);
const overpassEndpoint = 'https://overpass-api.de/api/interpreter';

function parseTrafficSign(value) {
  const text = String(value).trim();
  const match = text.match(/^IT:(?:'([^']+)'|([^\[]]+))(?:\[(.*?)\])?$/i);
  if (!match) return null;

  return {
    country: 'IT',
    code: (match[1] || match[2]).trim(),
    value: match[3] || null,
  };
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

function createMarkerIcon(signTag) {
  const parsed = parseTrafficSign(signTag);
  const definition = parsed && signDefinitions[parsed.code];
  const svg = createSignSvg(definition, parsed?.value);
  const iconUrl = buildSvgDataUrl(svg);

  return L.icon({
    iconUrl,
    iconSize: [52, 52],
    iconAnchor: [26, 26],
    popupAnchor: [0, -26],
    className: 'traffic-sign-marker',
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

function renderTrafficSigns(elements) {
  trafficLayer.clearLayers();

  elements.forEach((element) => {
    if (!element.tags || !element.tags.traffic_sign) {
      return;
    }

    const coords = getElementLatLng(element);
    if (!coords) {
      return;
    }

    const signTag = element.tags.traffic_sign;
    const parsed = parseTrafficSign(signTag);
    const marker = L.marker(coords, {
      icon: createMarkerIcon(signTag),
      title: parsed?.code || 'Traffic sign',
    }).addTo(trafficLayer);

    const popupParts = [
      `<strong>${escapeHtml(parsed?.code || 'IT sign')}</strong>`,
      `<code>${escapeHtml(signTag)}</code>`,
    ];

    if (element.tags.name) {
      popupParts.push(`<div>${escapeHtml(element.tags.name)}</div>`);
    }

    popupParts.push(`<div>${escapeHtml(element.type)} #${escapeHtml(String(element.id))}</div>`);

    marker.bindPopup(popupParts.join('<br>'));
  });
}

function updateTrafficSigns() {
  if (!signDefinitions || Object.keys(signDefinitions).length === 0) {
    return;
  }

  const bounds = map.getBounds();
  fetchOverpassSigns(bounds)
    .then((data) => {
      if (!Array.isArray(data.elements)) {
        return;
      }
      renderTrafficSigns(data.elements);
    })
    .catch((error) => {
      console.warn('Unable to load traffic sign markers from Overpass:', error);
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
