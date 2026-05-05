/**
 * @file background.js
 * @description Service Worker фонового скрипта расширения Graphics Saver.
 *
 * Отвечает за:
 *   - регистрацию пунктов контекстного меню браузера;
 *   - обработку кликов по пунктам меню;
 *   - скачивание файлов через `chrome.downloads`;
 *   - инъекцию контент-скриптов по запросу пользователя.
 *
 * Все долгоживущие операции выполняются как промисы, что соответствует
 * модели Manifest V3 (Service Worker может быть выгружен между вызовами).
 *
 * Скачивание выполняется параллельно (`DOWNLOAD_CONCURRENCY` потоков)
 * через `GS.runConcurrent` из `lib.js`.
 */

'use strict';

importScripts('lib.js');

/** Идентификатор пункта меню для прямого скачивания изображения. */
const MENU_IMAGE = 'gs_save_image';

/** Идентификатор пункта меню для открытия диалога со списком изображений. */
const MENU_PAGE = 'gs_open_dialog';

/** Заголовок пункта меню (виден пользователю). */
const MENU_TITLE = 'Сохранить через Graphics saver';

/** Префикс для всех логов расширения. */
const LOG_PREFIX = '[Graphics Saver]';

/**
 * Файлы, внедряемые в активную вкладку для открытия диалога.
 * Порядок важен: сначала чистые утилиты (`lib.js`), затем модуль
 * обхода защиты (`bypass.js`), затем основной контент-скрипт.
 */
const CONTENT_INJECTION_FILES = ['lib.js', 'bypass.js', 'content.js'];

/** Параллельность скачивания пакета файлов. */
const DOWNLOAD_CONCURRENCY = 4;

/**
 * Логирует ошибки с единообразным префиксом.
 *
 * @param {string} message
 * @param {*} [details]
 */
function logError(message, details) {
  if (details !== undefined) {
    console.error(LOG_PREFIX, message, details);
  } else {
    console.error(LOG_PREFIX, message);
  }
}

/**
 * Создаёт пункты контекстного меню. Безопасно вызывать многократно:
 * перед созданием выполняется `removeAll()`.
 *
 * @returns {Promise<void>}
 */
async function setupContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: MENU_IMAGE,
    title: MENU_TITLE,
    contexts: ['image']
  });

  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: MENU_TITLE,
    contexts: ['page', 'frame', 'selection', 'link', 'editable', 'video', 'audio']
  });
}

chrome.runtime.onInstalled.addListener(function () {
  setupContextMenus().catch(function (err) { logError('Не удалось создать меню', err); });
});

chrome.runtime.onStartup.addListener(function () {
  setupContextMenus().catch(function (err) { logError('Не удалось пересоздать меню', err); });
});

chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  try {
    if (info.menuItemId === MENU_IMAGE && info.srcUrl) {
      await downloadOne(info.srcUrl, { saveAs: true });
    } else if (info.menuItemId === MENU_PAGE) {
      await openDialog(tab);
    }
  } catch (err) {
    logError('Ошибка обработки пункта меню', err);
  }
});

/**
 * Обработчик сообщений от content/popup-скриптов.
 *
 * Поддерживаемые типы:
 *   - `gs:download`     — { items?: Array<{url, filename?}>, urls?: string[], saveAs?: boolean }
 *   - `gs:open-dialog`  — открыть диалог в текущей вкладке.
 *
 * @param {object} msg
 * @param {chrome.runtime.MessageSender} sender
 * @param {function(any):void} sendResponse
 * @returns {boolean} — `true`, если ответ будет отправлен асинхронно.
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'gs:download') {
    const items = Array.isArray(msg.items)
      ? msg.items
      : (Array.isArray(msg.urls) ? msg.urls.map(function (url) { return { url: url }; }) : []);
    handleDownload(items, { saveAs: msg.saveAs === true })
      .then(sendResponse)
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
    return true;
  }

  if (msg.type === 'gs:open-dialog' && sender.tab) {
    openDialog(sender.tab)
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
    return true;
  }

  return false;
});

/**
 * Обрабатывает пакетное скачивание списка элементов.
 * Скачивает параллельно `DOWNLOAD_CONCURRENCY` файлов.
 * Не прерывается при ошибке отдельного файла — собирает все ошибки.
 *
 * @param {Array<string|{url: string, filename?: string}>} items
 * @param {{ saveAs?: boolean }} [opts]
 * @returns {Promise<{ok: boolean, count: number, total: number, errors: string[]}>}
 */
async function handleDownload(items, opts) {
  const options = opts || {};
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, count: 0, total: 0, errors: ['Нет URL для скачивания'] };
  }

  // При saveAs запускаем строго последовательно (иначе ОС покажет
  // несколько диалогов одновременно). Для бесшумного скачивания —
  // параллельно с ограничением concurrency.
  const concurrency = options.saveAs ? 1 : DOWNLOAD_CONCURRENCY;

  const results = await GS.runConcurrent(items, function (raw) {
    const item = typeof raw === 'string' ? { url: raw } : raw;
    return downloadOne(item.url, { saveAs: options.saveAs, filename: item.filename });
  }, concurrency);

  let saved = 0;
  const errors = [];
  for (const r of results) {
    if (r.ok) saved++;
    else errors.push(r.error && r.error.message || String(r.error));
  }

  return { ok: saved > 0, count: saved, total: items.length, errors: errors };
}

/**
 * Скачивает один файл через `chrome.downloads`.
 *
 * @param {string} url — http(s)/data: URL.
 * @param {{ saveAs?: boolean, filename?: string }} [opts]
 * @returns {Promise<number>} — id запущенной загрузки.
 * @throws {Error} — при пустом URL или ошибке `chrome.downloads`.
 */
async function downloadOne(url, opts) {
  const options = opts || {};
  if (!url) throw new Error('Пустой URL');

  return chrome.downloads.download({
    url: url,
    filename: options.filename || GS.makeFilename(url),
    saveAs: options.saveAs === true,
    conflictAction: 'uniquify'
  });
}

/**
 * Внедряет в активную вкладку набор скриптов, открывающих диалог.
 * Не требует широких host-разрешений — достаточно `activeTab`,
 * выданного по действию пользователя.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<void>}
 */
async function openDialog(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_INJECTION_FILES
    });
  } catch (err) {
    logError('Не удалось внедрить контент-скрипт', err);
    throw err;
  }
}
