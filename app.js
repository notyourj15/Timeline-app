const APP_VERSION = '0.11.0-prealpha';
const DB_NAME = 'timeline-app-db';
const DB_VERSION = 1;
const STORE = 'timeline';
const MAIN_KEY = 'main-state';

const DEFAULT_STATE = {
  version: APP_VERSION,
  installedAt: null,
  updatedAt: null,
  activeTab: 'now',
  profile: {
    birthdate: '',
    displayName: '',
    createdAt: '',
  },
  settings: {
    theme: 'liquid-glass',
    autoSnapshots: true,
    reduceMotion: false,
    bubbleIntensity: 0.76,
    precision: 'exact',
    wizardComplete: false,
  },
  ui: {
    focusYear: null,
  },
  datePoints: [],
  snapshots: [],
};

const THEMES = {
  'liquid-glass': {
    label: 'Liquid Glass',
    tagline: 'Modern iPhone-style translucent glass.',
  },
  aero: {
    label: 'Aero',
    tagline: 'Frutiger Aero gloss, bubbles, sky, and soft optimism.',
  },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let state = structuredCloneSafe(DEFAULT_STATE);
let dbPromise = null;
let deferredInstallPrompt = null;
let saveTimer = null;
let effectEngine = null;
let lastSnapshotDay = '';
let wizardStep = 0;
let wizardDraft = {
  birthdate: '',
  displayName: '',
  theme: 'liquid-glass',
  autoSnapshots: true,
};

const els = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindElements();
  installGlobalErrorBoundary();
  await loadState();
  normalizeState();
  applyTheme(state.settings.theme);
  applyMotionSetting();
  bindNav();
  bindInstall();
  registerServiceWorker();
  effectEngine = createEffectEngine(document.getElementById('fx-canvas'));
  effectEngine.start();

  if (!state.settings.wizardComplete || !state.profile.birthdate) {
    openWizard();
  } else {
    maybeDailySnapshot();
    render();
  }
}

function bindElements() {
  els.app = document.getElementById('app');
  els.wizard = document.getElementById('wizard');
  els.headerTitle = document.getElementById('header-title');
  els.headerKicker = document.getElementById('header-kicker');
  els.installButton = document.getElementById('install-button');
  els.toastRegion = document.getElementById('toast-region');
}

function installGlobalErrorBoundary() {
  window.addEventListener('error', (event) => {
    console.error(event.error || event.message);
    toast('Something hiccuped, but Timeline stayed running.');
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    toast('A save or restore action failed safely.');
  });
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      setTab(button.dataset.tab);
    });
  });
}

function bindInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installButton.classList.remove('hidden');
  });

  els.installButton.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      els.installButton.classList.add('hidden');
      return;
    }
    toast('On iPhone: Share → Add to Home Screen.');
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

async function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open database'));
  });
  return dbPromise;
}

async function dbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error || new Error('Read failed'));
    });
  } catch (error) {
    console.warn(error);
    const raw = localStorage.getItem(`timeline:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
}

async function dbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Write failed'));
    });
  } catch (error) {
    console.warn(error);
    localStorage.setItem(`timeline:${key}`, JSON.stringify(value));
  }
}

async function loadState() {
  const stored = await dbGet(MAIN_KEY);
  state = mergeDeep(structuredCloneSafe(DEFAULT_STATE), stored || {});
}

function normalizeState() {
  const now = new Date().toISOString();
  if (!state.installedAt) state.installedAt = now;
  if (!state.updatedAt) state.updatedAt = now;
  if (!state.version) state.version = APP_VERSION;
  if (!THEMES[state.settings.theme]) state.settings.theme = 'liquid-glass';
  if (!Array.isArray(state.snapshots)) state.snapshots = [];
  if (!Array.isArray(state.datePoints)) state.datePoints = [];
  if (!state.activeTab) state.activeTab = 'now';
  if (!state.ui) state.ui = { focusYear: null };
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveState(), 120);
}

async function saveState() {
  state.version = APP_VERSION;
  state.updatedAt = new Date().toISOString();
  await dbSet(MAIN_KEY, state);
}

async function persistNow() {
  window.clearTimeout(saveTimer);
  await saveState();
}

function setTab(tab) {
  state.activeTab = tab;
  scheduleSave();
  render();
}

function render() {
  applyTheme(state.settings.theme);
  applyMotionSetting();
  updateNav();
  updateHeader();

  const profileReady = state.profile.birthdate && isValidDateInput(state.profile.birthdate);
  if (!profileReady) {
    els.app.innerHTML = renderEmptyState();
    bindRenderedActions();
    return;
  }

  if (state.activeTab === 'now') els.app.innerHTML = renderNow();
  if (state.activeTab === 'timeline') els.app.innerHTML = renderTimeline();
  if (state.activeTab === 'distance') els.app.innerHTML = renderDistance();
  if (state.activeTab === 'vault') els.app.innerHTML = renderVault();
  bindRenderedActions();
}

function updateNav() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.activeTab);
  });
}

function updateHeader() {
  const labels = {
    now: ['Timeline', 'Now'],
    timeline: ['Lifespan spine', 'Timeline'],
    distance: ['Compare time', 'Distance'],
    vault: ['Backups & settings', 'Vault'],
  };
  const [kicker, title] = labels[state.activeTab] || labels.now;
  els.headerKicker.textContent = kicker;
  els.headerTitle.textContent = title;
}

function renderEmptyState() {
  return `
    <section class="stack-lg">
      <div class="hero-card">
        <div class="hero-content">
          <span class="pill">Timeline v${APP_VERSION}</span>
          <div>
            <p class="hero-title">A soft map of lived time.</p>
            <div class="big-number">Begin</div>
            <p class="big-label">Set your birthdate to turn your lifespan into something visible.</p>
          </div>
          <button class="primary-button" data-action="open-wizard" type="button">Start setup</button>
        </div>
      </div>
    </section>
  `;
}

function renderNow() {
  const stats = getLifeStats();
  const themeLabel = THEMES[state.settings.theme].label;
  const nameLine = state.profile.displayName ? `${escapeHtml(state.profile.displayName)}’s timeline` : 'Birth → Today';
  return `
    <section class="stack-lg">
      <div class="hero-card">
        <div class="hero-content">
          <div class="row between wrap">
            <span class="pill">${nameLine}</span>
            <span class="pill">${themeLabel}</span>
          </div>
          <div>
            <p class="hero-title">Since ${formatDateShort(stats.birth)}</p>
            <div class="big-number">${formatNumber(stats.days)}</div>
            <p class="big-label">days alive</p>
          </div>
          <div class="row between wrap">
            <span class="pill">Today • ${formatDateShort(stats.today)}</span>
            <span class="leaf" aria-hidden="true"></span>
          </div>
          <div class="progress-orb" style="--progress:${stats.yearProgress}%">
            <div class="progress-orb-inner">
              <div>
                <strong>${stats.yearProgress}%</strong>
                <span>of ${stats.today.getFullYear()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="metric-grid">
        <div class="metric-bubble">
          <strong>${formatNumber(stats.weeks)}</strong>
          <span>full weeks</span>
        </div>
        <div class="metric-bubble">
          <strong>${stats.ageParts.years}<small>y</small> ${stats.ageParts.months}<small>m</small></strong>
          <span>${stats.ageParts.days} days into this month</span>
        </div>
        <div class="metric-bubble">
          <strong>${formatNumber(stats.monthsElapsed)}</strong>
          <span>month turns crossed</span>
        </div>
        <div class="metric-bubble">
          <strong>${stats.livedYearCount}</strong>
          <span>calendar years touched</span>
        </div>
      </div>

      <div class="card">
        <div class="row between">
          <div>
            <h3>A life adds up.</h3>
            <p class="help">This is not a schedule. It is the shape of time you have already crossed.</p>
          </div>
          <span class="leaf" aria-hidden="true"></span>
        </div>
      </div>
    </section>
  `;
}

function renderTimeline() {
  const stats = getLifeStats();
  const years = buildYearModels(stats.birth, stats.today);
  return `
    <section class="stack-lg">
      <div class="timeline-marker"><div class="marker-card">Birth • ${formatDateShort(stats.birth)}</div></div>
      <div class="timeline-wrap">
        <div class="timeline-spine" aria-hidden="true"></div>
        <div class="timeline-list">
          ${years.map(renderYearBubble).join('')}
        </div>
      </div>
      <div class="timeline-marker"><div class="marker-card">Today • ${formatDateShort(stats.today)}</div></div>
    </section>
  `;
}

function renderYearBubble(model) {
  const chips = model.months.map((month) => {
    const classes = ['month-chip'];
    if (month.isCurrent) classes.push('active');
    if (month.isFuture) classes.push('future');
    return `<span class="${classes.join(' ')}">${MONTHS[month.index]}</span>`;
  }).join('');
  const selected = state.ui.focusYear === model.year;
  return `
    <article class="timeline-year" data-action="focus-year" data-year="${model.year}" style="--progress:${model.progress}%" tabindex="0" role="button" aria-label="${model.year}, ${model.days} lived days">
      <div class="year-head">
        <div>
          <div class="year-title">${model.year}</div>
          <div class="help">${model.label}</div>
        </div>
        <div class="year-meta">
          <div>${model.progress}%</div>
          <div>${model.days} days</div>
        </div>
      </div>
      <div class="month-cloud ${selected ? 'expanded' : ''}">${chips}</div>
    </article>
  `;
}

function renderDistance() {
  const stats = getLifeStats();
  const pointA = getInputValue('distance-a') || toDateInput(stats.birth);
  const pointB = getInputValue('distance-b') || toDateInput(stats.today);
  const a = parseDateInput(pointA) || stats.birth;
  const b = parseDateInput(pointB) || stats.today;
  const diff = Math.abs(daysBetween(a, b));
  const lifeDays = Math.max(1, stats.days);
  const percent = Math.min(999, Math.round((diff / lifeDays) * 1000) / 10);

  return `
    <section class="stack-lg">
      <div class="distance-grid">
        <div class="date-card">
          <label class="label" for="distance-a">Point A</label>
          <input id="distance-a" class="input-field" type="date" value="${toDateInput(a)}" min="${toDateInput(stats.birth)}" max="${toDateInput(stats.today)}" />
        </div>
        <div class="date-card">
          <label class="label" for="distance-b">Point B</label>
          <input id="distance-b" class="input-field" type="date" value="${toDateInput(b)}" min="${toDateInput(stats.birth)}" max="${toDateInput(stats.today)}" />
        </div>
        <div class="result-card">
          <p class="hero-title">${formatDateShort(a)} → ${formatDateShort(b)}</p>
          <strong>${formatNumber(diff)}</strong>
          <p class="big-label">days apart</p>
          <div class="row wrap">
            <span class="pill">${formatNumber(Math.floor(diff / 7))} full weeks</span>
            <span class="pill">${percent}% of current lifespan</span>
          </div>
        </div>
      </div>
      <div class="card">
        <p class="help">Distance mode is for feeling scale. Pick any two dates inside your lifespan and Timeline shows the weight between them.</p>
      </div>
    </section>
  `;
}

function renderVault() {
  const stats = state.profile.birthdate ? getLifeStats() : null;
  const snapshots = [...state.snapshots].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const last = snapshots[0];
  const today = startOfToday();
  return `
    <section class="stack-lg">
      <div class="hero-card">
        <div class="hero-content">
          <div class="row between wrap">
            <span class="pill">Timeline v${APP_VERSION}</span>
            <span class="badge good">Local-first</span>
          </div>
          <div>
            <p class="hero-title">Your data belongs to you.</p>
            <div class="big-number">Vault</div>
            <p class="big-label">IndexedDB, snapshots, import and export.</p>
          </div>
          <div class="row wrap">
            <span class="pill">${snapshots.length} snapshots</span>
            <span class="pill">Latest • ${last ? formatDateTime(new Date(last.createdAt)) : 'none yet'}</span>
          </div>
        </div>
      </div>

      <div class="action-list">
        <button class="action-card" data-action="create-snapshot" type="button">
          <div><div class="title">Create Snapshot</div><div class="sub">Save the current timeline state.</div></div>
          <span class="badge">＋</span>
        </button>
        <button class="action-card" data-action="export-json" type="button">
          <div><div class="title">Export JSON</div><div class="sub">Download a copy you can keep in Files or iCloud.</div></div>
          <span class="badge">File</span>
        </button>
        <label class="action-card" for="import-json">
          <div><div class="title">Import Restore</div><div class="sub">Restore from a Timeline backup file.</div></div>
          <span class="badge">Open</span>
        </label>
        <input id="import-json" class="hidden" type="file" accept="application/json,.json" />
      </div>

      <div class="card stack">
        <div class="toggle-row">
          <div>
            <h3>Auto snapshots</h3>
            <p class="help">Creates a small daily version when the app opens.</p>
          </div>
          <button class="switch" type="button" role="switch" aria-checked="${state.settings.autoSnapshots}" data-action="toggle-auto-snapshots"></button>
        </div>
        <div class="toggle-row">
          <div>
            <h3>Reduce motion</h3>
            <p class="help">Calms bubbles and transitions.</p>
          </div>
          <button class="switch" type="button" role="switch" aria-checked="${state.settings.reduceMotion}" data-action="toggle-motion"></button>
        </div>
        <div>
          <label class="label" for="bubble-intensity">Bubble intensity</label>
          <input id="bubble-intensity" class="range" type="range" min="0" max="1" step="0.05" value="${state.settings.bubbleIntensity}" />
        </div>
      </div>

      <div class="card stack">
        <h3>Themes</h3>
        <div class="theme-choices">
          ${Object.entries(THEMES).map(([id, theme]) => `
            <button class="theme-choice ${state.settings.theme === id ? 'active' : ''}" data-action="set-theme" data-theme="${id}" type="button">
              <div class="theme-swatch ${id === 'aero' ? 'aero' : 'liquid'}"></div>
              <strong>${theme.label}</strong>
              <p class="help">${theme.tagline}</p>
            </button>
          `).join('')}
        </div>
      </div>

      <div class="card stack">
        <h3>Profile</h3>
        <label class="label" for="profile-name">Display name</label>
        <input id="profile-name" class="input-field" type="text" maxlength="32" value="${escapeAttr(state.profile.displayName)}" placeholder="Optional" />
        <label class="label" for="profile-birthdate">Birthdate</label>
        <input id="profile-birthdate" class="input-field" type="date" value="${escapeAttr(state.profile.birthdate)}" max="${toDateInput(today)}" />
        <p class="help">Changing this redraws the whole lifespan timeline. Export first if you’re being precious. Sensible, really.</p>
      </div>

      <div class="card stack">
        <div class="row between">
          <h3>Version Snapshots</h3>
          <span class="badge">${snapshots.length}</span>
        </div>
        <div class="snapshot-list">
          ${snapshots.length ? snapshots.map(renderSnapshotRow).join('') : '<p class="help">No snapshots yet. Create one or leave auto snapshots on.</p>'}
        </div>
      </div>

      <div class="card stack">
        <h3>Install on iPhone</h3>
        <p class="help">Open this GitHub Pages URL in Safari, tap Share, then Add to Home Screen. It will launch like a small app and work offline after the first load.</p>
        ${stats ? `<span class="pill">${formatNumber(stats.days)} days currently mapped</span>` : ''}
      </div>

      <button class="danger-button" data-action="reset-app" type="button">Reset Timeline</button>
    </section>
  `;
}

function renderSnapshotRow(snapshot) {
  const date = new Date(snapshot.createdAt);
  return `
    <div class="snapshot-row">
      <div>
        <strong>${escapeHtml(snapshot.label || 'Snapshot')}</strong>
        <span>${formatDateTime(date)}</span>
      </div>
      <button class="pill" data-action="restore-snapshot" data-snapshot-id="${escapeAttr(snapshot.id)}" type="button">Restore</button>
    </div>
  `;
}

function bindRenderedActions() {
  els.app.querySelectorAll('[data-action]').forEach((node) => {
    const action = node.dataset.action;
    if (action === 'open-wizard') node.addEventListener('click', openWizard);
    if (action === 'focus-year') {
      node.addEventListener('click', () => {
        state.ui.focusYear = Number(node.dataset.year);
        scheduleSave();
        render();
      });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          node.click();
        }
      });
    }
    if (action === 'create-snapshot') node.addEventListener('click', () => createSnapshot('Manual snapshot'));
    if (action === 'export-json') node.addEventListener('click', exportJson);
    if (action === 'toggle-auto-snapshots') node.addEventListener('click', toggleAutoSnapshots);
    if (action === 'toggle-motion') node.addEventListener('click', toggleMotion);
    if (action === 'set-theme') node.addEventListener('click', () => setTheme(node.dataset.theme));
    if (action === 'restore-snapshot') node.addEventListener('click', () => restoreSnapshot(node.dataset.snapshotId));
    if (action === 'reset-app') node.addEventListener('click', resetApp);
  });

  const importInput = document.getElementById('import-json');
  if (importInput) importInput.addEventListener('change', importJson);

  const distanceA = document.getElementById('distance-a');
  const distanceB = document.getElementById('distance-b');
  [distanceA, distanceB].forEach((input) => {
    if (!input) return;
    input.addEventListener('change', render);
    input.addEventListener('input', debounce(render, 120));
  });

  const bubbleIntensity = document.getElementById('bubble-intensity');
  if (bubbleIntensity) {
    bubbleIntensity.addEventListener('input', (event) => {
      state.settings.bubbleIntensity = Number(event.target.value);
      if (effectEngine) effectEngine.setIntensity(state.settings.bubbleIntensity);
      scheduleSave();
    });
  }

  const profileName = document.getElementById('profile-name');
  if (profileName) {
    profileName.addEventListener('input', debounce((event) => {
      state.profile.displayName = event.target.value.trim();
      scheduleSave();
      updateHeader();
    }, 220));
  }

  const profileBirthdate = document.getElementById('profile-birthdate');
  if (profileBirthdate) {
    profileBirthdate.addEventListener('change', async (event) => {
      if (!isValidDateInput(event.target.value)) {
        toast('That birthdate is not valid.');
        return;
      }
      await createSnapshot('Before birthdate change', false);
      state.profile.birthdate = event.target.value;
      state.ui.focusYear = parseDateInput(event.target.value).getFullYear();
      await persistNow();
      toast('Birthdate updated. Snapshot saved first.');
      render();
    });
  }
}

function openWizard() {
  wizardStep = 0;
  wizardDraft = {
    birthdate: state.profile.birthdate || '',
    displayName: state.profile.displayName || '',
    theme: state.settings.theme || 'liquid-glass',
    autoSnapshots: state.settings.autoSnapshots !== false,
  };
  els.wizard.classList.remove('hidden');
  renderWizard();
}

function renderWizard() {
  const steps = [renderWizardIntro, renderWizardBirthdate, renderWizardTheme, renderWizardBackup, renderWizardFinish];
  els.wizard.innerHTML = `<div class="wizard-card">${steps[wizardStep]()}</div>`;
  bindWizardActions();
}

function bindWizardActions() {
  els.wizard.querySelectorAll('[data-wizard]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.wizard;
      if (action === 'next') {
        if (!validateWizardStep()) return;
        wizardStep = Math.min(4, wizardStep + 1);
        renderWizard();
      }
      if (action === 'back') {
        wizardStep = Math.max(0, wizardStep - 1);
        renderWizard();
      }
      if (action === 'finish') {
        if (!validateWizardStep()) return;
        await finishWizard();
      }
      if (action === 'theme') {
        wizardDraft.theme = button.dataset.theme;
        applyTheme(wizardDraft.theme);
        renderWizard();
      }
      if (action === 'toggle-auto') {
        wizardDraft.autoSnapshots = !wizardDraft.autoSnapshots;
        renderWizard();
      }
    });
  });

  const birth = document.getElementById('wizard-birthdate');
  if (birth) birth.addEventListener('input', (event) => { wizardDraft.birthdate = event.target.value; });
  const name = document.getElementById('wizard-name');
  if (name) name.addEventListener('input', (event) => { wizardDraft.displayName = event.target.value.trim(); });
}

function renderWizardIntro() {
  return `
    <div class="wizard-hero"><div><p class="eyebrow">Timeline</p><h2>A soft map of lived time.</h2></div></div>
    <p class="help">This app turns birth → today into a visible, touchable shape. No account, no cloud trap, no little productivity goblin telling you to optimize your breakfast.</p>
    <div class="wizard-actions"><span class="pill">v${APP_VERSION}</span><button class="primary-button" data-wizard="next" type="button">Begin</button></div>
  `;
}

function renderWizardBirthdate() {
  return `
    <div class="wizard-hero"><div><p class="eyebrow">Step 1</p><h2>Where does the line begin?</h2></div></div>
    <label class="label" for="wizard-birthdate">Birthdate</label>
    <input id="wizard-birthdate" class="input-field" type="date" value="${escapeAttr(wizardDraft.birthdate)}" max="${toDateInput(startOfToday())}" autofocus />
    <label class="label" for="wizard-name" style="margin-top:14px">Display name, optional</label>
    <input id="wizard-name" class="input-field" type="text" maxlength="32" value="${escapeAttr(wizardDraft.displayName)}" placeholder="JJ, sir, or leave it blank" />
    <div class="wizard-actions"><button class="secondary-button" data-wizard="back" type="button">Back</button><button class="primary-button" data-wizard="next" type="button">Next</button></div>
  `;
}

function renderWizardTheme() {
  return `
    <div class="wizard-hero"><div><p class="eyebrow">Step 2</p><h2>Choose the skin.</h2></div></div>
    <div class="theme-choices">
      ${Object.entries(THEMES).map(([id, theme]) => `
        <button class="theme-choice ${wizardDraft.theme === id ? 'active' : ''}" data-wizard="theme" data-theme="${id}" type="button">
          <div class="theme-swatch ${id === 'aero' ? 'aero' : 'liquid'}"></div>
          <strong>${theme.label}</strong>
          <p class="help">${theme.tagline}</p>
        </button>
      `).join('')}
    </div>
    <div class="wizard-actions"><button class="secondary-button" data-wizard="back" type="button">Back</button><button class="primary-button" data-wizard="next" type="button">Next</button></div>
  `;
}

function renderWizardBackup() {
  return `
    <div class="wizard-hero"><div><p class="eyebrow">Step 3</p><h2>Keep the archive safe.</h2></div></div>
    <div class="card toggle-row">
      <div>
        <h3>Auto snapshots</h3>
        <p class="help">Timeline keeps daily local versions. You can still export JSON anytime.</p>
      </div>
      <button class="switch" type="button" role="switch" aria-checked="${wizardDraft.autoSnapshots}" data-wizard="toggle-auto"></button>
    </div>
    <p class="help" style="margin-top:12px">Browser storage is sturdy, not holy scripture. Export backups for anything precious.</p>
    <div class="wizard-actions"><button class="secondary-button" data-wizard="back" type="button">Back</button><button class="primary-button" data-wizard="next" type="button">Next</button></div>
  `;
}

function renderWizardFinish() {
  const birth = parseDateInput(wizardDraft.birthdate);
  const today = startOfToday();
  const days = birth ? Math.max(0, daysBetween(birth, today)) : 0;
  return `
    <div class="wizard-hero"><div><p class="eyebrow">Ready</p><h2>${formatNumber(days)} days will become visible.</h2></div></div>
    <p class="help">Theme: <strong>${THEMES[wizardDraft.theme].label}</strong>. Birthdate: <strong>${birth ? formatDateShort(birth) : 'Not set'}</strong>.</p>
    <div class="wizard-actions"><button class="secondary-button" data-wizard="back" type="button">Back</button><button class="primary-button" data-wizard="finish" type="button">Open Timeline</button></div>
  `;
}

function validateWizardStep() {
  if (wizardStep === 1 && !isValidDateInput(wizardDraft.birthdate)) {
    toast('Choose a real birthdate first.');
    return false;
  }
  return true;
}

async function finishWizard() {
  const now = new Date().toISOString();
  state.profile.birthdate = wizardDraft.birthdate;
  state.profile.displayName = wizardDraft.displayName;
  state.profile.createdAt = state.profile.createdAt || now;
  state.settings.theme = wizardDraft.theme;
  state.settings.autoSnapshots = wizardDraft.autoSnapshots;
  state.settings.wizardComplete = true;
  state.activeTab = 'now';
  state.ui.focusYear = parseDateInput(wizardDraft.birthdate).getFullYear();
  els.wizard.classList.add('hidden');
  await createSnapshot('Initial setup', false);
  await persistNow();
  toast('Timeline is ready.');
  render();
}

function getLifeStats() {
  const birth = parseDateInput(state.profile.birthdate);
  const today = startOfToday();
  const days = Math.max(0, daysBetween(birth, today));
  const ageParts = calendarDiff(birth, today);
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const nextYear = new Date(today.getFullYear() + 1, 0, 1);
  const yearProgress = Math.round((daysBetween(yearStart, today) / daysBetween(yearStart, nextYear)) * 100);
  return {
    birth,
    today,
    days,
    weeks: Math.floor(days / 7),
    ageParts,
    monthsElapsed: ageParts.years * 12 + ageParts.months,
    yearProgress,
    livedYearCount: today.getFullYear() - birth.getFullYear() + 1,
  };
}

function buildYearModels(birth, today) {
  const years = [];
  for (let year = birth.getFullYear(); year <= today.getFullYear(); year += 1) {
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const livedStart = maxDate(yearStart, birth);
    const livedEnd = minDate(yearEnd, addDays(today, 1));
    const days = Math.max(0, daysBetween(livedStart, livedEnd));
    const total = daysBetween(yearStart, yearEnd);
    const progress = Math.max(0, Math.min(100, Math.round((days / total) * 100)));
    const months = [];
    for (let month = 0; month < 12; month += 1) {
      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 1);
      const touched = monthEnd > birth && monthStart <= today;
      const isFuture = monthStart > today;
      if (touched || year === today.getFullYear() || year === birth.getFullYear()) {
        months.push({ index: month, isCurrent: year === today.getFullYear() && month === today.getMonth(), isFuture });
      }
    }
    let label = 'Full year crossed';
    if (year === birth.getFullYear()) label = 'The line begins';
    if (year === today.getFullYear()) label = 'Current year';
    if (birth.getFullYear() === today.getFullYear()) label = 'Birth year and current year';
    years.push({ year, days, progress, months, label });
  }
  return years;
}

async function maybeDailySnapshot() {
  if (!state.settings.autoSnapshots || !state.profile.birthdate) return;
  const todayKey = toDateInput(startOfToday());
  const mostRecent = state.snapshots.find((snap) => snap.kind === 'auto' && snap.dayKey === todayKey);
  if (mostRecent || lastSnapshotDay === todayKey) return;
  lastSnapshotDay = todayKey;
  await createSnapshot('Daily auto snapshot', false, 'auto', todayKey);
}

async function createSnapshot(label = 'Snapshot', announce = true, kind = 'manual', dayKey = toDateInput(startOfToday())) {
  const cleanState = structuredCloneSafe(state);
  cleanState.snapshots = [];
  const snapshot = {
    id: cryptoRandomId(),
    label,
    kind,
    dayKey,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    state: cleanState,
  };
  state.snapshots = [snapshot, ...state.snapshots].slice(0, 30);
  await persistNow();
  if (announce) {
    toast('Snapshot saved.');
    render();
  }
}

async function restoreSnapshot(id) {
  const snapshot = state.snapshots.find((item) => item.id === id);
  if (!snapshot) {
    toast('Snapshot not found.');
    return;
  }
  const currentSnapshots = state.snapshots;
  state = mergeDeep(structuredCloneSafe(DEFAULT_STATE), snapshot.state || {});
  state.snapshots = currentSnapshots;
  state.settings.wizardComplete = true;
  normalizeState();
  await persistNow();
  toast('Snapshot restored.');
  render();
}

function exportJson() {
  const payload = {
    app: 'Timeline',
    exportedAt: new Date().toISOString(),
    version: APP_VERSION,
    state,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timeline-backup-${toDateInput(startOfToday())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Backup exported.');
}

async function importJson(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = parsed.state || parsed;
    if (!incoming.profile || !incoming.settings) throw new Error('Not a Timeline backup');
    await createSnapshot('Before import restore', false);
    state = mergeDeep(structuredCloneSafe(DEFAULT_STATE), incoming);
    state.settings.wizardComplete = Boolean(state.profile.birthdate);
    normalizeState();
    await persistNow();
    toast('Backup imported.');
    render();
  } catch (error) {
    console.error(error);
    toast('That file was not a valid Timeline backup.');
  } finally {
    event.target.value = '';
  }
}

async function toggleAutoSnapshots() {
  state.settings.autoSnapshots = !state.settings.autoSnapshots;
  await persistNow();
  toast(state.settings.autoSnapshots ? 'Auto snapshots on.' : 'Auto snapshots off.');
  render();
}

async function toggleMotion() {
  state.settings.reduceMotion = !state.settings.reduceMotion;
  applyMotionSetting();
  if (effectEngine) effectEngine.setMotion(!state.settings.reduceMotion);
  await persistNow();
  render();
}

async function setTheme(theme) {
  if (!THEMES[theme]) return;
  state.settings.theme = theme;
  applyTheme(theme);
  await persistNow();
  toast(`${THEMES[theme].label} enabled.`);
  render();
}

async function resetApp() {
  const ok = window.confirm('Reset Timeline? Export first if you care about this data.');
  if (!ok) return;
  await createSnapshot('Before reset', false);
  const snapshots = state.snapshots;
  state = structuredCloneSafe(DEFAULT_STATE);
  state.snapshots = snapshots;
  normalizeState();
  await persistNow();
  toast('Timeline reset.');
  openWizard();
  render();
}

function applyTheme(theme) {
  const safeTheme = THEMES[theme] ? theme : 'liquid-glass';
  document.body.classList.toggle('theme-liquid-glass', safeTheme === 'liquid-glass');
  document.body.classList.toggle('theme-aero', safeTheme === 'aero');
  const color = safeTheme === 'aero' ? '#dff9ff' : '#eef7ff';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  if (effectEngine) effectEngine.setTheme(safeTheme);
}

function applyMotionSetting() {
  const reduced = state.settings.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.dataset.motion = reduced ? 'reduced' : 'full';
  if (effectEngine) effectEngine.setMotion(!reduced);
}

function createEffectEngine(canvas) {
  const context = canvas.getContext('2d', { alpha: true });
  let width = 0;
  let height = 0;
  let dpr = 1;
  let running = false;
  let animationFrame = null;
  let intensity = state.settings.bubbleIntensity ?? 0.76;
  let theme = state.settings.theme || 'liquid-glass';
  let motion = !state.settings.reduceMotion;
  let bubbles = [];
  let leaves = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.floor(window.innerWidth);
    height = Math.floor(window.innerHeight);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const count = Math.round(18 + intensity * 34);
    bubbles = Array.from({ length: count }, (_, index) => makeBubble(index));
    leaves = Array.from({ length: theme === 'aero' ? Math.round(4 + intensity * 8) : 0 }, (_, index) => makeLeaf(index));
  }

  function makeBubble(index) {
    const radius = random(8, 42) * (index % 5 === 0 ? 1.5 : 1);
    return {
      x: random(-40, width + 40),
      y: random(-40, height + 40),
      r: radius,
      vx: random(-0.08, 0.08),
      vy: random(-0.24, -0.06) * (motion ? 1 : 0),
      phase: random(0, Math.PI * 2),
      wobble: random(0.4, 1.6),
      alpha: random(0.08, theme === 'aero' ? 0.32 : 0.22),
    };
  }

  function makeLeaf(index) {
    return {
      x: random(-40, width + 40),
      y: random(0, height),
      s: random(0.6, 1.2),
      vx: random(-0.08, 0.12),
      vy: random(-0.1, 0.05),
      rot: random(-1, 1),
      spin: random(-0.003, 0.003),
      alpha: random(0.14, 0.28),
    };
  }

  function draw(time) {
    context.clearRect(0, 0, width, height);
    const speed = motion ? 1 : 0;
    drawCaustics(time);

    for (const bubble of bubbles) {
      bubble.phase += 0.008 * speed;
      bubble.x += (bubble.vx + Math.sin(bubble.phase) * 0.08) * speed;
      bubble.y += bubble.vy * speed;
      if (bubble.y + bubble.r < -40) {
        bubble.y = height + bubble.r + random(0, 80);
        bubble.x = random(-40, width + 40);
      }
      if (bubble.x < -80) bubble.x = width + 60;
      if (bubble.x > width + 80) bubble.x = -60;
      drawBubble(bubble, time);
    }

    if (theme === 'aero') {
      for (const leaf of leaves) {
        leaf.x += leaf.vx * speed;
        leaf.y += leaf.vy * speed;
        leaf.rot += leaf.spin * speed;
        if (leaf.x > width + 60) leaf.x = -50;
        if (leaf.x < -60) leaf.x = width + 50;
        if (leaf.y < -60) leaf.y = height + 50;
        drawLeaf(leaf);
      }
    }

    if (running) animationFrame = requestAnimationFrame(draw);
  }

  function drawCaustics(time) {
    context.save();
    context.globalAlpha = theme === 'aero' ? 0.13 : 0.08;
    context.lineWidth = 1;
    context.strokeStyle = '#ffffff';
    const spacing = theme === 'aero' ? 70 : 96;
    for (let i = -2; i < width / spacing + 2; i += 1) {
      context.beginPath();
      for (let y = -20; y < height + 20; y += 22) {
        const x = i * spacing + Math.sin(y * 0.018 + time * 0.00035 + i) * 18;
        if (y === -20) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.restore();
  }

  function drawBubble(bubble, time) {
    const wobble = Math.sin(time * 0.001 + bubble.phase) * bubble.wobble;
    const r = bubble.r + wobble;
    const gradient = context.createRadialGradient(bubble.x - r * 0.32, bubble.y - r * 0.38, 1, bubble.x, bubble.y, r);
    gradient.addColorStop(0, `rgba(255,255,255,${bubble.alpha + 0.18})`);
    gradient.addColorStop(0.32, `rgba(220,248,255,${bubble.alpha})`);
    gradient.addColorStop(0.72, `rgba(91,177,255,${bubble.alpha * 0.55})`);
    gradient.addColorStop(1, `rgba(255,255,255,0.02)`);
    context.save();
    context.beginPath();
    context.ellipse(bubble.x, bubble.y, r * 1.02, r * 0.96, Math.sin(bubble.phase) * 0.08, 0, Math.PI * 2);
    context.fillStyle = gradient;
    context.fill();
    context.strokeStyle = `rgba(255,255,255,${bubble.alpha + 0.12})`;
    context.lineWidth = 1;
    context.stroke();
    context.beginPath();
    context.ellipse(bubble.x - r * 0.28, bubble.y - r * 0.33, r * 0.28, r * 0.11, -0.55, 0, Math.PI * 2);
    context.fillStyle = `rgba(255,255,255,${bubble.alpha + 0.16})`;
    context.fill();
    context.restore();
  }

  function drawLeaf(leaf) {
    context.save();
    context.translate(leaf.x, leaf.y);
    context.rotate(leaf.rot);
    context.scale(leaf.s, leaf.s);
    context.globalAlpha = leaf.alpha;
    const gradient = context.createLinearGradient(-16, -8, 18, 10);
    gradient.addColorStop(0, '#e8ff9d');
    gradient.addColorStop(1, '#4fbd6b');
    context.fillStyle = gradient;
    context.beginPath();
    context.ellipse(-7, 0, 15, 7, -0.55, 0, Math.PI * 2);
    context.ellipse(8, 3, 14, 7, 0.55, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,.6)';
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    window.addEventListener('resize', resize);
    animationFrame = requestAnimationFrame(draw);
  }

  function stop() {
    running = false;
    window.removeEventListener('resize', resize);
    if (animationFrame) cancelAnimationFrame(animationFrame);
  }

  return {
    start,
    stop,
    setTheme(nextTheme) {
      theme = nextTheme;
      seed();
    },
    setIntensity(nextIntensity) {
      intensity = Number(nextIntensity);
      seed();
    },
    setMotion(enabled) {
      motion = Boolean(enabled);
    },
  };
}

function parseDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function isValidDateInput(value) {
  const date = parseDateInput(value);
  if (!date) return false;
  return date <= startOfToday();
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysBetween(a, b) {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }

function calendarDiff(start, end) {
  let years = end.getFullYear() - start.getFullYear();
  let months = end.getMonth() - start.getMonth();
  let days = end.getDate() - start.getDate();
  if (days < 0) {
    months -= 1;
    const previousMonthEnd = new Date(end.getFullYear(), end.getMonth(), 0).getDate();
    days += previousMonthEnd;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) };
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateShort(date) {
  return `${LONG_MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function formatDateTime(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} • ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function formatNumber(number) {
  return new Intl.NumberFormat().format(number);
}

function getInputValue(id) {
  const input = document.getElementById(id);
  return input ? input.value : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function random(min, max) {
  return Math.random() * (max - min) + min;
}

function cryptoRandomId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function mergeDeep(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value;
    } else if (value && typeof value === 'object') {
      target[key] = mergeDeep(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  els.toastRegion.appendChild(node);
  window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px) scale(.98)';
    node.style.transition = 'opacity .22s ease, transform .22s ease';
  }, 2600);
  window.setTimeout(() => node.remove(), 3000);
}
