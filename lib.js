/**
 * @file lib.js
 * @description Чистые утилитарные функции расширения Graphics Saver.
 *
 * Файл выполнен в формате UMD и работает в трёх окружениях:
 *   1. Node.js (для модульных тестов через `require`).
 *   2. Service Worker фонового скрипта (подключается через `importScripts`).
 *   3. Content script (загружается первым в `chrome.scripting.executeScript`,
 *      экспортирует функции в `globalThis.GS`).
 *
 * Все функции — детерминированные и не имеют побочных эффектов,
 * что позволяет покрывать их юнит-тестами без эмуляции DOM.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.GS = Object.assign(root.GS || {}, api);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /** Папка по умолчанию для скачиваемых файлов. */
  const DOWNLOAD_FOLDER = 'Graphics Saver';

  /** Расширение по умолчанию, если не удалось определить тип файла. */
  const DEFAULT_EXT = 'jpg';

  /** Максимальная длина имени файла (без расширения), символов. */
  const MAX_NAME_LENGTH = 120;

  /** Максимальная длина URL для обработки (защита от мусора в DOM). */
  const MAX_URL_LENGTH = 8192;

  /** Регулярное выражение допустимого расширения файла (2–5 alnum-символов). */
  const VALID_EXT_RE = /^[a-z0-9]{2,5}$/;

  /** Запрещённые в именах файлов символы (Windows + control codes). */
  // eslint-disable-next-line no-control-regex
  const ILLEGAL_FS_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;

  /**
   * Расширения, считающиеся изображениями для эвристики ссылок.
   * Список сгруппирован по категориям и охватывает практически все
   * известные форматы растровой и векторной графики, а также RAW
   * фотокамер всех основных производителей и научно-медицинскую
   * визуализацию.
   */
  const IMAGE_EXTENSIONS = [
    // JPEG-семейство
    'jpg', 'jpeg', 'jpe', 'jfif', 'jfi', 'pjpeg', 'pjp',
    // PNG-семейство
    'png', 'apng',
    // Анимированные / GIF
    'gif',
    // Современные веб-форматы
    'webp', 'avif', 'avifs', 'jxl', 'jxr', 'wdp', 'hdp',
    // BMP-семейство
    'bmp', 'dib',
    // Векторные
    'svg', 'svgz', 'eps', 'ai', 'cdr', 'wmf', 'emf', 'pict', 'pic',
    // TIFF
    'tif', 'tiff', 'btf', 'tf8', 'tf2',
    // Иконки
    'ico', 'cur', 'icns',
    // HEIF/HEIC (Apple)
    'heic', 'heif', 'heics', 'heifs', 'hif',
    // JPEG 2000
    'jp2', 'j2k', 'j2c', 'jpc', 'jpf', 'jpx', 'jpm', 'mj2',
    // QOI
    'qoi',
    // X Window
    'xbm', 'xpm',
    // Netpbm
    'pbm', 'pgm', 'ppm', 'pnm', 'pam', 'pfm',
    // 3D / игровые
    'dds', 'tga', 'icb', 'vda', 'vst', 'ktx', 'ktx2', 'pvr', 'astc',
    // Adobe / профессиональные
    'psd', 'psb', 'xcf', 'kra', 'ora',
    // RAW — Canon
    'cr2', 'cr3', 'crw',
    // RAW — Nikon
    'nef', 'nrw',
    // RAW — Sony
    'arw', 'srw', 'srf', 'sr2',
    // RAW — Adobe
    'dng',
    // RAW — Olympus
    'orf',
    // RAW — Panasonic
    'rw2', 'raw',
    // RAW — Fujifilm
    'raf',
    // RAW — Pentax
    'pef', 'ptx',
    // RAW — Hasselblad / Phase One / RED / Mamiya / Kodak / Casio / Leaf / Sigma
    '3fr', 'fff', 'iiq', 'r3d', 'mef', 'k25', 'kdc', 'dcr', 'mos', 'mrw',
    'bay', 'pxn', 'erf', 'rwz', 'rwl', 'x3f', 'ari', 'braw',
    // HDR / научные
    'hdr', 'exr', 'pic', 'fts', 'fit', 'fits',
    // Медицинская визуализация
    'dcm', 'dicom', 'dic',
    // Старые / нишевые
    'pcx', 'mng', 'jng', 'wbmp', 'art', 'flif', 'bpg',
    // Microsoft / Windows
    'jpegxr', 'hdp', 'wdp'
  ];

  /** Доступные форматы вывода встроенного конвертера. */
  const SUPPORTED_OUTPUT_FORMATS = ['original', 'png', 'jpeg', 'webp'];

  /** Сопоставление расширения файла → MIME-тип (для канвас-кодирования). */
  const FORMAT_MIME = {
    png:  'image/png',
    jpeg: 'image/jpeg',
    jpg:  'image/jpeg',
    webp: 'image/webp'
  };

  /** Сопоставление формата → нормализованное расширение файла. */
  const FORMAT_EXT = {
    png:  'png',
    jpeg: 'jpg',
    jpg:  'jpg',
    webp: 'webp'
  };

  /**
   * Очищает строку от символов, недопустимых в именах файлов
   * на популярных файловых системах (Windows/NTFS, ext4, APFS).
   *
   * @param {string} name — исходное имя.
   * @returns {string} — безопасное для ФС имя; не более `MAX_NAME_LENGTH` символов.
   */
  function sanitizeFilename(name) {
    if (typeof name !== 'string') return 'image';
    const cleaned = name.replace(ILLEGAL_FS_CHARS_RE, '_').slice(0, MAX_NAME_LENGTH);
    return cleaned || 'image';
  }

  /**
   * Формирует полный путь для сохранения файла в папку `Graphics Saver`.
   *
   * Поддерживает обычные HTTP(S) URL и data:URL вида `data:image/...;base64,...`.
   * Если расширение не удаётся определить, подставляется значение `DEFAULT_EXT`.
   *
   * @param {string} url — исходный URL изображения.
   * @param {string} [forceExt] — принудительное расширение (без точки),
   *   используется встроенным конвертером для смены формата.
   * @returns {string} — относительный путь (например, `"Graphics Saver/cat.jpg"`).
   */
  function makeFilename(url, forceExt) {
    let name = 'image';
    let ext = DEFAULT_EXT;

    if (typeof url !== 'string' || url.length === 0) {
      const finalExt = normalizeExt(forceExt) || ext;
      return `${DOWNLOAD_FOLDER}/image_${Date.now()}.${finalExt}`;
    }

    try {
      if (url.startsWith('data:')) {
        const m = url.match(/^data:image\/([a-z0-9.+-]+)[;,]/i);
        if (m) {
          const mime = m[1].toLowerCase();
          ext = mime === 'svg+xml' ? 'svg' : (mime === 'jpeg' ? 'jpg' : mime);
        }
        name = `image_${Date.now()}`;
      } else {
        const u = new URL(url);
        const last = decodeURIComponent(u.pathname.split('/').pop() || '');
        if (last) {
          const dot = last.lastIndexOf('.');
          if (dot > 0 && dot < last.length - 1) {
            name = last.slice(0, dot);
            const candidate = last.slice(dot + 1).toLowerCase();
            if (VALID_EXT_RE.test(candidate)) ext = candidate;
          } else {
            name = last;
          }
        }
      }
    } catch (_) {
      name = `image_${Date.now()}`;
    }

    const finalExt = normalizeExt(forceExt) || ext;
    return `${DOWNLOAD_FOLDER}/${sanitizeFilename(name)}.${finalExt}`;
  }

  /**
   * Нормализует расширение: убирает ведущую точку, приводит к нижнему регистру,
   * проверяет на соответствие шаблону.
   *
   * @param {string} ext
   * @returns {string|null} — валидное расширение или `null`.
   */
  function normalizeExt(ext) {
    if (typeof ext !== 'string') return null;
    const cleaned = ext.replace(/^\./, '').toLowerCase();
    return VALID_EXT_RE.test(cleaned) ? cleaned : null;
  }

  /**
   * Возвращает MIME-тип для имени формата конвертера.
   *
   * @param {string} format — `'png'`, `'jpeg'`, `'jpg'`, `'webp'`.
   * @returns {string|null} — MIME-тип или `null`, если формат не поддерживается.
   */
  function getMimeForFormat(format) {
    if (typeof format !== 'string') return null;
    return FORMAT_MIME[format.toLowerCase()] || null;
  }

  /**
   * Возвращает нормализованное расширение файла для имени формата.
   *
   * @param {string} format — `'png'`, `'jpeg'`, `'jpg'`, `'webp'`.
   * @returns {string|null} — расширение без точки или `null`.
   */
  function getExtForFormat(format) {
    if (typeof format !== 'string') return null;
    return FORMAT_EXT[format.toLowerCase()] || null;
  }

  /**
   * Проверяет, является ли формат допустимым целевым форматом
   * встроенного конвертера на базе HTML5 Canvas.
   *
   * Замечание: AVIF, GIF, SVG и большинство «экзотических» форматов
   * браузерным канвасом не кодируются.
   *
   * @param {string} format
   * @returns {boolean}
   */
  function isCanvasEncodableFormat(format) {
    return getMimeForFormat(format) !== null;
  }

  /**
   * Разбирает атрибут `srcset` и возвращает список URL-кандидатов.
   *
   * Дескрипторы плотности (`1x`, `2x`) и ширины (`320w`) игнорируются.
   * Пустые элементы и пробелы корректно отбрасываются.
   *
   * @param {string} srcset — значение атрибута `srcset` или `data-srcset`.
   * @returns {string[]} — массив URL-кандидатов в порядке появления.
   *
   * @example
   *   parseSrcset('a.jpg 1x, b.jpg 2x'); // → ['a.jpg', 'b.jpg']
   */
  function parseSrcset(srcset) {
    if (!srcset || typeof srcset !== 'string') return [];
    const result = [];
    for (const part of srcset.split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) result.push(url);
    }
    return result;
  }

  /**
   * Преобразует относительный URL в абсолютный.
   *
   * Возвращает `null` для пустых, мусорных и опасных URL
   * (`javascript:`, превышающих `MAX_URL_LENGTH`).
   * Схемы `data:` и `blob:` возвращаются без изменений.
   *
   * @param {string|null|undefined} u — исходный URL (может быть относительным).
   * @param {string} [baseUrl] — базовый URL (по умолчанию `document.baseURI`, если доступен).
   * @returns {string|null} — абсолютный URL или `null`.
   */
  function absoluteUrl(u, baseUrl) {
    if (u === null || u === undefined) return null;
    const trimmed = String(u).trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_URL_LENGTH) return null;
    if (/^javascript:/i.test(trimmed)) return null;
    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;

    const base = baseUrl || (typeof document !== 'undefined' ? document.baseURI : undefined);
    try {
      return new URL(trimmed, base).href;
    } catch (_) {
      return null;
    }
  }

  /**
   * Экранирует символы HTML для безопасной вставки в `innerHTML` или атрибуты.
   *
   * @param {*} s — любое значение, будет приведено к строке.
   * @returns {string} — экранированная строка.
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default:  return c;
      }
    });
  }

  /**
   * Возвращает короткое отображаемое имя для URL.
   *
   * Из обычного URL берётся последний сегмент пути; если он длинный,
   * сокращается до 26 символов с многоточием посередине.
   * Для `data:` URL возвращается префикс с многоточием.
   *
   * @param {string} url — исходный URL.
   * @param {number} [maxLen=26] — максимальная длина результата.
   * @returns {string} — короткое имя для UI.
   */
  function shortName(url, maxLen) {
    const max = typeof maxLen === 'number' && maxLen > 6 ? maxLen : 26;
    if (typeof url !== 'string') return '';
    if (url.startsWith('data:')) return url.slice(0, max - 1) + '…';
    try {
      const u = new URL(url);
      let n = decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
      if (n.length > max) {
        const head = Math.max(3, Math.floor((max - 1) * 0.55));
        const tail = Math.max(2, max - 1 - head);
        n = n.slice(0, head) + '…' + n.slice(-tail);
      }
      return n;
    } catch (_) {
      return url.slice(0, max - 1) + '…';
    }
  }

  /**
   * Извлекает URL-ы из CSS-значения (например, `background-image`).
   *
   * Поддерживаются формы: `url(x)`, `url("x")`, `url('x')`,
   * множественные значения через запятую, градиенты с `url(...)` внутри.
   * Якорные ссылки (`#id`) и пустые URL отбрасываются.
   *
   * @param {string} value — CSS-значение.
   * @returns {string[]} — список найденных URL-ов.
   */
  function extractCssUrls(value) {
    if (!value || value === 'none' || typeof value !== 'string') return [];
    const result = [];
    const re = /url\((['"]?)([^'")]+)\1\)/g;
    let m;
    while ((m = re.exec(value)) !== null) {
      const u = m[2].trim();
      if (u && !u.startsWith('#')) result.push(u);
    }
    return result;
  }

  /**
   * Проверяет, выглядит ли URL как ссылка на изображение по расширению.
   *
   * Используется для эвристики «ссылка на изображение» (`<a href="...">`),
   * когда сам элемент `<img>` не используется.
   *
   * @param {string} url — проверяемый URL.
   * @returns {boolean}
   */
  function isImageUrl(url) {
    if (typeof url !== 'string') return false;
    const m = url.match(/\.([a-z0-9]{2,8})(?:[?#]|$)/i);
    if (!m) return false;
    return IMAGE_EXTENSIONS.indexOf(m[1].toLowerCase()) !== -1;
  }

  /**
   * Сопоставление расширения файла → категория формата для UI-фильтра.
   *
   * Категории:
   *   - `'jpeg'`, `'png'`, `'webp'`, `'gif'`, `'svg'`, `'avif'`,
   *     `'bmp'`, `'tiff'`, `'heif'` — основные форматы;
   *   - `'icon'` — иконки и курсоры;
   *   - `'raw'` — RAW фотокамер;
   *   - `'other'` — всё остальное.
   */
  const EXTENSION_CATEGORY_MAP = (function () {
    const m = {};
    const groups = {
      jpeg: ['jpg', 'jpeg', 'jpe', 'jfif', 'jfi', 'pjpeg', 'pjp'],
      png:  ['png', 'apng'],
      webp: ['webp'],
      gif:  ['gif'],
      svg:  ['svg', 'svgz'],
      avif: ['avif', 'avifs'],
      bmp:  ['bmp', 'dib'],
      tiff: ['tif', 'tiff', 'btf', 'tf8', 'tf2'],
      heif: ['heic', 'heif', 'heics', 'heifs', 'hif'],
      icon: ['ico', 'cur', 'icns'],
      raw:  ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srw', 'srf', 'sr2',
             'dng', 'orf', 'rw2', 'raw', 'raf', 'pef', 'ptx',
             '3fr', 'fff', 'iiq', 'r3d', 'mef', 'k25', 'kdc', 'dcr',
             'mos', 'mrw', 'bay', 'pxn', 'erf', 'rwz', 'rwl', 'x3f',
             'ari', 'braw']
    };
    for (const cat in groups) {
      for (const ext of groups[cat]) m[ext] = cat;
    }
    return m;
  })();

  /**
   * Определяет категорию изображения по URL для UI-фильтра.
   * Учитывает как обычные URL с расширением, так и data:image/*.
   *
   * @param {string} url — URL изображения.
   * @returns {string} — категория: `'jpeg'`, `'png'`, `'webp'`, `'gif'`,
   *   `'svg'`, `'avif'`, `'bmp'`, `'tiff'`, `'heif'`, `'icon'`, `'raw'`,
   *   `'other'`.
   */
  function classifyFormat(url) {
    if (typeof url !== 'string' || !url) return 'other';

    if (url.startsWith('data:image/')) {
      const m = url.match(/^data:image\/([a-z0-9.+-]+)[;,]/i);
      if (m) {
        let mime = m[1].toLowerCase();
        if (mime === 'svg+xml') return 'svg';
        if (mime === 'jpeg') return 'jpeg';
        if (mime === 'x-icon' || mime === 'vnd.microsoft.icon') return 'icon';
        return EXTENSION_CATEGORY_MAP[mime] || 'other';
      }
      return 'other';
    }

    const m = url.match(/\.([a-z0-9]{2,8})(?:[?#]|$)/i);
    if (!m) return 'other';
    return EXTENSION_CATEGORY_MAP[m[1].toLowerCase()] || 'other';
  }

  /**
   * Сортирует список изображений согласно режиму. Не мутирует входной массив.
   *
   * Поддерживаемые режимы:
   *   - `'size-desc'` — по убыванию площади (по умолчанию);
   *   - `'size-asc'` — по возрастанию площади;
   *   - `'name-asc'` / `'name-desc'` — по имени файла;
   *   - `'order'` — исходный порядок (стабильная копия).
   *
   * @template {{url: string, w: number, h: number}} T
   * @param {T[]} items
   * @param {string} mode
   * @returns {T[]}
   */
  function sortImages(items, mode) {
    if (!Array.isArray(items)) return [];
    const arr = items.slice();
    const nameOf = (i) => {
      try {
        if (i.url.startsWith('data:')) return '';
        return new URL(i.url).pathname.split('/').pop() || '';
      } catch (_) { return ''; }
    };
    switch (mode) {
      case 'size-asc':
        return arr.sort((a, b) => (a.w * a.h) - (b.w * b.h));
      case 'name-asc':
        return arr.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      case 'name-desc':
        return arr.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
      case 'order':
        return arr;
      case 'size-desc':
      default:
        return arr.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    }
  }

  /**
   * Применяет к списку изображений набор фильтров.
   * Не мутирует входной массив.
   *
   * @template {{url: string, w: number, h: number, alt?: string}} T
   * @param {T[]} items
   * @param {{ search?: string, minSize?: number, category?: string }} criteria
   * @returns {T[]}
   */
  function filterImages(items, criteria) {
    if (!Array.isArray(items)) return [];
    const c = criteria || {};
    const search = c.search ? String(c.search).toLowerCase().trim() : '';
    const minSize = typeof c.minSize === 'number' && c.minSize > 0 ? c.minSize : 0;
    const category = c.category && c.category !== 'all' ? c.category : null;

    return items.filter(function (i) {
      if (search) {
        const url = (i.url || '').toLowerCase();
        const alt = (i.alt || '').toLowerCase();
        if (url.indexOf(search) === -1 && alt.indexOf(search) === -1) return false;
      }
      if (minSize) {
        const side = Math.max(i.w || 0, i.h || 0);
        if (side > 0 && side < minSize) return false;
      }
      if (category && classifyFormat(i.url) !== category) return false;
      return true;
    });
  }

  /**
   * Форматирует размер в байтах в человекочитаемую строку.
   *
   * @param {number} bytes
   * @param {number} [decimals=1]
   * @returns {string} — например, `"1.5 МБ"`, `"320 КБ"`, `"512 Б"`.
   */
  function formatBytes(bytes, decimals) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const k = 1024;
    const d = typeof decimals === 'number' ? decimals : 1;
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    const v = bytes / Math.pow(k, i);
    return (i === 0 ? Math.round(v) : v.toFixed(d)) + ' ' + units[i];
  }

  /**
   * Запускает массив async-задач с ограниченным числом параллельных
   * выполнений (worker pool). Сохраняет порядок результатов.
   * Поддерживает отмену через AbortSignal и колбэк прогресса.
   *
   * @template T, R
   * @param {T[]} items — входные элементы.
   * @param {function(T, number): Promise<R>} task — async-функция-обработчик.
   * @param {number} [limit=4] — максимум параллельных задач.
   * @param {{ signal?: AbortSignal, onProgress?: function(number, number, {ok: boolean, value?: R, error?: Error}): void }} [opts]
   * @returns {Promise<Array<{ ok: boolean, value?: R, error?: Error }>>}
   *   Массив результатов в исходном порядке. При отмене незапущенные
   *   задачи помечаются `{ ok: false, error: AbortError }`.
   */
  async function runConcurrent(items, task, limit, opts) {
    const list = Array.isArray(items) ? items : [];
    const lim = Math.max(1, Math.min(typeof limit === 'number' ? limit : 4, list.length || 1));
    const options = opts || {};
    const signal = options.signal;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    const results = new Array(list.length);
    let cursor = 0;
    let completed = 0;

    function makeAbortError() {
      const err = new Error('Операция отменена');
      err.name = 'AbortError';
      return err;
    }

    async function worker() {
      while (cursor < list.length) {
        const i = cursor++;
        if (signal && signal.aborted) {
          results[i] = { ok: false, error: makeAbortError() };
          completed++;
          if (onProgress) onProgress(completed, list.length, results[i]);
          continue;
        }
        try {
          const value = await task(list[i], i);
          results[i] = { ok: true, value };
        } catch (error) {
          results[i] = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
        }
        completed++;
        if (onProgress) onProgress(completed, list.length, results[i]);
      }
    }

    if (list.length === 0) return results;

    const workers = [];
    for (let w = 0; w < lim; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  return {
    DOWNLOAD_FOLDER,
    DEFAULT_EXT,
    MAX_NAME_LENGTH,
    MAX_URL_LENGTH,
    IMAGE_EXTENSIONS,
    SUPPORTED_OUTPUT_FORMATS,
    FORMAT_MIME,
    FORMAT_EXT,
    sanitizeFilename,
    makeFilename,
    normalizeExt,
    getMimeForFormat,
    getExtForFormat,
    isCanvasEncodableFormat,
    parseSrcset,
    absoluteUrl,
    escapeHtml,
    shortName,
    extractCssUrls,
    isImageUrl,
    classifyFormat,
    sortImages,
    filterImages,
    formatBytes,
    runConcurrent
  };
});
