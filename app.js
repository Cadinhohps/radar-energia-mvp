const CEP_REGEX = /^\d{5}-?\d{3}$/;
const DEFAULT_RADIUS = 1000;
const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter'
];
const STORAGE_KEY = 'radar-energia-opportunities';
const CACHE_KEY = 'radar-energia-last-search';
const MAX_RAW_RESULTS = 500;
const MAX_DISPLAY_RESULTS = 250;

const state = {
  map: null,
  circle: null,
  centerMarker: null,
  cluster: null,
  results: [],
  opportunities: loadOpportunityStorage(),
  searchInFlight: false,
  currentLocation: null,
  currentQuery: null
};

const dom = {
  form: document.querySelector('#searchForm'),
  cepInput: document.querySelector('#cepInput'),
  radiusSelect: document.querySelector('#radiusSelect'),
  filterSelect: document.querySelector('#filterSelect'),
  onlyHighPotential: document.querySelector('#onlyHighPotential'),
  searchButton: document.querySelector('#searchButton'),
  loadingIndicator: document.querySelector('#loadingIndicator'),
  statusMessage: document.querySelector('#statusMessage'),
  cepError: document.querySelector('#cepError'),
  resultsList: document.querySelector('#resultsList'),
  resultsCount: document.querySelector('#resultsCount'),
  opportunitiesList: document.querySelector('#opportunitiesList'),
  exportCsvButton: document.querySelector('#exportCsvButton'),
  clearOpportunitiesButton: document.querySelector('#clearOpportunitiesButton'),
  retryButton: document.querySelector('#retryButton'),
  tabButtons: document.querySelectorAll('.tab-btn')
};

function initialize() {
  applyCepMask();
  setupMap();
  renderOpportunities();
  restoreLastSearch();
  bindEvents();
}

function loadOpportunityStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function applyCepMask() {
  dom.cepInput.addEventListener('input', (event) => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 8);
    event.target.value = digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
  });
}

function setupMap() {
  state.map = L.map('map', { zoomControl: true }).setView([-8.05, -34.9], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);

  state.cluster = L.markerClusterGroup({
    maxClusterRadius: 45,
    showCoverageOnHover: false,
    chunkedLoading: true
  });
  state.map.addLayer(state.cluster);
}

function bindEvents() {
  dom.form.addEventListener('submit', handleSearchSubmit);
  dom.retryButton.addEventListener('click', () => {
    if (state.currentQuery) {
      dom.cepInput.value = state.currentQuery.cep;
      handleSearchSubmit(new Event('submit', { cancelable: true }));
    }
  });
  dom.exportCsvButton.addEventListener('click', exportOpportunitiesCsv);
  dom.clearOpportunitiesButton.addEventListener('click', clearOpportunities);
  dom.tabButtons.forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
}

function switchView(view) {
  dom.tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const opportunityPanel = document.querySelector('.opportunities-panel');
  if (view === 'opportunities') {
    opportunityPanel.classList.add('open');
  } else {
    opportunityPanel.classList.remove('open');
  }
}

function handleSearchSubmit(event) {
  event.preventDefault();
  if (state.searchInFlight) return;

  const cep = dom.cepInput.value.replace(/\D/g, '');
  if (!cep || cep.length !== 8) {
    dom.cepError.textContent = 'Informe um CEP válido com 8 números.';
    setStatus('Validação do CEP falhou. Use 8 dígitos válidos.');
    return;
  }

  dom.cepError.textContent = '';
  const radius = Number(dom.radiusSelect.value);
  setLoading(true);
  state.searchInFlight = true;
  dom.searchButton.disabled = true;
  dom.retryButton.classList.add('hidden');

  fetchViaCep(cep)
    .then(async (viaCepResult) => {
      if (viaCepResult.erro) {
        throw new Error('CEP inexistente. Verifique o número informado.');
      }

      const location = await geocodeByNominatim(viaCepResult);
      state.currentLocation = location;
      state.currentQuery = {
        cep,
        radius,
        filter: dom.filterSelect.value,
        onlyHighPotential: dom.onlyHighPotential.checked,
        lat: location.lat,
        lng: location.lng,
        address: location.address
      };

      saveLastSearch(state.currentQuery);
      renderMapFocus(location.lat, location.lng, radius);
      await searchOverpass(location.lat, location.lng, radius);
    })
    .catch((error) => {
      setStatus(error.message || 'Não foi possível concluir a busca agora. Tente novamente.');
      dom.retryButton.classList.remove('hidden');
      console.error(error);
    })
    .finally(() => {
      setLoading(false);
      state.searchInFlight = false;
      dom.searchButton.disabled = false;
    });
}

async function fetchViaCep(cep) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error('Servidor do ViaCEP não respondeu corretamente.');
    }
    const payload = await response.json();
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function geocodeByNominatim(viaCepResult) {
  const query = `${viaCepResult.logradouro || ''} ${viaCepResult.bairro || ''} ${viaCepResult.localidade || ''} ${viaCepResult.uf || ''}`.trim();
  if (!query) throw new Error('O endereço retornado pelo ViaCEP não foi suficiente para localizar o ponto.');

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: { 'Accept-Language': 'pt-BR' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error('Falha ao consultar o endereço no Nominatim.');
    }
    const payload = await response.json();
    if (!payload || !payload.length) {
      throw new Error('Não foi possível localizar o CEP informado no mapa.');
    }
    return {
      lat: Number(payload[0].lat),
      lng: Number(payload[0].lon),
      address: payload[0].display_name
    };
  } finally {
    clearTimeout(timeout);
  }
}

function renderMapFocus(lat, lng, radius) {
  if (state.circle) state.map.removeLayer(state.circle);
  if (state.centerMarker) state.map.removeLayer(state.centerMarker);

  state.circle = L.circle([lat, lng], {
    radius,
    color: '#2866d5',
    fillColor: '#2866d5',
    fillOpacity: 0.12,
    weight: 2
  }).addTo(state.map);

  state.centerMarker = L.circleMarker([lat, lng], {
    radius: 8,
    color: '#2866d5',
    fillColor: '#2866d5',
    fillOpacity: 1
  }).addTo(state.map);

  state.map.setView([lat, lng], Math.max(12, getZoomForRadius(radius)));
}

function getZoomForRadius(radius) {
  if (radius <= 500) return 16;
  if (radius <= 1000) return 15;
  if (radius <= 2000) return 14;
  return 12;
}

async function searchOverpass(lat, lng, radius) {
  const query = buildOverpassQuery(lat, lng, radius);
  const errors = [];

  for (const url of OVERPASS_SERVERS) {
    try {
      const data = await fetchOverpass(url, query);
      const cleaned = normalizeResults(data.elements || []);
      renderResults(cleaned);
      setStatus(`${cleaned.length} resultados públicos processados. Classificação baseada em informações públicas e estimativas.`);
      return;
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`Falha ao consultar Overpass. Servidores alternativos responderam com erro: ${errors.join(' | ')}`);
}

function buildOverpassQuery(lat, lng, radius) {
  const bounds = getBoundingBox(lat, lng, radius);
  return `
    [out:json][timeout:18];
    (
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["building"~"^(house|residential|apartments|detached|terrace|semidetached_house|yes)$"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["building"~"^(house|residential|apartments|detached|terrace|semidetached_house|yes)$"];
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["shop"];
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["amenity"];
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["tourism"];
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["office"];
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["craft"];
      node(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["leisure"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["building"~"^(commercial|retail)$"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["shop"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["amenity"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["tourism"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["office"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["craft"];
      way(${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng})["leisure"];
    );
    out center tags ${MAX_RAW_RESULTS};
  `.trim();
}

function getBoundingBox(lat, lng, radius) {
  const latDelta = radius / 111320;
  const lngDelta = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta
  };
}

async function fetchOverpass(url, query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const encodedQuery = encodeURIComponent(query);

  try {
    const response = await fetch(`${url}?data=${encodedQuery}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`Overpass falhou com status ${response.status}`);
    }
    const payload = await response.json();
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeResults(elements) {
  const normalized = [];
  const seen = new Set();

  for (const element of elements) {
    const lat = Number(element.lat || element.center?.lat);
    const lng = Number(element.lon || element.center?.lon);
    if (!lat || !lng) continue;

    const key = `${element.type}:${element.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const tags = element.tags || {};
    const category = classifyCategory(tags);
    const score = scoreOpportunity(tags, category);
    normalized.push({
      id: element.id,
      type: element.type,
      lat,
      lng,
      tags,
      score,
      level: getLevel(score),
      category,
      reasons: buildReasons(tags, score, category),
      name: tags.name || tags['name:pt'] || getDefaultName(category, tags),
      address: buildAddress(tags),
      buildingType: tags.building || tags['building:use'] || tags.shop || tags.amenity || tags.tourism || 'local'
    });
  }

  return normalized.slice(0, MAX_DISPLAY_RESULTS);
}

function classifyCategory(tags) {
  const mainShop = tags.shop || tags.amenity || tags.tourism || tags.office || tags.craft || tags.leisure || '';
  if ([
    'supermarket', 'market', 'bakery', 'restaurant', 'hotel', 'pousada',
    'gym', 'laundry', 'butcher', 'pharmacy', 'clinic', 'school', 'store', 'shop'
  ].includes(mainShop)) {
    return 'comercial';
  }
  if (['house', 'residential', 'apartments', 'detached', 'terrace', 'semidetached_house', 'yes'].includes(tags.building)) {
    return 'residencial';
  }
  return 'comercial';
}

function scoreOpportunity(tags, category) {
  if (category === 'residencial') {
    let score = 40;
    const building = tags.building || '';
    if (building === 'terrace' || building === 'detached') score = 55;
    if (building === 'apartments' || building === 'semidetached_house') score = 78;
    if (tags['building:use'] === 'mixed' || tags['building:use'] === 'residential/commercial') score = 82;
    if (building === 'yes' && Number(tags['building:levels']) >= 2) score = 85;

    const area = Number(tags.area || tags['building:area'] || tags['area:ha']);
    if (area > 100 && area <= 180) score += 8;
    else if (area > 180 && area <= 250) score += 15;
    else if (area > 250) score += 20;

    const levels = Number(tags['building:levels']);
    if (levels === 2) score += 10;
    else if (levels === 3) score += 18;
    else if (levels >= 4) score += 25;

    return Math.min(100, Math.max(0, Math.round(score)));
  }

  const shop = tags.shop || tags.amenity || tags.tourism || tags.office || tags.craft || tags.leisure || '';
  const baseScores = {
    supermarket: 92,
    market: 92,
    hotel: 88,
    pousada: 88,
    gym: 85,
    bakery: 82,
    restaurant: 80,
    laundry: 80,
    butcher: 78,
    pharmacy: 68,
    clinic: 72,
    school: 70,
    store: 55,
    shop: 55,
    commercial: 55
  };

  let score = baseScores[shop] || 55;
  if (tags['opening_hours'] && /24|24\/7/.test(tags['opening_hours'])) score += 5;
  if (Number(tags['building:levels']) >= 3) score += 8;
  if (Number(tags['building:levels']) >= 5) score += 12;
  if (['commercial', 'retail'].includes(tags.building)) score += 8;
  if (tags.area || tags['building:area']) score += 6;
  return Math.min(100, Math.max(0, Math.round(score)));
}

function getLevel(score) {
  if (score <= 39) return 'baixo';
  if (score <= 69) return 'médio';
  return 'alto';
}

function buildReasons(tags, score, category) {
  const reasons = [];
  const levels = Number(tags['building:levels']);
  const area = Number(tags.area || tags['building:area']);

  if (category === 'residencial') {
    if (levels >= 2) reasons.push('vários pavimentos');
    if (area > 180) reasons.push('área aproximada elevada');
    if (tags['building:use'] === 'mixed') reasons.push('uso misto residencial e comercial');
    if (tags['building:levels'] >= 4) reasons.push('condomínio ou edifício grande');
  } else {
    if (tags['opening_hours'] && /24|24\/7/.test(tags['opening_hours'])) reasons.push('funcionamento 24 horas');
    if (levels >= 3) reasons.push('prédio grande');
    if (['commercial', 'retail'].includes(tags.building)) reasons.push('uso comercial intenso');
    if (area) reasons.push('área elevada');
  }

  return reasons.length ? reasons : ['classificação baseada em informações públicas'];
}

function buildAddress(tags) {
  return [
    tags['addr:street'],
    tags['addr:housenumber'],
    tags['addr:city'],
    tags['addr:postcode']
  ].filter(Boolean).join(', ') || 'Endereço público não informado no OpenStreetMap';
}

function getDefaultName(category, tags) {
  if (category === 'residencial') {
    return tags.building === 'apartments' ? 'Prédio de apartamentos' : 'Imóvel residencial';
  }
  return 'Estabelecimento comercial';
}

function renderResults(elements) {
  state.results = elements;
  if (state.cluster) state.cluster.clearLayers();

  const filtered = applyFilter(elements);
  dom.resultsCount.textContent = String(filtered.length);
  dom.resultsList.innerHTML = '';

  filtered.forEach((result) => {
    const marker = L.circleMarker([result.lat, result.lng], {
      radius: 9,
      color: colorForLevel(result.level),
      fillColor: colorForLevel(result.level),
      fillOpacity: 0.8,
      weight: 2
    });

    marker.bindPopup(buildPopupContent(result));
    marker.on('click', () => renderDetailsCard(result));
    state.cluster.addLayer(marker);

    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = `
      <h3>${escapeHtml(result.name)}</h3>
      <div class="meta-line">${escapeHtml(result.category)} • ${escapeHtml(result.buildingType)}</div>
      <div class="meta-line">${escapeHtml(result.address)}</div>
      <div class="result-footer">
        <span class="pill">Pontuação: ${result.score}</span>
        <span class="pill">Nível: ${result.level}</span>
      </div>
    `;
    item.addEventListener('click', () => {
      marker.openPopup();
      renderDetailsCard(result);
      state.map.flyTo([result.lat, result.lng], 16, { duration: 0.8 });
    });
    dom.resultsList.appendChild(item);
  });

  if (!filtered.length) {
    dom.resultsList.innerHTML = '<div class="result-item">Nenhum resultado foi encontrado na área com esse filtro.</div>';
    setStatus('Sem resultados nesta área. Tente ampliar o raio ou alterar o filtro.');
  }
}

function applyFilter(elements) {
  const selectedFilter = dom.filterSelect.value;
  const highOnly = dom.onlyHighPotential.checked;
  let output = elements;
  if (selectedFilter === 'residenciais') output = output.filter((item) => item.category === 'residencial');
  if (selectedFilter === 'comerciais') output = output.filter((item) => item.category === 'comercial');
  if (highOnly) output = output.filter((item) => item.level === 'alto');
  return output;
}

function colorForLevel(level) {
  if (level === 'alto') return '#d53939';
  if (level === 'médio') return '#f0c94a';
  return '#2ba654';
}

function buildPopupContent(result) {
  return `
    <div>
      <strong>${escapeHtml(result.name)}</strong><br />
      ${escapeHtml(result.category)}<br />
      Pontuação: <strong>${result.score}</strong><br />
      Nível: <strong>${result.level}</strong>
    </div>
  `;
}

function renderDetailsCard(result) {
  const details = document.createElement('div');
  details.className = 'result-item selected-detail';
  details.innerHTML = `
    <h3>${escapeHtml(result.name)}</h3>
    <div class="meta-line">Categoria: ${escapeHtml(result.category)}</div>
    <div class="meta-line">Tipo da construção: ${escapeHtml(result.buildingType)}</div>
    <div class="meta-line">Endereço: ${escapeHtml(result.address)}</div>
    <div class="meta-line">Pavimentos: ${escapeHtml(result.tags['building:levels'] || 'não informado')}</div>
    <div class="meta-line">Área aproximada: ${escapeHtml(result.tags.area || result.tags['building:area'] || 'não disponível')}</div>
    <div class="meta-line">Pontuação: ${result.score}</div>
    <div class="meta-line">Nível de potencial: ${result.level}</div>
    <div class="meta-line">Motivos: ${escapeHtml(result.reasons.join(', '))}</div>
    <div class="meta-line">Contato público cadastrado: ${escapeHtml(result.tags.phone || result.tags.website || 'não informado')}</div>
    <div class="result-footer">
      <button class="ghost-btn" data-action="save">Salvar oportunidade</button>
      <button class="ghost-btn" data-action="route">Abrir rota</button>
    </div>
    <div class="meta-line">Valor real da conta de energia não confirmado.</div>
  `;

  const existing = dom.resultsList.querySelector('.selected-detail');
  if (existing) existing.remove();
  dom.resultsList.prepend(details);

  details.querySelector('[data-action="save"]').addEventListener('click', () => saveOpportunity(result));
  details.querySelector('[data-action="route"]').addEventListener('click', () => openRoute(result));
}

function saveOpportunity(result) {
  const exists = state.opportunities.some((item) => item.identifier === `${result.type}-${result.id}`);
  if (exists) {
    setStatus('Essa oportunidade já está salva na lista.');
    return;
  }

  const newOpportunity = {
    id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    identifier: `${result.type}-${result.id}`,
    category: result.category,
    address: result.address,
    latitude: result.lat,
    longitude: result.lng,
    score: result.score,
    level: result.level,
    savedAt: new Date().toISOString(),
    status: 'novo',
    observations: '',
    name: result.name
  };

  state.opportunities.unshift(newOpportunity);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.opportunities));
  renderOpportunities();
  setStatus('Oportunidade salva com sucesso no armazenamento local do navegador.');
}

function renderOpportunities() {
  dom.opportunitiesList.innerHTML = '';

  if (!state.opportunities.length) {
    dom.opportunitiesList.innerHTML = '<div class="opportunity-item">Nenhuma oportunidade salva ainda.</div>';
    return;
  }

  state.opportunities.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'opportunity-item';
    card.innerHTML = `
      <h3>${escapeHtml(item.name || item.category)}</h3>
      <div class="meta-line">${escapeHtml(item.address)}</div>
      <div class="row">
        <span class="pill">Pontuação: ${item.score}</span>
        <span class="pill">Nível: ${item.level}</span>
      </div>
      <div class="row">
        <select class="status-select" data-id="${item.id}">
          <option value="novo" ${item.status === 'novo' ? 'selected' : ''}>novo</option>
          <option value="visitar" ${item.status === 'visitar' ? 'selected' : ''}>visitar</option>
          <option value="visitado" ${item.status === 'visitado' ? 'selected' : ''}>visitado</option>
          <option value="interessado" ${item.status === 'interessado' ? 'selected' : ''}>interessado</option>
          <option value="retornar" ${item.status === 'retornar' ? 'selected' : ''}>retornar</option>
          <option value="descartado" ${item.status === 'descartado' ? 'selected' : ''}>descartado</option>
        </select>
        <button class="ghost-btn" data-open="${item.id}">Abrir no mapa</button>
        <button class="opportunity-delete" data-delete="${item.id}">Excluir</button>
      </div>
      <textarea class="opportunity-note" data-observation="${item.id}" rows="2" placeholder="Observações">${escapeHtml(item.observations || '')}</textarea>
    `;

    const select = card.querySelector('.status-select');
    select.addEventListener('change', () => updateOpportunityStatus(item.id, select.value));

    const observation = card.querySelector('.opportunity-note');
    observation.addEventListener('change', () => updateObservation(item.id, observation.value));

    const openButton = card.querySelector('[data-open]');
    openButton.addEventListener('click', () => {
      state.map.flyTo([item.latitude, item.longitude], 16, { duration: 0.8 });
    });

    const deleteButton = card.querySelector('[data-delete]');
    deleteButton.addEventListener('click', () => deleteOpportunity(item.id));

    dom.opportunitiesList.appendChild(card);
  });
}

function updateOpportunityStatus(id, status) {
  state.opportunities = state.opportunities.map((item) => item.id === id ? { ...item, status } : item);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.opportunities));
  renderOpportunities();
}

function updateObservation(id, observations) {
  state.opportunities = state.opportunities.map((item) => item.id === id ? { ...item, observations } : item);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.opportunities));
}

function deleteOpportunity(id) {
  state.opportunities = state.opportunities.filter((item) => item.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.opportunities));
  renderOpportunities();
}

function clearOpportunities() {
  if (!state.opportunities.length) {
    setStatus('A lista de oportunidades já está vazia.');
    return;
  }
  const confirmed = window.confirm('Limpar a lista de oportunidades salva no navegador?');
  if (!confirmed) return;
  state.opportunities = [];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.opportunities));
  renderOpportunities();
  setStatus('Lista de oportunidades limpa com sucesso.');
}

function exportOpportunitiesCsv() {
  if (!state.opportunities.length) {
    setStatus('Não há oportunidades para exportar.');
    return;
  }

  const rows = [
    ['identificação', 'categoria', 'endereço', 'latitude', 'longitude', 'pontuação', 'nível', 'data', 'status', 'observações']
  ];

  state.opportunities.forEach((item) => {
    rows.push([
      item.identifier,
      item.category,
      item.address,
      item.latitude,
      item.longitude,
      item.score,
      item.level,
      item.savedAt,
      item.status,
      item.observations || ''
    ]);
  });

  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'radar-energia-oportunidades.csv';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Arquivo CSV exportado com as oportunidades salvas.');
}

function openRoute(result) {
  const url = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${result.lat},${result.lng}`;
  window.open(url, '_blank', 'noopener');
}

function saveLastSearch(query) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(query));
}

function restoreLastSearch() {
  const last = localStorage.getItem(CACHE_KEY);
  if (!last) {
    setStatus('Use um CEP válido para gerar uma estimativa baseada em informações públicas.');
    return;
  }

  try {
    const parsed = JSON.parse(last);
    dom.cepInput.value = parsed.cep || '';
    dom.radiusSelect.value = String(parsed.radius || DEFAULT_RADIUS);
    dom.filterSelect.value = parsed.filter || 'todos';
    dom.onlyHighPotential.checked = Boolean(parsed.onlyHighPotential);
    if (parsed.lat && parsed.lng) {
      renderMapFocus(parsed.lat, parsed.lng, parsed.radius || DEFAULT_RADIUS);
      setStatus('Última pesquisa restaurada usando o armazenamento local do navegador.');
    }
  } catch (error) {
    console.error('Falha ao restaurar a última pesquisa', error);
  }
}

function setLoading(isLoading) {
  dom.loadingIndicator.classList.toggle('hidden', !isLoading);
}

function setStatus(message) {
  dom.statusMessage.textContent = message;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

initialize();
