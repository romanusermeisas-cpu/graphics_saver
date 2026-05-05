/**
 * @file bypass.js
 * @description Многоуровневый обход типичных скриптов защиты сайтов
 * от копирования изображений и текста.
 *
 * Скрипт самодостаточен: не зависит от lib.js и других модулей,
 * выполняется как IIFE при загрузке. Идемпотентен — повторное
 * внедрение через `chrome.scripting.executeScript` не вызывает побочных
 * эффектов благодаря флагу `window.__graphicsSaverBypassed`.
 *
 * Загружается двумя путями:
 *   1. Перед `content.js` при открытии диалога (`background.js` →
 *      `executeScript({ files: ['lib.js', 'bypass.js', 'content.js'] })`).
 *   2. Самостоятельно по кнопке «Снять защиту от копирования» в popup
 *      (`popup.js` → `executeScript({ files: ['bypass.js'] })`).
 *
 * Применяемые техники обхода:
 *
 *   • **Capture-phase listeners** на `contextmenu`, `dragstart`,
 *     `selectstart`, `copy`, `cut`, `mousedown`, `mouseup` —
 *     `stopImmediatePropagation()` блокирует обработчики страницы,
 *     но НЕ вызывает `preventDefault()`, чтобы браузерное меню
 *     открывалось как обычно.
 *
 *   • **Сброс inline-обработчиков** `oncontextmenu`, `ondragstart` и др.
 *     на `document`, `<html>`, `<body>` — нейтрализует HTML-атрибуты
 *     вида `<body oncontextmenu="return false">`.
 *
 *   • **CSS-override** через инжектируемый `<style>` с `!important`:
 *     возвращает `user-select: text`, `-webkit-user-drag: auto`,
 *     `-webkit-touch-callout: default`, `pointer-events: auto`
 *     для всех элементов и медиа-тегов.
 *
 * Эффект сохраняется до перезагрузки страницы.
 */

(function () {
  'use strict';

  if (window.__graphicsSaverBypassed) return;
  window.__graphicsSaverBypassed = true;

  /**
   * События, которые типично используются сайтами для блокировки
   * копирования. Перехватываем их в capture-фазе.
   */
  var BLOCKED_EVENTS = [
    'contextmenu',
    'dragstart',
    'selectstart',
    'copy',
    'cut',
    'mousedown',
    'mouseup'
  ];

  /**
   * Останавливает дальнейшее распространение события.
   * `preventDefault()` намеренно не вызывается — иначе браузерное
   * контекстное меню перестанет работать.
   *
   * @param {Event} e
   */
  function stopper(e) {
    e.stopImmediatePropagation();
  }

  // 1. Capture-phase listeners на window и document.
  for (var i = 0; i < BLOCKED_EVENTS.length; i++) {
    var name = BLOCKED_EVENTS[i];
    try {
      window.addEventListener(name, stopper, { capture: true, passive: false });
      document.addEventListener(name, stopper, { capture: true, passive: false });
    } catch (_) { /* некоторые события могут быть недоступны */ }
  }

  // 2. Сброс inline-обработчиков на корневых узлах.
  var roots = [document, document.documentElement, document.body];
  for (var r = 0; r < roots.length; r++) {
    var node = roots[r];
    if (!node) continue;
    for (var e = 0; e < BLOCKED_EVENTS.length; e++) {
      try { node['on' + BLOCKED_EVENTS[e]] = null; } catch (_) {}
    }
  }

  // 3. CSS-override против user-select / pointer-events / drag.
  var STYLE_ID = 'graphics-saver-bypass-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      'html, body, *, *::before, *::after {' +
      '  -webkit-user-select: text !important;' +
      '  -moz-user-select: text !important;' +
      '  -ms-user-select: text !important;' +
      '  user-select: text !important;' +
      '  -webkit-touch-callout: default !important;' +
      '  -webkit-user-drag: auto !important;' +
      '}' +
      'img, picture, svg, canvas, video {' +
      '  -webkit-user-drag: auto !important;' +
      '  pointer-events: auto !important;' +
      '}';
    (document.head || document.documentElement).appendChild(style);
  }
})();
