# Changelog

Все значимые изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [Semantic Versioning](https://semver.org/lang/ru/).

## [1.1.0] — 2026-04-26

### Добавлено
- **Многоуровневый обход защиты от копирования** — capture-phase listeners,
  сброс inline-обработчиков, CSS-override; вынесено в standalone-модуль
  `bypass.js` для переиспользования popup'ом.
- **Встроенный конвертер форматов** на HTML5 Canvas: PNG / JPEG / WebP с
  качеством 0.92, белой подложкой для JPEG (отсутствие альфа-канала).
- **Параллельное скачивание/конвертация** через `runConcurrent` (4 потока)
  с поддержкой `AbortSignal` и колбэка прогресса.
- **Кнопка «Снять защиту от копирования»** в popup — внедряет `bypass.js`
  без открытия диалога.
- **Расширенный сбор изображений**: псевдо-элементы `::before`/`::after`,
  CSS-маски, border-image, list-style-image, cursor, SVG `<image>`,
  `<object>`, `<embed>`, `<input type="image">`, `<video poster>`,
  Open Graph / Twitter Card / Schema.org / msapplication метатеги,
  `<link rel="icon">` и фавиконки, `blob:` URL (через `fetch + FileReader`).
- **Сортировка** в 5 режимах (размер ↓/↑, имя А-Я/Я-А, исходный порядок).
- **Фильтр по минимальному размеру** (Все / ≥128 / ≥256 / ≥512 / ≥1024 px).
- **Фильтр по типу** (13 категорий: JPEG, PNG, WebP, AVIF, GIF, SVG, BMP,
  TIFF, HEIF, иконки, RAW, прочее).
- **Инверсия выделения** + горячая клавиша `Ctrl+I`.
- **Прогресс-бар** с градиентной анимацией во время операции.
- **Кнопка «Остановить»** для отмены долгих операций.
- **Горячие клавиши**: `Esc`, `Ctrl+A`, `Ctrl+I`, `Enter`, `Ctrl+Enter`,
  `Tab` (focus trap), `Space/Enter` на карточке.
- **Бейджи формата** на превью карточек (PNG, WEBP, AVIF, …).
- **Поддержка `prefers-reduced-motion`** — отключение анимаций.
- **Поддержка `prefers-contrast: more`** — усиленные границы и focus-rings.
- **ARIA-атрибуты** для скринридеров: `role="dialog/checkbox/list/status/progressbar"`,
  `aria-modal`, `aria-checked`, `aria-live`, `aria-label`.
- **Защита от Chrome auto-translate** — `translate="no"` + `lang="ru"` +
  класс `notranslate` на host-элементе.
- **Поддержка 90+ форматов** в `IMAGE_EXTENSIONS`: HEIC, JXL, AVIF, RAW
  всех брендов (Canon CR2/CR3, Nikon NEF, Sony ARW, Hasselblad 3FR,
  Phase One IIQ, RED R3D, Blackmagic BRAW и др.), PSD, EPS, TGA, DDS,
  KTX, JPEG 2000, QOI, FITS, DICOM, и многие другие.
- **`bypass.js`** — отдельный модуль для обхода защиты, идемпотентен.
- **Юнит-тесты** для `runConcurrent`, `classifyFormat`, `sortImages`,
  `filterImages`, `formatBytes` (122 теста суммарно).

### Изменено
- **Полностью пересобран `content.js`** в модульную структуру с
  6 секциями: константы, UI-helpers, collector, converter, dialog, entry.
- **Все строки UI** вынесены в константу `STRINGS` для лёгкой локализации.
- **Защита от TDZ**: внутренние `const` объявлены до `return`.
- **Promise-обёртка `sendMessage`** проверяет `chrome.runtime.lastError`.
- **`background.js`** использует `runConcurrent` для параллельных
  скачиваний (4 потока) — ускорение пакетов на ~4×.
- **`popup.js`** использует общий `bypass.js` (DRY) вместо собственной
  копии bypass-функции.
- **README** — полная документация на русском с оглавлением, таблицами,
  troubleshooting-секцией.

### Исправлено
- **Карточки превью схлопывались в Shadow DOM** на сайтах с агрессивным
  CSS (grabcad.com и др.) — закреплены жёсткие размеры через
  `display: flex !important; flex-direction: column !important;
  min-height: 260px !important` на карточке + `flex: 0 0 180px !important`
  на превью + дублирующий inline-стиль через `setProperty(_, _, 'important')`.
- **TDZ-ошибка**: `const DEFAULT_THUMB_SIZE` оказался после `return` из
  `createDialog()` — переменная никогда не инициализировалась, что
  приводило к зависанию диалога на «Сбор изображений…».
- **Пакетное скачивание открывало N диалогов «Сохранить как…»** —
  теперь параллельность принудительно равна 1 при `saveAs: true`.
- **Утечка `IntersectionObserver`** при закрытии диалога — добавлен
  `disconnect()` в `close()`.
- **Поиск с дебаунсом** — устранена гонка при быстром вводе.
- **Поддержка `prefers-reduced-motion`** теперь отключает все анимации.

## [1.0.0] — 2026-04-25

### Добавлено
- Первая версия расширения.
- Базовое контекстное меню браузера с двумя пунктами.
- Сборщик изображений: `<img>`, `srcset`, `<picture>`, CSS background,
  inline SVG, canvas, Shadow DOM, same-origin iframes.
- Модальный диалог в Shadow DOM с поиском, мультивыбором, превью.
- Manifest V3, минимальные разрешения (`contextMenus`, `downloads`,
  `activeTab`, `scripting`).
- Поддержка Chrome, Edge, Opera, Brave, Firefox 121+.
- Резервный popup для сайтов, блокирующих контекстное меню.
- Юнит-тесты на встроенном `node:test` (57 тестов).

[1.1.0]: ../../releases/tag/v1.1.0
[1.0.0]: ../../releases/tag/v1.0.0
