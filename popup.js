/**
 * @file popup.js
 * @description Логика всплывающего окна (popup) расширения Graphics Saver.
 *
 * Используется как резервный способ открыть диалог изображений на сайтах,
 * перехватывающих событие `contextmenu` и блокирующих браузерное меню.
 * Также позволяет вручную снять защиту страницы от копирования через
 * инъекцию `bypass.js` без открытия диалога.
 *
 * Файл `bypass.js` переиспользуется и фоновым скриптом, и popup'ом —
 * единая точка истины для логики обхода (DRY).
 */

'use strict';

/** Скрипты, внедряемые при открытии диалога. */
const DIALOG_FILES = ['lib.js', 'bypass.js', 'content.js'];

/** Скрипты, внедряемые только для снятия защиты. */
const BYPASS_FILES = ['bypass.js'];

const openBtn = document.getElementById('open');
const bypassBtn = document.getElementById('bypass');
const errorEl = document.getElementById('error');
const okEl = document.getElementById('ok');

openBtn.addEventListener('click', onOpenClick);
bypassBtn.addEventListener('click', onBypassClick);

/**
 * Получает активную вкладку текущего окна.
 *
 * @returns {Promise<chrome.tabs.Tab>}
 * @throws {Error} — если активная вкладка не найдена.
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Активная вкладка не найдена');
  }
  return tab;
}

/** Сбрасывает текстовые сообщения popup. */
function clearMessages() {
  errorEl.textContent = '';
  okEl.textContent = '';
}

/**
 * Обработчик клика по основной кнопке popup.
 * Внедряет контент-скрипты в активную вкладку, открывая диалог.
 *
 * @returns {Promise<void>}
 */
async function onOpenClick() {
  clearMessages();
  openBtn.disabled = true;
  const originalText = openBtn.textContent;
  openBtn.textContent = 'Открываю…';

  try {
    const tab = await getActiveTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: DIALOG_FILES
    });
    window.close();
  } catch (err) {
    openBtn.disabled = false;
    openBtn.textContent = originalText;
    errorEl.textContent = 'Не удалось открыть: ' + (err && err.message || String(err));
  }
}

/**
 * Обработчик кнопки «Снять защиту от копирования».
 * Внедряет в активную вкладку только `bypass.js`.
 *
 * @returns {Promise<void>}
 */
async function onBypassClick() {
  clearMessages();
  bypassBtn.disabled = true;
  const originalText = bypassBtn.textContent;
  bypassBtn.textContent = 'Снимаю защиту…';

  try {
    const tab = await getActiveTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: BYPASS_FILES
    });
    bypassBtn.textContent = originalText;
    bypassBtn.disabled = false;
    okEl.textContent = '✓ Защита снята до перезагрузки страницы';
  } catch (err) {
    bypassBtn.disabled = false;
    bypassBtn.textContent = originalText;
    errorEl.textContent = 'Не удалось снять защиту: ' + (err && err.message || String(err));
  }
}
