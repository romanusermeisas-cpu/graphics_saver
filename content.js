/**
 * @file content.js
 * @description Контент-скрипт расширения Graphics Saver — точка входа,
 * собирающая изображения с активной страницы и отрисовывающая
 * модальный диалог в Shadow DOM.
 *
 * Загружается через `chrome.scripting.executeScript` после
 * предварительной загрузки `lib.js` и `bypass.js`.
 *
 * Архитектурные секции (см. разделители ниже):
 *   1. Константы и локализуемые строки.
 *   2. Помощники DOM и UI.
 *   3. Сборщик изображений (`collectImages`).
 *   4. Конвертер форматов (`convertImageUrl`, `prepareDownloadItem`).
 *   5. Рендерер диалога (`createDialog`).
 *   6. Точка входа (IIFE).
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // 1. Константы и строки
  // ═══════════════════════════════════════════════════════════════════

  /** Уникальный id корневого элемента диалога. */
  const HOST_ID = 'graphics-saver-host-7d3a91';

  /** Минимальная сторона SVG/canvas для включения в результат, px. */
  const MIN_VISUAL_SIZE = 32;

  /** Максимальное число элементов для обхода в поиске CSS-фонов. */
  const CSS_BG_SCAN_LIMIT = 5000;

  /** Качество кодирования для форматов с потерями (JPEG/WebP), 0..1. */
  const ENCODE_QUALITY = 0.92;

  /** Таймаут загрузки одного изображения для конвертации, мс. */
  const CONVERT_LOAD_TIMEOUT = 30000;

  /** Параллельность скачивания/конвертации. */
  const DOWNLOAD_CONCURRENCY = 4;

  /** Дебаунс поля поиска, мс. */
  const SEARCH_DEBOUNCE = 150;

  /** Атрибуты, в которых типично хранятся URL для lazy-загрузки. */
  const LAZY_IMG_ATTRS = [
    'data-src', 'data-lazy-src', 'data-original', 'data-original-src',
    'data-fallback-src', 'data-hi-res-src', 'data-image', 'data-bg', 'data-zoom-src'
  ];

  /** Локализуемые строки UI. Все user-facing тексты собраны здесь. */
  const STRINGS = {
    TITLE: 'Graphics Saver',
    CLOSE: 'Закрыть',
    CLOSE_HINT: 'Закрыть (Esc)',
    SEARCH_PLACEHOLDER: 'Поиск по URL или alt-тексту…',
    SELECT_ALL: 'Выбрать все',
    DESELECT_ALL: 'Снять всё',
    INVERT: 'Инвертировать',
    CANCEL: 'Отмена',
    STOP: 'Остановить',
    SAVE_SELECTED: 'Скачать выбранные',
    SAVE_ONE: 'Скачать',
    OPEN: 'Открыть',
    SORT: 'Сортировка',
    MIN_SIZE: 'Мин. размер',
    TYPE_FILTER: 'Тип',
    OUTPUT_FORMAT: 'Сохранять как',
    NO_IMAGES: 'На странице не найдено изображений',
    NO_MATCH: 'Ничего не найдено по запросу',
    LOADING: 'Сбор изображений…',
    CONVERTING: 'Конвертация',
    DOWNLOADING: 'Скачивание',
    DONE: '✓ Готово',
    SAVED: '✓ Сохранено',
    ERROR_SHORT: '⚠ Ошибка',
    DOWNLOAD_ERROR: 'Ошибка скачивания',
    UNKNOWN_ERROR: 'неизвестно',
    HOTKEY_HINT: 'Esc — закрыть · Ctrl+A — выбрать все · Ctrl+I — инвертировать · Enter — скачать'
  };

  /** Опции выпадающих списков. */
  const SORT_OPTIONS = [
    { value: 'size-desc', label: 'По размеру ↓' },
    { value: 'size-asc',  label: 'По размеру ↑' },
    { value: 'name-asc',  label: 'По имени А-Я' },
    { value: 'name-desc', label: 'По имени Я-А' },
    { value: 'order',     label: 'В порядке появления' }
  ];

  const MIN_SIZE_OPTIONS = [
    { value: '0',    label: 'Все' },
    { value: '128',  label: '≥ 128 px' },
    { value: '256',  label: '≥ 256 px' },
    { value: '512',  label: '≥ 512 px' },
    { value: '1024', label: '≥ 1024 px' }
  ];

  const TYPE_OPTIONS = [
    { value: 'all',  label: 'Все' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'png',  label: 'PNG' },
    { value: 'webp', label: 'WebP' },
    { value: 'avif', label: 'AVIF' },
    { value: 'gif',  label: 'GIF' },
    { value: 'svg',  label: 'SVG' },
    { value: 'bmp',  label: 'BMP' },
    { value: 'tiff', label: 'TIFF' },
    { value: 'heif', label: 'HEIC/HEIF' },
    { value: 'icon', label: 'Иконки' },
    { value: 'raw',  label: 'RAW' },
    { value: 'other',label: 'Прочее' }
  ];

  const OUTPUT_FORMAT_OPTIONS = [
    { value: 'original', label: 'Оригинал' },
    { value: 'png',      label: 'PNG' },
    { value: 'jpeg',     label: 'JPEG' },
    { value: 'webp',     label: 'WebP' }
  ];

  // ═══════════════════════════════════════════════════════════════════
  // 2. UI-помощники
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Создаёт DOM-элемент с заданными атрибутами и потомками.
   *
   * @param {string} tag
   * @param {Object<string, string>} [attrs]
   * @param {Array<Node|string>} [children]
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (const c of children) {
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  /**
   * Возвращает selectбокс с заранее заданным набором опций.
   *
   * @param {string} className
   * @param {Array<{value: string, label: string}>} options
   * @param {string} [value]
   * @param {string} [ariaLabel]
   * @returns {HTMLSelectElement}
   */
  function buildSelect(className, options, value, ariaLabel) {
    const sel = el('select', { class: className });
    if (ariaLabel) sel.setAttribute('aria-label', ariaLabel);
    for (const opt of options) {
      const o = el('option', { value: opt.value }, [opt.label]);
      if (opt.value === value) o.selected = true;
      sel.appendChild(o);
    }
    return sel;
  }

  /**
   * Безопасная отправка сообщения в background с обработкой
   * `chrome.runtime.lastError` (отсутствие колбэка может привести
   * к unhandled error в логах).
   *
   * @template T
   * @param {*} message
   * @returns {Promise<T>}
   */
  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || 'runtime error'));
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. Сборщик изображений
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Обходит DOM текущей страницы и собирает все доступные URL изображений.
   *
   * Источники сбора:
   *   - `<img>` (src, currentSrc, lazy-атрибуты, srcset, data-srcset);
   *   - `<picture><source>`, отдельные `<source>`;
   *   - CSS background-image / mask-image / border-image / list-style-image / cursor;
   *   - псевдо-элементы `::before` и `::after`;
   *   - inline SVG (сериализация в data-URL);
   *   - SVG `<image>` (href, xlink:href);
   *   - `<canvas>` (через `toDataURL`, если не tainted);
   *   - `<object>`, `<embed>` с типом изображения;
   *   - `<input type="image">`;
   *   - `<video poster="…">`;
   *   - метатеги Open Graph / Twitter Card / Schema.org / msapplication;
   *   - link-теги `rel="icon"`, `apple-touch-icon`, `mask-icon`, `image_src`;
   *   - прямые ссылки `<a href="*.jpg">`;
   *   - Shadow DOM (рекурсивный обход);
   *   - same-origin iframes.
   *
   * @returns {Array<{url: string, w: number, h: number, alt: string}>}
   *   Уникальные изображения в порядке появления.
   */
  function collectImages() {
    const map = new Map();

    function add(rawUrl, meta) {
      const url = GS.absoluteUrl(rawUrl, document.baseURI);
      if (!url) return;
      const m = meta || {};
      if (!map.has(url)) {
        map.set(url, { url, w: m.w || 0, h: m.h || 0, alt: m.alt || '' });
      } else if (m.w && m.h) {
        const existing = map.get(url);
        if (!existing.w || !existing.h) {
          existing.w = m.w;
          existing.h = m.h;
        }
      }
    }

    function walk(root) {
      if (!root || !root.querySelectorAll) return;

      for (const img of root.querySelectorAll('img')) {
        const meta = { w: img.naturalWidth, h: img.naturalHeight, alt: img.alt };
        add(img.currentSrc, meta);
        add(img.src, meta);
        for (const attr of LAZY_IMG_ATTRS) add(img.getAttribute(attr), meta);

        const srcset = img.srcset || img.getAttribute('data-srcset') || '';
        for (const u of GS.parseSrcset(srcset)) add(u, meta);
      }

      for (const source of root.querySelectorAll('source')) {
        const srcset = source.srcset || source.getAttribute('data-srcset') || '';
        for (const u of GS.parseSrcset(srcset)) add(u);
      }

      for (const link of root.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        if (href && GS.isImageUrl(href)) add(href);
      }

      let scanned = 0;
      for (const node of root.querySelectorAll('*')) {
        if (scanned++ > CSS_BG_SCAN_LIMIT) break;
        try {
          const cs = getComputedStyle(node);
          for (const u of GS.extractCssUrls(cs.backgroundImage)) add(u);
          for (const u of GS.extractCssUrls(cs.maskImage)) add(u);
          for (const u of GS.extractCssUrls(cs.webkitMaskImage)) add(u);
          for (const u of GS.extractCssUrls(cs.borderImageSource)) add(u);
          for (const u of GS.extractCssUrls(cs.listStyleImage)) add(u);
          for (const u of GS.extractCssUrls(cs.cursor)) add(u);

          for (const pseudo of ['::before', '::after']) {
            try {
              const cps = getComputedStyle(node, pseudo);
              for (const u of GS.extractCssUrls(cps.backgroundImage)) add(u);
              for (const u of GS.extractCssUrls(cps.content)) add(u);
              for (const u of GS.extractCssUrls(cps.borderImageSource)) add(u);
              for (const u of GS.extractCssUrls(cps.maskImage)) add(u);
            } catch (_) {}
          }
        } catch (_) {}
      }

      for (const svgImage of root.querySelectorAll('image')) {
        const href = svgImage.getAttribute('href') ||
                     svgImage.getAttribute('xlink:href') ||
                     (svgImage.href && svgImage.href.baseVal);
        if (href) add(href);
      }

      for (const obj of root.querySelectorAll('object[data]')) {
        const data = obj.getAttribute('data');
        const type = (obj.getAttribute('type') || '').toLowerCase();
        if (data && (type.startsWith('image/') || GS.isImageUrl(data))) add(data);
      }

      for (const embed of root.querySelectorAll('embed[src]')) {
        const src = embed.getAttribute('src');
        const type = (embed.getAttribute('type') || '').toLowerCase();
        if (src && (type.startsWith('image/') || GS.isImageUrl(src))) add(src);
      }

      for (const input of root.querySelectorAll('input[type="image"]')) {
        if (input.src) add(input.src, { alt: input.alt });
      }

      for (const video of root.querySelectorAll('video[poster]')) {
        add(video.getAttribute('poster'), { alt: 'Video poster' });
      }

      for (const svg of root.querySelectorAll('svg')) {
        const r = svg.getBoundingClientRect();
        if (r.width < MIN_VISUAL_SIZE || r.height < MIN_VISUAL_SIZE) continue;
        try {
          const xml = new XMLSerializer().serializeToString(svg);
          const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
          add(dataUrl, { w: Math.round(r.width), h: Math.round(r.height), alt: 'SVG' });
        } catch (_) {}
      }

      for (const canvas of root.querySelectorAll('canvas')) {
        if (canvas.width < MIN_VISUAL_SIZE || canvas.height < MIN_VISUAL_SIZE) continue;
        try {
          add(canvas.toDataURL('image/png'), { w: canvas.width, h: canvas.height, alt: 'Canvas' });
        } catch (_) {}
      }

      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    }

    walk(document);

    const metaSelectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[itemprop="image"]',
      'meta[name="thumbnail"]',
      'meta[name="msapplication-TileImage"]'
    ].join(',');
    for (const meta of document.querySelectorAll(metaSelectors)) {
      add(meta.getAttribute('content'), { alt: 'Meta image' });
    }

    const linkSelectors = [
      'link[rel~="icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]',
      'link[rel="apple-touch-startup-image"]',
      'link[rel="mask-icon"]',
      'link[rel="fluid-icon"]',
      'link[rel="image_src"]'
    ].join(',');
    for (const link of document.querySelectorAll(linkSelectors)) {
      add(link.getAttribute('href'), { alt: 'Icon' });
    }

    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) walk(frame.contentDocument);
      } catch (_) { /* cross-origin iframe — недоступен */ }
    }

    return Array.from(map.values());
  }

  /**
   * Запускает `collectImages` с уступкой управления, чтобы не блокировать
   * UI на огромных страницах.
   *
   * @returns {Promise<Array>}
   */
  function collectImagesAsync() {
    return new Promise(function (resolve) {
      const run = function () {
        try { resolve(collectImages()); }
        catch (e) { console.warn('[Graphics Saver]', e); resolve([]); }
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 1000 });
      } else {
        setTimeout(run, 0);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. Конвертер форматов
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Загружает изображение для последующего рендера в canvas.
   * Сначала пытается через fetch + ObjectURL (обходит CORS-taint),
   * затем — прямой `<img crossorigin="anonymous">`.
   *
   * @param {string} url
   * @param {AbortSignal} [signal]
   * @returns {Promise<{img: HTMLImageElement, cleanup: function():void}>}
   */
  function loadImageForConvert(url, signal) {
    return new Promise(function (resolve, reject) {
      let timeoutId = null;
      let aborted = false;

      const cleanup = function () { if (timeoutId) clearTimeout(timeoutId); };
      const reject_ = function (err) { cleanup(); reject(err); };

      timeoutId = setTimeout(function () {
        aborted = true;
        reject_(new Error('Таймаут загрузки изображения'));
      }, CONVERT_LOAD_TIMEOUT);

      if (signal) {
        if (signal.aborted) { reject_(makeAbort()); return; }
        signal.addEventListener('abort', function () {
          aborted = true;
          reject_(makeAbort());
        }, { once: true });
      }

      function makeAbort() {
        const e = new Error('Операция отменена');
        e.name = 'AbortError';
        return e;
      }

      function tryDirect(src, useCors) {
        if (aborted) return;
        const img = new Image();
        if (useCors) img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.onload = function () { cleanup(); resolve({ img, cleanup: function () {} }); };
        img.onerror = function () { reject_(new Error('Не удалось загрузить изображение')); };
        img.src = src;
      }

      if (url.startsWith('data:') || url.startsWith('blob:')) {
        tryDirect(url, false);
        return;
      }

      const fetchOpts = { mode: 'cors', credentials: 'include', referrerPolicy: 'no-referrer' };
      if (signal) fetchOpts.signal = signal;

      fetch(url, fetchOpts)
        .then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.blob();
        })
        .then(function (blob) {
          if (aborted) return;
          const objectUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = function () {
            cleanup();
            resolve({ img, cleanup: function () { URL.revokeObjectURL(objectUrl); } });
          };
          img.onerror = function () {
            URL.revokeObjectURL(objectUrl);
            tryDirect(url, true);
          };
          img.src = objectUrl;
        })
        .catch(function () { tryDirect(url, true); });
    });
  }

  /**
   * Конвертирует изображение по URL в указанный формат через HTML5 Canvas.
   *
   * @param {string} url
   * @param {string} format — `'png'`, `'jpeg'`, `'webp'`.
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>} — data URL.
   */
  async function convertImageUrl(url, format, signal) {
    const mime = GS.getMimeForFormat(format);
    if (!mime) throw new Error('Неподдерживаемый формат: ' + format);

    const { img, cleanup } = await loadImageForConvert(url, signal);
    try {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('Изображение имеет нулевой размер');

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D недоступен');

      // JPEG не поддерживает альфа-канал — заливаем фон белым.
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }

      ctx.drawImage(img, 0, 0, w, h);

      try {
        return canvas.toDataURL(mime, ENCODE_QUALITY);
      } catch (e) {
        throw new Error('Конвертация невозможна (CORS): ' + (e && e.message || e));
      }
    } finally {
      cleanup();
    }
  }

  /**
   * Скачивает blob: или http(s) URL и возвращает data: URL
   * с сохранением исходного MIME-типа.
   *
   * @param {string} url
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async function fetchToDataUrl(url, signal) {
    const opts = { mode: 'cors', credentials: 'include', referrerPolicy: 'no-referrer' };
    if (signal) opts.signal = signal;
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    return await new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('FileReader: не удалось прочитать blob')); };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Подготавливает один элемент к скачиванию.
   *
   *   - `format === 'original'`, обычный URL → отправка как есть.
   *   - `format === 'original'`, blob: URL → fetch+FileReader → data URL.
   *   - целевой формат → конвертация через canvas.
   *
   * @param {{url: string}} item
   * @param {string} format
   * @param {AbortSignal} [signal]
   * @returns {Promise<{url: string, filename: string}>}
   */
  async function prepareDownloadItem(item, format, signal) {
    if (!format || format === 'original') {
      if (item.url.startsWith('blob:')) {
        const dataUrl = await fetchToDataUrl(item.url, signal);
        return { url: dataUrl, filename: GS.makeFilename(dataUrl) };
      }
      return { url: item.url, filename: GS.makeFilename(item.url) };
    }
    const dataUrl = await convertImageUrl(item.url, format, signal);
    const ext = GS.getExtForFormat(format);
    return { url: dataUrl, filename: GS.makeFilename(item.url, ext) };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. Рендерер диалога
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Создаёт и показывает модальный диалог. Полностью инкапсулирован
   * в Shadow DOM (стили страницы не применяются).
   *
   * Поддерживает:
   *   - поиск с дебаунсом;
   *   - сортировку (5 режимов);
   *   - фильтр по минимальному размеру и категории формата;
   *   - выбор формата сохранения (Оригинал / PNG / JPEG / WebP);
   *   - мультивыбор + инверсию + «выбрать все» в текущей выборке;
   *   - параллельное скачивание/конвертацию (4 потока);
   *   - отмену длительной операции через AbortController;
   *   - прогресс-бар во время операции;
   *   - горячие клавиши (Esc, Ctrl+A, Ctrl+I, Enter);
   *   - focus trap внутри модалки;
   *   - тёмную тему и `prefers-reduced-motion`;
   *   - ARIA-атрибуты для скринридеров;
   *   - ленивую подгрузку превью (IntersectionObserver).
   */
  function createDialog() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    // Запрещаем Google/Chrome auto-translate портить нашу локализацию.
    host.setAttribute('translate', 'no');
    host.setAttribute('lang', 'ru');
    host.classList.add('notranslate'); // Google Translate Web API
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = renderShellHtml();
    document.documentElement.appendChild(host);

    const $ = function (sel) { return shadow.querySelector(sel); };

    const refs = {
      backdrop:    $('.gs-backdrop'),
      dialog:      $('.gs-dialog'),
      counter:     $('.gs-title-badge'),
      closeBtn:    $('.gs-close'),
      search:      $('.gs-search'),
      filtersHost: $('.gs-filters'),
      grid:        $('.gs-grid'),
      status:      $('.gs-status'),
      saveBtn:     $('[data-action="save"]'),
      cancelBtn:   $('[data-action="cancel"]'),
      stopBtn:     $('[data-action="stop"]'),
      toggleBtn:   $('[data-action="toggle-all"]'),
      invertBtn:   $('[data-action="invert"]'),
      progress:    $('.gs-progress'),
      progressBar: $('.gs-progress-bar')
    };

    // Фильтры строятся динамически (для удобной локализации).
    refs.sort      = buildSelect('gs-sort',     SORT_OPTIONS,            'size-desc', STRINGS.SORT);
    refs.minSize   = buildSelect('gs-min-size', MIN_SIZE_OPTIONS,        '0',         STRINGS.MIN_SIZE);
    refs.typeFilter= buildSelect('gs-type',     TYPE_OPTIONS,            'all',       STRINGS.TYPE_FILTER);
    refs.format    = buildSelect('gs-format',   OUTPUT_FORMAT_OPTIONS,   'original',  STRINGS.OUTPUT_FORMAT);

    refs.filtersHost.appendChild(filterGroup(STRINGS.SORT, refs.sort));
    refs.filtersHost.appendChild(filterGroup(STRINGS.MIN_SIZE, refs.minSize));
    refs.filtersHost.appendChild(filterGroup(STRINGS.TYPE_FILTER, refs.typeFilter));
    refs.filtersHost.appendChild(filterGroup(STRINGS.OUTPUT_FORMAT, refs.format));

    /** Группа «лейбл + select» для строки фильтров. */
    function filterGroup(label, control) {
      return el('label', { class: 'gs-filter-group' }, [
        el('span', { class: 'gs-filter-label' }, [label]),
        control
      ]);
    }

    let allItems = [];           // Полный список после сборки
    let visibleItems = [];       // После применения фильтров+сортировки
    const selected = new Set();  // URL'ы выбранных карточек
    let lazyObserver = null;
    let abortController = null;  // Активная операция (download/convert)
    let searchTimer = null;

    showLoading();
    bindUi();
    bindHotkeys();

    return {
      host: host,
      populate: populate
    };

    // ─────────────────────────────────────────────────────────────────

    function showLoading() {
      refs.grid.innerHTML = '';
      refs.grid.appendChild(el('div', { class: 'gs-empty' }, [STRINGS.LOADING]));
      refs.status.textContent = STRINGS.LOADING;
      refs.counter.textContent = '…';
    }

    /** Заполняет диалог собранными изображениями. */
    function populate(items) {
      allItems = Array.isArray(items) ? items : [];
      refs.counter.textContent = String(allItems.length);
      try {
        reflow();
      } catch (err) {
        console.error('[Graphics Saver] reflow failed:', err);
        refs.status.textContent = 'Ошибка отрисовки: ' + (err && err.message || err);
      }
      // Передаём фокус в поиск после отрисовки.
      setTimeout(function () { try { refs.search.focus(); } catch (_) {} }, 50);
    }

    /** Перевычисляет visibleItems и перерисовывает сетку. */
    function reflow() {
      const filtered = GS.filterImages(allItems, {
        search: refs.search.value,
        minSize: parseInt(refs.minSize.value, 10) || 0,
        category: refs.typeFilter.value
      });
      visibleItems = GS.sortImages(filtered, refs.sort.value);
      renderGrid();
      updateStatus();
    }

    function renderGrid() {
      if (lazyObserver) {
        lazyObserver.disconnect();
        lazyObserver = null;
      }
      refs.grid.innerHTML = '';

      if (visibleItems.length === 0) {
        refs.grid.appendChild(el('div', { class: 'gs-empty' }, [
          allItems.length === 0 ? STRINGS.NO_IMAGES : STRINGS.NO_MATCH
        ]));
        return;
      }

      lazyObserver = new IntersectionObserver(handleIntersect, {
        root: refs.grid, rootMargin: '400px 0px', threshold: 0.01
      });

      const frag = document.createDocumentFragment();
      for (const item of visibleItems) frag.appendChild(buildCard(item));
      refs.grid.appendChild(frag);
      refs.grid.querySelectorAll('.gs-thumb').forEach(function (img) { lazyObserver.observe(img); });
    }

    function handleIntersect(entries) {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const src = img.dataset.gsSrc;
        if (src && !img.src) img.src = src;
        if (lazyObserver) lazyObserver.unobserve(img);
      }
    }

    /**
     * Создаёт карточку одного изображения.
     * @param {{url: string, w: number, h: number, alt: string}} item
     * @returns {HTMLElement}
     */
    function buildCard(item) {
      const card = el('div', {
        class: 'gs-card' + (selected.has(item.url) ? ' gs-selected' : ''),
        tabindex: '0',
        role: 'checkbox',
        'aria-checked': selected.has(item.url) ? 'true' : 'false',
        'aria-label': GS.shortName(item.url)
      });

      const dims = item.w && item.h ? item.w + '×' + item.h : '';
      const cat = GS.classifyFormat(item.url).toUpperCase();

      card.innerHTML =
        '<div class="gs-thumb-wrap">' +
          '<img class="gs-thumb" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" />' +
          '<div class="gs-checkbox" aria-hidden="true">' + (selected.has(item.url) ? '✓' : '') + '</div>' +
          (cat && cat !== 'OTHER' ? '<div class="gs-badge">' + GS.escapeHtml(cat) + '</div>' : '') +
        '</div>' +
        '<div class="gs-meta">' +
          '<span class="gs-name" title="' + GS.escapeHtml(item.url) + '">' +
            GS.escapeHtml(GS.shortName(item.url)) + '</span>' +
          '<span class="gs-dims">' + GS.escapeHtml(dims) + '</span>' +
        '</div>' +
        '<div class="gs-actions">' +
          '<button data-act="save" type="button">' + STRINGS.SAVE_ONE + '</button>' +
          '<button data-act="open" type="button">' + STRINGS.OPEN + '</button>' +
        '</div>';

      const thumb = card.querySelector('.gs-thumb');
      thumb.dataset.gsSrc = item.url;

      // Двойная страховка: inline-стиль с !important применяется даже
      // если CSS-блок диалога был не доставлен (например, агрессивные
      // расширения-блокировщики или CSP). Вместе с правилами из
      // shellStyles() даёт 100%-ную гарантию квадратных превью.
      const wrap = card.querySelector('.gs-thumb-wrap');
      wrap.style.setProperty('height', '180px', 'important');
      wrap.style.setProperty('min-height', '180px', 'important');
      wrap.style.setProperty('display', 'block', 'important');

      thumb.addEventListener('error', function () {
        thumb.style.display = 'none';
        if (!card.querySelector('.gs-thumb-error')) {
          thumb.parentNode.appendChild(el('div', { class: 'gs-thumb-error' }, ['⚠']));
        }
      });

      card.querySelector('.gs-thumb-wrap').addEventListener('click', function () { toggleSelected(item.url, card); });

      card.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggleSelected(item.url, card);
        }
      });

      card.querySelector('[data-act="save"]').addEventListener('click', async function (e) {
        e.stopPropagation();
        const btn = e.currentTarget;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const prepared = await prepareDownloadItem(item, refs.format.value);
          const resp = await sendMessage({ type: 'gs:download', items: [prepared], saveAs: true });
          btn.disabled = false;
          if (resp && resp.ok) {
            btn.textContent = STRINGS.SAVED;
            setTimeout(function () { btn.textContent = original; }, 1500);
          } else {
            btn.textContent = STRINGS.ERROR_SHORT;
            setTimeout(function () { btn.textContent = original; }, 2000);
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = STRINGS.ERROR_SHORT;
          setTimeout(function () { btn.textContent = original; }, 2000);
          console.warn('[Graphics Saver]', err);
        }
      });

      card.querySelector('[data-act="open"]').addEventListener('click', function (e) {
        e.stopPropagation();
        window.open(item.url, '_blank', 'noopener');
      });

      return card;
    }

    function toggleSelected(url, card) {
      const wasSelected = selected.has(url);
      if (wasSelected) selected.delete(url);
      else selected.add(url);
      card.classList.toggle('gs-selected', !wasSelected);
      card.setAttribute('aria-checked', wasSelected ? 'false' : 'true');
      card.querySelector('.gs-checkbox').textContent = wasSelected ? '' : '✓';
      updateStatus();
    }

    function updateStatus() {
      const total = allItems.length;
      const shown = visibleItems.length;
      const sel = selected.size;
      let text;
      if (sel > 0) {
        text = 'Выбрано: ' + sel + (shown !== total ? ' · показано ' + shown + ' из ' + total
                                                    : ' из ' + total);
      } else if (shown !== total) {
        text = 'Показано: ' + shown + ' из ' + total;
      } else {
        text = 'Найдено: ' + total;
      }
      refs.status.textContent = text;
      refs.saveBtn.disabled = sel === 0;
      refs.saveBtn.textContent = sel > 0
        ? STRINGS.SAVE_SELECTED + ' (' + sel + ')'
        : STRINGS.SAVE_SELECTED;
    }

    // ── Привязки UI ─────────────────────────────────────────────────

    function bindUi() {
      refs.closeBtn.addEventListener('click', close);
      refs.cancelBtn.addEventListener('click', close);
      refs.backdrop.addEventListener('click', function (e) { if (e.target === refs.backdrop) close(); });


      [refs.sort, refs.minSize, refs.typeFilter].forEach(function (s) {
        s.addEventListener('change', reflow);
      });

      refs.search.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(reflow, SEARCH_DEBOUNCE);
      });

      refs.toggleBtn.addEventListener('click', function () {
        const allSel = visibleItems.length > 0 && visibleItems.every(function (i) { return selected.has(i.url); });
        if (allSel) visibleItems.forEach(function (i) { selected.delete(i.url); });
        else        visibleItems.forEach(function (i) { selected.add(i.url); });
        renderGrid();
        updateStatus();
      });

      refs.invertBtn.addEventListener('click', function () {
        for (const it of visibleItems) {
          if (selected.has(it.url)) selected.delete(it.url);
          else selected.add(it.url);
        }
        renderGrid();
        updateStatus();
      });

      refs.saveBtn.addEventListener('click', runBatchDownload);
      refs.stopBtn.addEventListener('click', function () {
        if (abortController) abortController.abort();
      });

      // Focus trap: Tab/Shift+Tab крутятся внутри диалога.
      refs.dialog.addEventListener('keydown', trapFocus);
    }

    function bindHotkeys() {
      document.addEventListener('keydown', onHotkey, true);
    }

    function onHotkey(e) {
      // Не реагируем, если фокус не внутри диалога.
      if (!host.shadowRoot.contains(e.target) && e.target !== host) {
        // Esc должен работать всегда, остальное — только если диалог открыт
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        return;
      }
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }

      const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'a' || e.key === 'A') {
          if (isInput) return; // не мешаем выделению в поиске
          e.preventDefault();
          visibleItems.forEach(function (i) { selected.add(i.url); });
          renderGrid();
          updateStatus();
        } else if (e.key === 'i' || e.key === 'I') {
          e.preventDefault();
          refs.invertBtn.click();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (!refs.saveBtn.disabled) runBatchDownload();
        }
      } else if (e.key === 'Enter' && !isInput) {
        if (!refs.saveBtn.disabled) {
          e.preventDefault();
          runBatchDownload();
        }
      }
    }

    function trapFocus(e) {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(refs.dialog.querySelectorAll(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )).filter(function (n) { return n.offsetParent !== null; });
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = shadow.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    // ── Пакетное скачивание ─────────────────────────────────────────

    async function runBatchDownload() {
      const sourceItems = allItems.filter(function (i) { return selected.has(i.url); });
      if (sourceItems.length === 0) return;

      abortController = new AbortController();
      enterBusyMode(sourceItems.length);

      const format = refs.format.value;
      const convertErrors = [];

      // Этап 1: подготовка (с конвертацией при необходимости) — параллельно.
      setProgress(0, sourceItems.length, format === 'original' ? STRINGS.DOWNLOADING : STRINGS.CONVERTING);
      const preparedResults = await GS.runConcurrent(sourceItems, function (it) {
        return prepareDownloadItem(it, format, abortController.signal);
      }, DOWNLOAD_CONCURRENCY, {
        signal: abortController.signal,
        onProgress: function (done, total, res) {
          setProgress(done, total, format === 'original' ? STRINGS.DOWNLOADING : STRINGS.CONVERTING);
          if (res && !res.ok && res.error && res.error.name !== 'AbortError') {
            convertErrors.push(res.error.message || String(res.error));
          }
        }
      });

      if (abortController.signal.aborted) {
        leaveBusyMode();
        refs.status.textContent = 'Операция отменена';
        return;
      }

      const prepared = preparedResults.filter(function (r) { return r.ok; }).map(function (r) { return r.value; });

      if (prepared.length === 0) {
        leaveBusyMode();
        refs.status.textContent = 'Не удалось подготовить файлы: ' + (convertErrors[0] || STRINGS.UNKNOWN_ERROR);
        return;
      }

      // Этап 2: отправка пакета фоновому скрипту.
      try {
        const resp = await sendMessage({ type: 'gs:download', items: prepared });
        leaveBusyMode();
        if (resp && resp.ok) {
          const note = convertErrors.length ? ' (пропущено ' + convertErrors.length + ')' : '';
          refs.status.textContent = 'Сохранено ' + resp.count + ' из ' + sourceItems.length + note;
          refs.saveBtn.textContent = STRINGS.DONE;
          setTimeout(close, 1000);
        } else {
          refs.status.textContent = STRINGS.DOWNLOAD_ERROR + ': ' +
            ((resp && resp.errors && resp.errors[0]) || STRINGS.UNKNOWN_ERROR);
        }
      } catch (err) {
        leaveBusyMode();
        refs.status.textContent = STRINGS.DOWNLOAD_ERROR + ': ' + (err && err.message || err);
      }
    }

    function enterBusyMode(total) {
      refs.saveBtn.disabled = true;
      refs.cancelBtn.style.display = 'none';
      refs.stopBtn.style.display = '';
      refs.progress.style.display = '';
      setProgress(0, total, STRINGS.CONVERTING);
    }

    function leaveBusyMode() {
      abortController = null;
      refs.saveBtn.disabled = false;
      refs.cancelBtn.style.display = '';
      refs.stopBtn.style.display = 'none';
      refs.progress.style.display = 'none';
      updateStatus();
    }

    function setProgress(done, total, label) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      refs.progressBar.style.width = pct + '%';
      refs.status.textContent = label + ' ' + done + '/' + total;
    }

    function close() {
      if (abortController) abortController.abort();
      if (lazyObserver) {
        lazyObserver.disconnect();
        lazyObserver = null;
      }
      document.removeEventListener('keydown', onHotkey, true);
      host.remove();
    }
  }

  /**
   * HTML-шаблон оболочки диалога (стили + статичная разметка).
   * Динамические части (selectбоксы, карточки) добавляются JS.
   *
   * @returns {string}
   */
  function renderShellHtml() {
    return [
      '<style>',
      shellStyles(),
      '</style>',
      '<div class="gs-backdrop">',
        '<div class="gs-dialog" role="dialog" aria-modal="true" aria-label="', STRINGS.TITLE, '">',
          '<header class="gs-header">',
            '<h2 class="gs-title">',
              STRINGS.TITLE,
              ' <span class="gs-title-badge" aria-label="Найдено изображений">…</span>',
            '</h2>',
            '<button class="gs-close" type="button" aria-label="', STRINGS.CLOSE, '" title="', STRINGS.CLOSE_HINT, '">×</button>',
          '</header>',
          '<div class="gs-toolbar" role="search">',
            '<input class="gs-search" type="search" placeholder="', STRINGS.SEARCH_PLACEHOLDER, '" autocomplete="off" aria-label="', STRINGS.SEARCH_PLACEHOLDER, '" />',
            '<button class="gs-btn gs-btn-ghost" data-action="toggle-all" type="button" title="Ctrl+A">', STRINGS.SELECT_ALL, '</button>',
            '<button class="gs-btn gs-btn-ghost" data-action="invert" type="button" title="Ctrl+I">', STRINGS.INVERT, '</button>',
          '</div>',
          '<div class="gs-filters" role="group"></div>',
          '<div class="gs-grid" role="list"></div>',
          '<div class="gs-progress" role="progressbar" aria-label="Прогресс операции" style="display:none">',
            '<div class="gs-progress-bar"></div>',
          '</div>',
          '<footer class="gs-footer">',
            '<span class="gs-status" role="status" aria-live="polite"></span>',
            '<div class="gs-footer-actions">',
              '<button class="gs-btn gs-btn-ghost" data-action="cancel" type="button">', STRINGS.CANCEL, '</button>',
              '<button class="gs-btn gs-btn-ghost" data-action="stop" type="button" style="display:none">', STRINGS.STOP, '</button>',
              '<button class="gs-btn gs-btn-primary" data-action="save" type="button" disabled title="Enter">', STRINGS.SAVE_SELECTED, '</button>',
            '</div>',
          '</footer>',
          '<div class="gs-hint" aria-hidden="true">', STRINGS.HOTKEY_HINT, '</div>',
        '</div>',
      '</div>'
    ].join('');
  }

  /** CSS диалога. Все правила scope'аны Shadow DOM. */
  function shellStyles() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .gs-backdrop {
        position: fixed; inset: 0;
        background: rgba(15, 23, 42, 0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        animation: gs-fade 160ms ease-out;
      }
      @keyframes gs-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes gs-pop {
        from { opacity: 0; transform: translateY(10px) scale(0.985); }
        to   { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .gs-backdrop, .gs-dialog { animation: none !important; }
        .gs-card { transition: none !important; }
      }
      .gs-dialog {
        width: min(960px, 100%);
        max-height: min(86vh, 800px);
        background: #ffffff;
        color: #0f172a;
        border-radius: 14px;
        box-shadow: 0 25px 75px rgba(2,6,23,0.35);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: gs-pop 200ms cubic-bezier(.2,.9,.3,1.2);
      }
      .gs-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 18px;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
        flex-shrink: 0;
      }
      .gs-title { font-size: 15px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
      .gs-title-badge {
        background: #2563eb; color: #fff;
        font-size: 11px; padding: 2px 9px; border-radius: 999px; font-weight: 600;
        min-width: 22px; text-align: center;
      }
      .gs-close {
        background: transparent; border: 0; padding: 0;
        width: 30px; height: 30px; border-radius: 6px;
        cursor: pointer; color: inherit;
        display: flex; align-items: center; justify-content: center;
        font-size: 20px; line-height: 1;
      }
      .gs-close:hover, .gs-close:focus-visible { background: rgba(15,23,42,0.08); outline: none; }
      .gs-toolbar {
        display: flex; gap: 8px; align-items: center;
        padding: 12px 18px;
        border-bottom: 1px solid #e2e8f0;
        flex-shrink: 0;
        flex-wrap: wrap;
      }
      .gs-search {
        flex: 1 1 200px; min-width: 0;
        padding: 8px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 13px;
        background: #fff;
        color: inherit;
        outline: none;
      }
      .gs-search:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
      .gs-filters {
        display: flex; flex-wrap: wrap; gap: 10px 14px;
        padding: 8px 18px 10px;
        border-bottom: 1px solid #e2e8f0;
        flex-shrink: 0;
        background: #fafbfc;
      }
      .gs-filter-group {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 12px; color: #64748b;
        white-space: nowrap;
      }
      .gs-filter-label { font-weight: 500; }
      .gs-sort, .gs-min-size, .gs-type, .gs-format {
        padding: 6px 24px 6px 8px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        font-size: 12px;
        background: #fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='%2364748b' d='M0 0l5 6 5-6z'/></svg>") no-repeat right 7px center;
        color: inherit;
        appearance: none;
        -webkit-appearance: none;
        -moz-appearance: none;
        cursor: pointer; outline: none;
      }
      .gs-sort:focus, .gs-min-size:focus, .gs-type:focus, .gs-format:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
      }
      .gs-btn {
        padding: 8px 14px;
        border: 1px solid transparent;
        border-radius: 8px;
        font-size: 13px; font-weight: 500;
        cursor: pointer; white-space: nowrap;
        transition: background 120ms, color 120ms;
        outline: none;
      }
      .gs-btn-primary { background: #2563eb; color: #fff; }
      .gs-btn-primary:hover:not(:disabled),
      .gs-btn-primary:focus-visible:not(:disabled) { background: #1d4ed8; }
      .gs-btn-primary:disabled { background: #94a3b8; cursor: not-allowed; opacity: 0.7; }
      .gs-btn-ghost { background: transparent; color: inherit; border-color: #cbd5e1; }
      .gs-btn-ghost:hover, .gs-btn-ghost:focus-visible { background: rgba(15,23,42,0.05); border-color: #94a3b8; }
      .gs-btn:focus-visible { box-shadow: 0 0 0 3px rgba(37,99,235,0.25); }
      .gs-grid {
        padding: 14px 18px;
        overflow-y: auto;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 12px;
        flex: 1 1 auto;
        min-height: 200px;
        align-content: start;
      }
      @media (max-width: 640px) {
        .gs-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; padding: 10px 12px; }
        .gs-filter-label { display: none; }
      }
      @media (min-width: 1280px) {
        .gs-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
      }
      /*
       * ВАЖНО: жёсткие размеры карточки + flex-basis превью с !important —
       * это намеренная защита от CSS-конфликтов в Shadow DOM на «тяжёлых»
       * сайтах (с inline-стилями, монитор-агентами, кастомными CSS-resets).
       * Эмпирически: на grabcad.com и подобных без !important высота
       * .gs-thumb-wrap коллапсировала в 0px, превращая карточки в полоски.
       * Не убирайте !important и max-height без полноценного регресс-теста.
       */
      .gs-card {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        overflow: hidden;
        background: #fff;
        display: flex !important;
        flex-direction: column !important;
        min-height: 260px !important;
        transition: transform 120ms, border-color 120ms, box-shadow 120ms;
        outline: none;
      }
      .gs-card:hover { transform: translateY(-1px); border-color: #94a3b8; }
      .gs-card:focus-visible { box-shadow: 0 0 0 3px rgba(37,99,235,0.35); border-color: #2563eb; }
      .gs-card.gs-selected { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.2); }
      .gs-thumb-wrap {
        position: relative !important;
        display: block !important;
        width: 100% !important;
        flex: 0 0 180px !important;
        height: 180px !important;
        min-height: 180px !important;
        max-height: 180px !important;
        background:
          linear-gradient(45deg, #f1f5f9 25%, transparent 25%) 0 0/16px 16px,
          linear-gradient(-45deg, #f1f5f9 25%, transparent 25%) 0 8px/16px 16px,
          linear-gradient(45deg, transparent 75%, #f1f5f9 75%) 8px -8px/16px 16px,
          linear-gradient(-45deg, transparent 75%, #f1f5f9 75%) -8px 0/16px 16px,
          #fff;
        overflow: hidden;
        cursor: pointer;
      }
      @media (max-width: 640px) {
        .gs-card { min-height: 200px !important; }
        .gs-thumb-wrap { flex-basis: 120px !important; height: 120px !important; min-height: 120px !important; max-height: 120px !important; }
      }
      @media (min-width: 1280px) {
        .gs-card { min-height: 290px !important; }
        .gs-thumb-wrap { flex-basis: 210px !important; height: 210px !important; min-height: 210px !important; max-height: 210px !important; }
      }
      .gs-thumb {
        position: absolute; inset: 0;
        width: 100% !important; height: 100% !important;
        max-width: 100%; max-height: 100%;
        object-fit: contain;
        display: block;
      }
      .gs-thumb-error {
        position: absolute; inset: 0;
        color: #94a3b8; font-size: 28px;
        display: flex; align-items: center; justify-content: center;
        background: #f8fafc;
      }
      .gs-checkbox {
        position: absolute; top: 8px; left: 8px;
        width: 22px; height: 22px;
        background: rgba(255,255,255,0.95);
        border: 1.5px solid #cbd5e1;
        border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; font-weight: 700; color: #2563eb;
        backdrop-filter: blur(4px);
      }
      .gs-card.gs-selected .gs-checkbox { background: #2563eb; color: #fff; border-color: #2563eb; }
      .gs-badge {
        position: absolute; top: 8px; right: 8px;
        background: rgba(15,23,42,0.75); color: #fff;
        font-size: 9px; font-weight: 700; letter-spacing: 0.4px;
        padding: 2px 6px; border-radius: 4px;
        backdrop-filter: blur(4px);
      }
      .gs-meta {
        padding: 8px 10px 4px;
        font-size: 11px; color: #64748b;
        display: flex; justify-content: space-between; gap: 6px;
        align-items: center;
      }
      .gs-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gs-dims { flex-shrink: 0; font-variant-numeric: tabular-nums; }
      .gs-actions { padding: 4px 10px 10px; display: flex; gap: 6px; }
      .gs-actions button {
        flex: 1;
        padding: 6px 4px;
        font-size: 11px;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
        background: transparent; color: inherit;
        cursor: pointer; transition: all 120ms;
        outline: none;
      }
      .gs-actions button:hover:not(:disabled),
      .gs-actions button:focus-visible:not(:disabled) {
        background: rgba(37,99,235,0.08);
        border-color: #2563eb; color: #2563eb;
      }
      .gs-actions button:disabled { opacity: 0.5; cursor: wait; }
      .gs-progress {
        height: 3px;
        background: #e2e8f0;
        flex-shrink: 0;
        overflow: hidden;
      }
      .gs-progress-bar {
        height: 100%; width: 0%;
        background: linear-gradient(90deg, #2563eb, #60a5fa);
        transition: width 200ms ease-out;
      }
      .gs-footer {
        display: flex; gap: 10px; align-items: center; justify-content: space-between;
        padding: 12px 18px;
        border-top: 1px solid #e2e8f0;
        background: #f8fafc;
        flex-shrink: 0;
      }
      .gs-status { font-size: 13px; color: #475569; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gs-footer-actions { display: flex; gap: 8px; flex-shrink: 0; }
      .gs-empty {
        padding: 60px 20px;
        text-align: center;
        color: #64748b;
        grid-column: 1 / -1;
        font-size: 14px;
      }
      .gs-hint {
        padding: 8px 18px;
        background: #f8fafc;
        border-top: 1px solid #e2e8f0;
        font-size: 11px; color: #94a3b8;
        text-align: center;
        flex-shrink: 0;
      }
      @media (max-width: 640px) {
        .gs-hint { display: none; }
      }
      @media (prefers-color-scheme: dark) {
        .gs-dialog { background: #0f172a; color: #e2e8f0; }
        .gs-header, .gs-footer, .gs-hint { background: #020617; border-color: #1e293b; }
        .gs-toolbar { background: #0f172a; border-color: #1e293b; }
        .gs-filters { background: #0a1322; border-color: #1e293b; }
        .gs-search,
        .gs-sort, .gs-min-size, .gs-type, .gs-format {
          background-color: #020617; border-color: #1e293b; color: #e2e8f0;
        }
        .gs-btn-ghost { border-color: #334155; }
        .gs-btn-ghost:hover, .gs-btn-ghost:focus-visible { background: rgba(255,255,255,0.05); border-color: #475569; }
        .gs-card { background: #1e293b; border-color: #334155; }
        .gs-card:hover { border-color: #64748b; }
        .gs-actions button { border-color: #334155; }
        .gs-thumb-wrap {
          background:
            linear-gradient(45deg, #1e293b 25%, transparent 25%) 0 0/16px 16px,
            linear-gradient(-45deg, #1e293b 25%, transparent 25%) 0 8px/16px 16px,
            linear-gradient(45deg, transparent 75%, #1e293b 75%) 8px -8px/16px 16px,
            linear-gradient(-45deg, transparent 75%, #1e293b 75%) -8px 0/16px 16px,
            #0f172a;
        }
        .gs-thumb-error { background: #1e293b; }
        .gs-checkbox { background: rgba(15,23,42,0.9); border-color: #475569; color: #60a5fa; }
        .gs-meta, .gs-status, .gs-empty, .gs-hint, .gs-filter-group { color: #94a3b8; }
        .gs-progress { background: #1e293b; }
        .gs-close:hover, .gs-close:focus-visible { background: rgba(255,255,255,0.08); }
      }
      @media (prefers-contrast: more) {
        .gs-card { border-width: 2px; }
        .gs-card.gs-selected { border-color: #1e40af; box-shadow: 0 0 0 3px #1e40af; }
        .gs-search:focus, .gs-btn:focus-visible { box-shadow: 0 0 0 3px #1e40af; }
      }
    `;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. Точка входа
  // ═══════════════════════════════════════════════════════════════════

  // Удаляем предыдущий диалог, если был.
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const dialog = createDialog();

  // Сборка изображений запускается асинхронно, чтобы дать диалогу
  // отрисоваться с состоянием «Сбор изображений…».
  collectImagesAsync()
    .then(function (items) { dialog.populate(items); })
    .catch(function (err) {
      console.error('[Graphics Saver] collectImagesAsync failed:', err);
      try { dialog.populate([]); } catch (_) {}
    });
})();
