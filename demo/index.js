// JevSheet front end. Two Handsontable grids, one classify request per row.
import Handsontable from 'handsontable';
import { HyperFormula } from 'hyperformula';
import Papa from 'papaparse';
import { hasTheme, horizonTheme, mainTheme, registerTheme, reinitTheme } from 'handsontable/themes';
import './style.css';
import SAMPLE_CSV from './sample-data.js';
import RECORDED from './recorded.js';

// Where the page runs decides whether rows go to Jev. The classifier Worker accepts calls only
// from demos.handsontable.com, so only the full-page build (/d/<id>/) and local dev run live.
// The docs/blog embed (/embed/<id>/) and the editable playground (whose preview is served from
// another origin) replay recorded answers for the sample reviews instead.
const CLASSIFIER_URL = 'https://jev-sheet.handsontable-sandbox.workers.dev/api/classify';
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
// Local dev can preview recorded mode with ?recorded.
const LIVE = (IS_LOCAL && !new URLSearchParams(location.search).has('recorded'))
  || (location.hostname === 'demos.handsontable.com' && location.pathname.startsWith('/d/'));
const API_URL = IS_LOCAL ? '/api/classify' : CLASSIFIER_URL;
// The live page of this demo: the bare static build, which is also the URL to share, since its
// own <head> supplies the link preview. The id comes from the URL where there is one.
const DEMO_ID = location.pathname.match(/^\/(?:d|embed)\/([^/]+)/)?.[1] ?? '2g6f4hc3b2';
const FULL_DEMO_URL = `https://demos.handsontable.com/d/${DEMO_ID}/`;

const MAX_ROWS_PER_COLUMN = 50; // one request per row; the Worker's rate limit bounds the total
const CONCURRENCY = 8;
const STAGGER_MS = 40;
const LONG_TEXT_CHARS = 60; // a column whose longest value is longer than this wraps at LONG_TEXT_WIDTH
const TEXT_SHRINK = 0.85;   // text columns are shown 15% narrower than their natural width
const LONG_TEXT_WIDTH = Math.round(460 * TEXT_SHRINK);
const PRESET_WIDTHS = { id: 50, product: 135 }; // by lower-cased column name
// Used when a Score column is added without levels; written back into its Options cell so it's visible.
const DEFAULT_SCORE_LEVELS = ['Very low', 'Low', 'Medium', 'High', 'Very high'];
// The handsontable.com site grid (handsontable-com-v3, src/styles/ht-theme-site.ts): the main
// theme with horizon's icons and the brand tokens on top. Every value is a CSS variable from
// style.css, so the grid and the page share one palette. Nothing is rounded, and the colour
// scheme is fixed so a visitor's OS setting cannot flip it.
const SITE_TOKENS = {
  borderRadius: '0',
  cellAutofillBorderRadius: '0',
  cellMobileHandleBorderRadius: '0',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-body-2)',
  fontSizeSmall: 'var(--text-caption)',
  accentColor: 'var(--color-brand-blue)',
  foregroundColor: 'var(--color-gray-950)',
  foregroundSecondaryColor: 'var(--color-gray-600)',
  backgroundColor: 'var(--color-brand-white)',
  backgroundSecondaryColor: 'var(--color-gray-50)',
  borderColor: 'var(--color-gray-100)',
  cellHorizontalBorderColor: 'var(--color-gray-100)',
  cellVerticalBorderColor: 'var(--color-gray-100)',
  cellSelectionBorderColor: 'var(--color-brand-blue)',
  cellSelectionBackgroundColor: 'var(--color-brand-blue)',
  headerFontWeight: '500',
  headerForegroundColor: 'var(--color-gray-600)',
  headerHighlightedForegroundColor: 'var(--color-gray-600)',
  headerHighlightedBackgroundColor: 'color-mix(in srgb, var(--color-brand-blue) 10%, var(--color-gray-50))',
  headerRowHighlightedForegroundColor: 'var(--color-gray-600)',
  headerRowHighlightedBackgroundColor: 'color-mix(in srgb, var(--color-brand-blue) 10%, var(--color-gray-50))',
  headerBackgroundColor: 'var(--color-gray-50)',
  rowHeaderOddBackgroundColor: 'var(--color-gray-50)',
  rowHeaderEvenBackgroundColor: 'var(--color-gray-50)',
  scrollbarThumbColor: 'var(--color-gray-200)',
  scrollbarBorderRadius: '0',
  readOnlyColor: 'var(--color-gray-600)',
  cellReadOnlyBackgroundColor: 'tokens.backgroundSecondaryColor',
  menuBorderRadius: '0',
  menuBorderColor: 'var(--color-gray-100)',
  menuShadowY: '2px',
  menuShadowBlur: '8px',
  menuShadowColor: 'var(--color-brand-black)',
  menuShadowOpacity: '6%',
  menuItemHoverColor: 'var(--color-brand-black)',
  menuItemHoverColorOpacity: '6%',
  menuItemActiveColor: 'var(--color-brand-blue)',
  menuItemActiveColorOpacity: '10%',
  shadowOpacity: '0%',
  dialogContentBorderRadius: '0',
  buttonBorderRadius: '0',
};
const SITE_THEME_CONFIG = {
  ...mainTheme,
  name: 'site',
  icons: horizonTheme.icons,
  tokens: { ...mainTheme.tokens, ...SITE_TOKENS },
  colorScheme: 'light',
  density: 'default',
};
const siteTheme = (hasTheme('site') ? reinitTheme(SITE_THEME_CONFIG) : undefined) ?? registerTheme(SITE_THEME_CONFIG);
const HOT_COMMON = { theme: siteTheme, licenseKey: 'non-commercial-and-evaluation' };

// Tabler outline glyphs (the design system's icon set), drawn inline.
const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON_PLUS = svg('<path d="M12 5v14"/><path d="M5 12h14"/>');
const ICON_X = svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>');
const ICON_EYE = svg('<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0-4 0"/><path d="M21 12c-2.4 4-5.4 6-9 6c-3.6 0-6.6-2-9-6c2.4-4 5.4-6 9-6c3.6 0 6.6 2 9 6"/>');

const $ = (sel) => document.querySelector(sel);
$('#max-rows').textContent = String(MAX_ROWS_PER_COLUMN);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let rows = [];            // array of plain objects; the data grid's source data
let sourceKeys = [];      // the original file columns (what gets sent to Jev)
let columns = [];         // Handsontable column definitions
let headers = [];         // matching colHeaders (HTML allowed)
const cellState = new WeakMap(); // rowObj -> { [key]: 'pending' | 'done' | 'err' }
const cellError = new WeakMap(); // rowObj -> { [key]: message }
const cellNote = new WeakMap();  // rowObj -> { [key]: tooltip }, e.g. the 0-1 score behind a Score label
// Jev column widths. Headers drive autosizing ("confidence" alone measured 148px), so both are fixed.
const VALUE_WIDTH = 110;
const CONF_WIDTH = 80;
let busy = false;
let added = [];           // one entry per added column, aligned with the config grid's rows: { key, confKey, name }
let sampleLoaded = false;
const hiddenKeys = new Set(); // source columns the user hid: not shown and not sent to Jev

// Hard-coded suggestions for the sample reviews; the button cycles through them.
const SUGGESTIONS = [
  ['Sentiment', 'How positive is this review overall?', 'Score', 'Very negative, Negative, Mixed, Positive, Very positive'],
  ['Category', 'Which category best fits the main issue in this review?', 'Choice', 'quality, shipping, price, support, usability'],
  ['Needs reply', 'Does this review warrant a reply from customer support?', 'Noul', ''],
];

// In recorded mode only the three suggestions can be added, exactly as suggested.
function isRecordedSuggestion(cfg) {
  return SUGGESTIONS.some(([name, prompt, type, options]) =>
    cfg.name === name && cfg.prompt === prompt && cfg.type === type.toLowerCase()
    && cfg.options.join(', ') === options);
}
let suggestIndex = 0;

// ---------------------------------------------------------------------------
// Config grid (one row: Name, Prompt, Type, Options, Add)
// ---------------------------------------------------------------------------
const CFG = { NAME: 0, PROMPT: 1, TYPE: 2, OPTIONS: 3, ADD: 4 };
// value -> label; the empty entry is the placeholder shown while nothing is chosen
const TYPE_OPTIONS = { '': 'Select a type…', Noul: 'Noul', Score: 'Score', Choice: 'Choice' };
let configHot; // assigned below; the Add renderer can run during construction
let lastConfigCell = { row: -1, col: -1 };

function openTypeEditor() {
  setTimeout(() => {
    const editor = configHot.getActiveEditor();
    if (editor && !editor.isOpened()) editor.beginEditing();
  }, 0);
}

// The last row of the config grid is the blank entry row; the rows above it are added columns.
const entryRow = () => added.length;

function readConfig(row = entryRow()) {
  const r = configHot ? configHot.getDataAtRow(row) : [];
  const typeRaw = r[CFG.TYPE];
  const type = String(Array.isArray(typeRaw) ? typeRaw[0] ?? '' : typeRaw ?? '').trim().toLowerCase();
  const name = String(r[CFG.NAME] ?? '').trim();
  const prompt = String(r[CFG.PROMPT] ?? '').trim();
  const options = String(r[CFG.OPTIONS] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { name, prompt, type, options };
}

function configIsValid(cfg = readConfig()) {
  if (!cfg.name || !cfg.prompt || !['noul', 'score', 'choice'].includes(cfg.type)) return false;
  if (cfg.type === 'choice' && new Set(cfg.options).size < 2) return false;
  if (cfg.type === 'score' && cfg.options.length && (cfg.options.length < 2 || cfg.options.length > 10)) return false;
  return true;
}

function addRenderer(instance, td, row) {
  td.className = 'add-cell htMiddle';
  if (row < added.length) {
    td.innerHTML = `<span class="icon-btn remove${busy ? ' disabled' : ''}" title="Remove this column">${ICON_X}</span>`;
    return;
  }
  const cfg = readConfig();
  const ready = configIsValid(cfg) && (LIVE || isRecordedSuggestion(cfg)) && !busy && rows.length > 0;
  const hint = !rows.length ? 'Load data first'
    : LIVE ? 'Fill in Jev Column Name, Prompt and Type first'
    : 'This preview replays the suggested columns: use Suggest a column';
  td.innerHTML = `<span class="icon-btn add${ready ? ' ready' : ''}" title="${ready ? 'Add this column' : hint}">${ICON_PLUS}</span>`;
}

configHot = new Handsontable($('#config-grid'), {
  ...HOT_COMMON,
  data: [['', '', '', '', '']],
  colHeaders: ['Jev Column Name', 'Prompt', 'Type', 'Options', 'Add'],
  className: 'htMiddle',
  columns: [
    { type: 'text' },
    { type: 'text' },
    // Native <select> (its picker is OS-level, so the one-row grid can't clip it), drawn with the
    // theme's dropdown arrow. It opens as soon as the cell is selected (see afterSelectionEnd).
    { type: 'select', selectOptions: TYPE_OPTIONS, renderer: 'autocomplete', placeholder: 'Select a type' },
    { type: 'text' },
    { readOnly: true, renderer: addRenderer },
  ],
  colWidths: [150, 260, 130, 200, 56],
  manualColumnResize: true,
  rowHeaders: false,
  height: 'auto',
  stretchH: 'all',
  cells(row, col) {
    // Rows above the entry row are added columns: locked, and the Type cell drops its arrow.
    if (row < added.length) {
      const meta = { readOnly: true, className: 'htMiddle htDimmed' };
      if (col === CFG.TYPE) meta.renderer = 'text';
      return meta;
    }
    // Recorded mode: the entry row is filled by Suggest a column only.
    if (!LIVE && col !== CFG.ADD) return { readOnly: true, ...(col === CFG.TYPE ? { renderer: 'text' } : {}) };
    return {};
  },
  afterChange(_changes, source) {
    if (source !== 'loadData') configHot.render();
  },
  afterSelectionEnd(row, col) {
    // Arriving at the Type cell by keyboard (Tab, arrows) opens its list. Only when the selection
    // actually moved: committing the editor with Enter re-selects the same cell and must not reopen it.
    const moved = lastConfigCell.row !== row || lastConfigCell.col !== col;
    lastConfigCell = { row, col };
    if (LIVE && moved && row === entryRow() && col === CFG.TYPE) openTypeEditor();
  },
  afterBeginEditing(_row, col) {
    if (col !== CFG.TYPE) return;
    const select = configHot.getActiveEditor()?.select;
    try { select?.showPicker?.(); } catch { /* needs a user gesture; the select is still focused */ }
  },
  afterOnCellMouseDown(_event, coords) {
    // A single click on the Type cell opens its list, even if the cell was already selected.
    if (LIVE && coords.row === entryRow() && coords.col === CFG.TYPE) openTypeEditor();
    if (coords.col !== CFG.ADD || busy) return;
    const cfg = readConfig();
    if (coords.row < added.length) removeColumn(coords.row);
    else if (coords.row === entryRow() && configIsValid(cfg) && (LIVE || isRecordedSuggestion(cfg)) && rows.length) addColumn(cfg);
  },
});

// ---------------------------------------------------------------------------
// Data grid
// ---------------------------------------------------------------------------
const dataHot = new Handsontable($('#data-grid'), {
  ...HOT_COMMON,
  data: [],
  columns: [],
  colHeaders: true,
  rowHeaders: false,
  className: 'htMiddle',
  manualColumnResize: true,
  columnSorting: true,
  filters: true,
  dropdownMenu: true,
  formulas: { engine: HyperFormula },
  hiddenColumns: { columns: [], indicators: false }, // driven by hiddenKeys, see gridSettings()
  exportFile: true, // the xlsx engine (ExcelJS) is attached on first use, see loadExcelJS()
  height: 'auto', // becomes a fixed, scrollable height once data is loaded
  width: '100%',
  stretchH: 'none',
  autoWrapRow: true,
  afterFilter: () => updateRowCount(),
});

// Layout slots: status line above the grid, row count below it.
const statusEl = document.createElement('div');
statusEl.className = 'slot-status';
const statusText = document.createElement('span');
statusText.className = 'status-text';
const statusSpacer = document.createElement('span');
statusSpacer.className = 'spacer';
const resetHiddenBtn = document.createElement('button');
resetHiddenBtn.type = 'button';
resetHiddenBtn.className = 'btn s';
resetHiddenBtn.hidden = true;
resetHiddenBtn.addEventListener('click', () => {
  hiddenKeys.clear();
  dataHot.updateSettings(gridSettings());
  setStatus('All columns are visible again, and all of them go to Jev.');
});
// The export buttons live in the page toolbar in the HTML; moving the nodes keeps their listeners.
statusEl.append(resetHiddenBtn, statusText, statusSpacer, $('#export-csv'), $('#export-xlsx'));
const countEl = document.createElement('div');
countEl.className = 'slot-count';
const layout = dataHot.getLayoutManager();
layout.register('status', statusEl, { side: 'top', weight: 100 });
layout.register('rowcount', countEl, { side: 'bottom', weight: 100 });
setStatus('No data yet. Upload a CSV or Excel file, or load the sample data.');
updateRowCount();

function loadRows(objects, keys) {
  rows = objects;
  sourceKeys = keys;
  hiddenKeys.clear();
  if (added.length) {
    added = [];
    configHot.updateSettings({ data: [['', '', '', '', '']] });
  }
  headers = keys.map(escapeHtml);
  columns = keys.map((k) => ({ data: k, type: 'text', className: 'htMiddle' }));
  dataHot.updateSettings({ data: rows, ...gridSettings(), height: 520 });
  // Decide widths and alignment from the *computed* values, so formula columns count too.
  // The first pass above let autoColumnSize measure each column's natural width.
  columns = keys.map((k, i) => describeColumn(k, dataHot.getDataAtProp(k), dataHot.getColWidth(i)));
  dataHot.updateSettings(gridSettings());
  // The column builder only makes sense once there are rows to classify; start on the Name cell.
  $('#define').hidden = false;
  configHot.render();
  configHot.selectCell(entryRow(), CFG.NAME);
  updateRowCount();
  const formulaCount = countFormulas(objects, keys);
  setStatus(`${rows.length} rows loaded${formulaCount ? ` with ${formulaCount} formula cells` : ''}.${
    rows.length > MAX_ROWS_PER_COLUMN ? ` Only the first ${MAX_ROWS_PER_COLUMN} will be classified per column.` : ''
  }`);
}

// Numeric columns: right-aligned, autosized. Long-text columns: wrapped at a fixed width.
// Other text columns: their autosized width, shrunk by TEXT_SHRINK.
function describeColumn(key, values, autoWidth) {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  const maxLen = present.reduce((m, v) => Math.max(m, String(v).length), key.length);
  const numeric = present.length > 0 && present.every((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))));
  const col = { data: key, type: 'text', className: numeric ? 'htRight htMiddle' : 'htMiddle', wordWrap: false };
  if (numeric) col.headerClassName = 'htRight'; // the header sits over its column
  const preset = PRESET_WIDTHS[key.trim().toLowerCase()];
  if (preset) {
    col.width = preset;
    return col;
  }
  if (numeric) return col;
  if (maxLen > LONG_TEXT_CHARS) {
    col.width = LONG_TEXT_WIDTH;
    col.wordWrap = true;
  } else if (autoWidth) {
    col.width = Math.max(60, Math.round(autoWidth * TEXT_SHRINK));
  }
  return col;
}

// Two header rows. An added column's name sits on top, spanning its "value" / "confidence" pair.
// Source columns keep their name on the bottom row (the only row Handsontable sorts from) with a
// hide button in the group cell above. `headers` stays flat for export.
// While no Jev column exists, an empty value/confidence pair sits at the right under a merged
// header that says what to do next. It is not part of `columns`/`headers`, so export never sees it.
const PLACEHOLDER = { key: '__jev_placeholder', confKey: '__jev_placeholder_conf', label: 'Add a Jev column to get started' };
const PLACEHOLDER_COLUMNS = [
  { data: PLACEHOLDER.key, readOnly: true, width: VALUE_WIDTH, className: 'htMiddle placeholder' },
  { data: PLACEHOLDER.confKey, readOnly: true, width: CONF_WIDTH, className: 'htMiddle placeholder' },
];
const showPlaceholder = () => rows.length > 0 && added.length === 0;

// Everything the data grid needs after columns change: the column list (plus the placeholder pair
// when it applies) and the matching nested headers.
function gridSettings() {
  const cols = showPlaceholder() ? [...columns, ...PLACEHOLDER_COLUMNS] : columns;
  // Hidden columns are kept by key, because adding or removing Jev columns rebuilds `columns`.
  const hidden = cols.flatMap((col, i) => (hiddenKeys.has(col.data) ? [i] : []));
  resetHiddenBtn.hidden = hiddenKeys.size === 0;
  resetHiddenBtn.innerHTML = `<span class="dot" aria-hidden="true">${ICON_EYE}</span><span>Reset hidden columns (${hiddenKeys.size})</span>`;
  return { columns: cols, ...headerSettings(cols), hiddenColumns: { columns: hidden, indicators: false } };
}

function headerSettings(cols = columns) {
  if (!cols.length) return { nestedHeaders: false, colHeaders: true };
  const top = [];
  const bottom = [];
  for (const col of cols) {
    const group = added.find((a) => a.key === col.data);
    const conf = added.find((a) => a.confKey === col.data);
    if (col.data === PLACEHOLDER.key) {
      top.push({ label: PLACEHOLDER.label, colspan: 2, headerClassName: 'htLeft' });
      bottom.push('value');
    } else if (col.data === PLACEHOLDER.confKey) {
      bottom.push('conf.');
    } else if (group) {
      // Group labels read from the left, whatever the alignment of the column under them.
      top.push({ label: escapeHtml(group.name), colspan: 2, headerClassName: 'htLeft' });
      bottom.push('value');
    } else if (conf) {
      bottom.push('conf.');
    } else {
      // The empty group cell above a source column holds its hide button.
      top.push(`<button type="button" class="hide-col" data-key="${escapeHtml(col.data)}" title="Hide this column and stop sending it to Jev">Hide</button>`);
      bottom.push(escapeHtml(col.data));
    }
  }
  return { nestedHeaders: [top, bottom] };
}

// Header hide buttons. Listened for in the capture phase on the grid's root so Handsontable never
// sees the press as a header click (which would select the column or open a menu).
dataHot.rootElement.addEventListener('mousedown', (event) => {
  const btn = event.target.closest?.('.hide-col');
  if (!btn) return;
  event.stopPropagation();
  event.preventDefault();
  if (busy) return setStatus('Wait for the current column to finish.');
  const key = btn.dataset.key;
  if (sourceKeys.filter((k) => !hiddenKeys.has(k)).length <= 1) return setStatus('Keep at least one column for Jev to read.');
  hiddenKeys.add(key);
  dataHot.updateSettings(gridSettings());
  setStatus(`Hid "${key}". Jev no longer receives it.`);
}, true);

function updateRowCount() {
  const total = dataHot.countSourceRows();
  const shown = dataHot.countRows();
  countEl.textContent = total === 0 ? 'No rows' : shown === total ? `${total} rows` : `${shown} of ${total} rows shown`;
}

// ---------------------------------------------------------------------------
// Renderers for Jev columns
// ---------------------------------------------------------------------------
const MY_CLASSES = ['pending', 'err', 'review'];
const confidenceBand = (c) => (c < 0.6 ? 'low' : c > 0.85 ? 'high' : 'mid');

function stateFor(instance, visualRow, key) {
  // getSourceDataAtRow() hands back a copy in Handsontable 18, so it cannot key the WeakMaps.
  // `rows` holds the original objects; the physical index is stable across sorting and filtering.
  const rowObj = rows[instance.toPhysicalRow(visualRow)];
  return { rowObj, state: cellState.get(rowObj)?.[key], error: cellError.get(rowObj)?.[key] };
}

function makeValueRenderer(key, type, confKey) {
  return function valueRenderer(instance, td, row, col, prop, value, cellProperties) {
    Handsontable.renderers.TextRenderer.apply(this, [instance, td, row, col, prop, formatValue(value, type), cellProperties]);
    td.classList.remove(...MY_CLASSES);
    td.removeAttribute('title');
    const { rowObj, state, error } = stateFor(instance, row, key);
    const note = cellNote.get(rowObj)?.[key];
    if (note) td.title = note;
    if (state === 'pending') {
      td.classList.add('pending');
      td.innerHTML = '<span class="thinking">Classifying…</span>';
    } else if (state === 'err') {
      td.classList.add('err');
      td.innerHTML = '<span class="failed">Failed</span>';
      td.title = error || 'Classification failed';
    } else {
      // An answer below the line asks a person to look: the review edge on the answer itself.
      const confidence = rowObj?.[confKey];
      if (typeof confidence === 'number' && confidenceBand(confidence) === 'low') td.classList.add('review');
    }
  };
}

function makeConfRenderer(key) {
  return function confRenderer(instance, td, row, col, prop, value, cellProperties) {
    Handsontable.renderers.TextRenderer.apply(this, [instance, td, row, col, prop, '', cellProperties]);
    td.classList.remove(...MY_CLASSES);
    const { state } = stateFor(instance, row, key);
    if (state === 'pending') td.classList.add('pending');
    else if (typeof value === 'number') {
      td.innerHTML = `<span class="badge ${confidenceBand(value)}">${Math.round(value * 100)}%</span>`;
    }
  };
}

function formatValue(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'noul' || type === 'score') return typeof value === 'number' ? value.toFixed(2) : String(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// The click sequence
// ---------------------------------------------------------------------------
async function addColumn(cfg) {
  busy = true;
  if (cfg.type === 'score' && !cfg.options.length) {
    // Make the default scale explicit in the grid rather than silently applied.
    cfg.options = [...DEFAULT_SCORE_LEVELS];
    configHot.setDataAtCell(entryRow(), CFG.OPTIONS, cfg.options.join(', '));
  }
  configHot.render();

  const key = uniqueKey(slug(cfg.name));
  const confKey = `${key}__conf`;

  // 1. Add the empty value + confidence columns and let them paint. Fixed widths: a Score or Choice
  // label wraps inside VALUE_WIDTH, a Noul probability is a short number, and "conf." fits CONF_WIDTH.
  columns.push({ data: key, readOnly: true, renderer: makeValueRenderer(key, cfg.type, confKey), className: cfg.type === 'noul' ? 'htRight htMiddle' : 'htMiddle', headerClassName: cfg.type === 'noul' ? 'htRight' : undefined, width: VALUE_WIDTH, wordWrap: cfg.type !== 'noul' });
  columns.push({ data: confKey, readOnly: true, renderer: makeConfRenderer(key), className: 'htRight htMiddle', headerClassName: 'htRight', width: CONF_WIDTH, wordWrap: false });
  headers.push(escapeHtml(cfg.name));
  headers.push(`${escapeHtml(cfg.name)} conf.`);
  added.push({ key, confKey, name: cfg.name });
  // Keep the definition as a locked row and open a fresh entry row below it.
  configHot.alter('insert_row_below', entryRow() - 1);
  const targets = rows.slice(0, MAX_ROWS_PER_COLUMN);
  dataHot.updateSettings(gridSettings()); // the first added column also retires the placeholder
  await paint();

  // 2. Mark the pending cells.
  for (const rowObj of targets) setState(rowObj, key, 'pending');
  dataHot.render();
  setStatus(`Classifying ${targets.length} rows as "${cfg.name}"…`);

  // 3–6. One call per row, limited concurrency, staggered fill, errors don't stop the rest.
  const start = performance.now();
  let done = 0;
  let failed = 0;
  await runPool(targets, CONCURRENCY, async (rowObj, i) => {
    const result = await classifyRow(rowObj, cfg);
    const wait = start + i * STAGGER_MS - performance.now();
    if (wait > 0) await sleep(wait);
    const physical = rows.indexOf(rowObj);
    if (result.ok) {
      setState(rowObj, key, 'done');
      // Score: the cell shows the level Jev picked; the 0-1 score sits in the cell's tooltip.
      const isScore = cfg.type === 'score' && result.label;
      if (isScore) {
        const notes = cellNote.get(rowObj) || {};
        notes[key] = `score ${Number(result.value).toFixed(2)}`;
        cellNote.set(rowObj, notes);
      }
      dataHot.setSourceDataAtCell(physical, key, isScore ? result.label : result.value);
      dataHot.setSourceDataAtCell(physical, confKey, result.confidence);
    } else {
      failed += 1;
      setState(rowObj, key, 'err', result.error);
      dataHot.setSourceDataAtCell(physical, key, null);
      dataHot.setSourceDataAtCell(physical, confKey, null);
    }
    done += 1;
    if (done % 5 === 0 || done === targets.length) setStatus(`"${cfg.name}": ${done}/${targets.length} rows${failed ? `, ${failed} failed` : ''}`);
  });

  dataHot.getPlugin('autoColumnSize').recalculateAllColumnsWidth();
  dataHot.render();
  busy = false;
  configHot.render();
  setStatus(`Added "${cfg.name}" to ${targets.length} rows in ${((performance.now() - start) / 1000).toFixed(1)}s${failed ? ` (${failed} failed)` : ''}.`);
}

function removeColumn(index) {
  const entry = added[index];
  if (!entry) return;
  added.splice(index, 1);
  for (const key of [entry.key, entry.confKey]) {
    const at = columns.findIndex((c) => c.data === key);
    if (at >= 0) {
      columns.splice(at, 1);
      headers.splice(at, 1);
    }
    for (const rowObj of rows) delete rowObj[key];
  }
  dataHot.updateSettings(gridSettings()); // removing the last column brings the placeholder back
  configHot.alter('remove_row', index);
  configHot.render();
  setStatus(`Removed "${entry.name}".`);
}

// The row as Jev should see it: computed values (formulas resolved), visible original columns only.
function rowPayload(rowObj) {
  const visual = dataHot.toVisualRow(rows.indexOf(rowObj));
  const row = {};
  for (const k of sourceKeys) {
    if (hiddenKeys.has(k)) continue;
    let v = visual === null || visual === undefined ? rowObj[k] : dataHot.getDataAtRowProp(visual, k);
    if (v === undefined) v = null;
    if (v !== null && typeof v === 'object') v = String(v);
    row[k] = v;
  }
  return row;
}

async function classifyRow(rowObj, cfg) {
  const payload = { type: cfg.type, prompt: cfg.prompt, row: rowPayload(rowObj) };
  if (cfg.type === 'choice' || (cfg.type === 'score' && cfg.options.length)) payload.options = cfg.options;

  if (!LIVE) {
    // Recorded answers, with a little latency so the cells still arrive one by one.
    await sleep(120 + Math.random() * 380);
    const answer = RECORDED[cfg.name]?.[String(rowObj.id)];
    return answer ? { ok: true, ...answer } : { ok: false, error: 'No recorded answer for this row' };
  }
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, value: data.value, confidence: data.confidence, label: data.label };
  } catch (e) {
    return { ok: false, error: 'Network error' };
  }
}

// ---------------------------------------------------------------------------
// Loading files: CSV via PapaParse, XLSX via ExcelJS (formulas kept)
// ---------------------------------------------------------------------------
$('#data-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) await loadFile(file);
});

async function loadSample() {
  try {
    await loadFile(new File([SAMPLE_CSV], 'sample-reviews.csv', { type: 'text/csv' }), { sample: true });
  } catch {
    setStatus('Could not load the sample data.');
  }
}
$('#load-sample').addEventListener('click', loadSample);

$('#suggest').addEventListener('click', () => {
  if (busy) return;
  // Next suggestion that isn't already an added column (falls back to plain cycling).
  let pick = SUGGESTIONS[suggestIndex % SUGGESTIONS.length];
  for (let i = 0; i < SUGGESTIONS.length; i += 1) {
    const candidate = SUGGESTIONS[(suggestIndex + i) % SUGGESTIONS.length];
    if (!added.some((a) => a.name === candidate[0])) {
      pick = candidate;
      suggestIndex += i;
      break;
    }
  }
  suggestIndex += 1;
  configHot.setDataAtCell(pick.map((v, col) => [entryRow(), col, v]), 'suggest');
  configHot.selectCell(entryRow(), CFG.ADD);
  configHot.render();
});

async function loadFile(file, { sample = false } = {}) {
  if (busy) return setStatus('Wait for the current column to finish.');
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) await loadXlsx(file);
    else await loadCsv(file);
    sampleLoaded = sample;
    $('#suggest').hidden = !sample;
  } catch (err) {
    setStatus(`Could not load ${file.name}: ${err && err.message ? err.message : err}`);
  }
}

function loadCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const keys = (res.meta.fields || []).filter(Boolean);
        if (!keys.length || !res.data.length) return reject(new Error('no rows found'));
        loadRows(res.data.map((r) => ({ ...r })), keys);
        resolve();
      },
      error: (err) => reject(err),
    });
  });
}

// ExcelJS is about a third of the bundle and only needed for Excel files, so it loads on first use.
let excelJS;
async function loadExcelJS() {
  if (!excelJS) {
    excelJS = (await import('exceljs')).default;
    dataHot.updateSettings({ exportFile: { engines: { xlsx: excelJS } } });
  }
  return excelJS;
}

// Reads the first worksheet. Row 1 is the header row. Formulas are kept as "=..." strings and
// their references are shifted up one row (the header row is not a data row) by letting
// HyperFormula delete that row, so ranges and absolute references stay correct.
async function loadXlsx(file) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets.find((ws) => ws.state !== 'veryHidden') || workbook.worksheets[0];
  if (!sheet || !sheet.dimensions) throw new Error('the workbook has no data');
  const { bottom, right } = sheet.dimensions;
  const grid = [];
  for (let r = 1; r <= bottom; r += 1) {
    const line = [];
    for (let c = 1; c <= right; c += 1) line.push(cellToValue(sheet.getCell(r, c)));
    grid.push(line);
  }
  if (grid.length < 2) throw new Error('the sheet needs a header row and at least one data row');

  const hf = HyperFormula.buildFromArray(grid, { licenseKey: 'gpl-v3' });
  hf.removeRows(0, [0, 1]);
  const body = hf.getSheetSerialized(0);
  hf.destroy();

  const keys = uniqueKeys(grid[0].map((h, i) => (h === null || h === '' ? `col${i + 1}` : String(h))));
  const objects = body.map((line) => Object.fromEntries(keys.map((k, i) => [k, line[i] === undefined ? null : line[i]])));
  loadRows(objects, keys);
}

function cellToValue(cell) {
  if (cell.formula) return `=${cell.formula}`;
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return typeof v.text === 'object' && v.text ? (v.text.richText || []).map((t) => t.text).join('') : String(v.text);
    if ('result' in v) return v.result === undefined ? null : v.result;
    if ('error' in v) return v.error;
    return String(v);
  }
  return v;
}

function countFormulas(objects, keys) {
  let n = 0;
  for (const o of objects) for (const k of keys) if (typeof o[k] === 'string' && o[k].startsWith('=')) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Export: CSV or Excel (formulas are written as formulas)
// ---------------------------------------------------------------------------
$('#export-csv').addEventListener('click', () => exportData('csv'));
$('#export-xlsx').addEventListener('click', () => exportData('xlsx'));

async function exportData(format) {
  if (!rows.length) return setStatus('Nothing to export yet.');
  if (busy) return setStatus('Wait for the current column to finish.');
  // Export a single flat header row ("Sentiment", "Sentiment conf.") instead of the nested pair.
  const plainHeaders = headers.map(headerText);
  dataHot.updateSettings({ columns, nestedHeaders: false, colHeaders: plainHeaders }); // no placeholder
  try {
    const plugin = dataHot.getPlugin('exportFile');
    // Hidden columns are exported too: hiding only limits what Jev reads.
    const options = { filename: 'jev-sheet_[YYYY]-[MM]-[DD]', colHeaders: true, rowHeaders: false, exportHiddenColumns: true };
    if (format === 'xlsx') await loadExcelJS();
    if (format === 'xlsx') await plugin.downloadFileAsync('xlsx', { ...options, exportFormulas: true });
    else plugin.downloadFile('csv', { ...options, bom: true });
    setStatus(`Exported ${dataHot.countRows()} rows as ${format === 'xlsx' ? 'Excel' : 'CSV'}.`);
  } catch (err) {
    setStatus(`Export failed: ${err && err.message ? err.message : err}`);
  } finally {
    dataHot.updateSettings(gridSettings());
  }
}

// Headers are HTML-escaped strings; export wants plain text.
function headerText(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setState(rowObj, key, state, error) {
  const s = cellState.get(rowObj) || {};
  s[key] = state;
  cellState.set(rowObj, s);
  if (error) {
    const e = cellError.get(rowObj) || {};
    e[key] = error;
    cellError.set(rowObj, e);
  }
}

async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// Two frames so new columns paint before their cells fill. Browsers pause frames in hidden tabs
// and throttle them in off-screen cross-origin iframes (the docs/blog embed), so time out too.
function paint() {
  const frames = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return Promise.race([frames, sleep(100)]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
}
function uniqueKey(base) {
  let key = `jev_${base}`;
  let n = 2;
  const taken = new Set(columns.map((c) => c.data));
  while (taken.has(key)) key = `jev_${base}_${n++}`;
  return key;
}
function uniqueKeys(keys) {
  const seen = new Map();
  return keys.map((k) => {
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}_${n}`;
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(msg) {
  statusText.textContent = msg;
}

// ---------------------------------------------------------------------------
// Recorded mode: say so, link to the live demo, and start from the sample
// ---------------------------------------------------------------------------
if (!LIVE) {
  document.body.classList.add('recorded');
  $('#preview-note').hidden = false;
  $('#full-demo').href = FULL_DEMO_URL;
  $('#privacy').textContent = 'This preview replays answers Jev gave for these 30 reviews. Nothing you do here is sent anywhere.';
  $('#hide-hint').hidden = true;
  loadSample();
}

// Small hook for scripted testing: window.jevSheet.loadFile(file), .exportData('csv'|'xlsx'), .dataHot
window.jevSheet = { loadFile, exportData, dataHot };
