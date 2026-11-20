# Редактор обложек

**Соберите обложку из любимых кадров.**

Снимки из VK и с вашего устройства складываются в коллаж. Автоматическая раскладка собирает композицию, а ручное редактирование позволяет вывести нужные кадры на первый план.

Обложку можно сохранить в PNG или сразу установить в сообщество VK. 

**Попробуйте деморежим без регистрации.** Фотографии и все настройки остаются в вашем браузере.

## Как запустить

**Обычный запуск** — нужен Node.js 22.13 или новее:

| Система | Запуск | Остановка |
| --- | --- | --- |
| Windows | Двойной клик `launch/local/windows/start.cmd` | `launch/local/windows/stop.cmd` |
| Linux | `sh launch/local/linux/start.sh` | `sh launch/local/linux/stop.sh` |

**Через Docker** — нужен запущенный Docker с Compose (в Windows — Docker Desktop):

| Система | Запуск | Остановка |
| --- | --- | --- |
| Windows | Двойной клик `launch/docker/windows/start.cmd` | `launch/docker/windows/stop.cmd` |
| Linux | `sh launch/docker/linux/start.sh` | `sh launch/docker/linux/stop.sh` |

Откройте **http://localhost:3210**. Остановка сохраняет фотографии и настройки. Перед запуском другим способом остановите уже работающий редактор.

**Демо для GitHub Pages:** выполните `npm run build:demo` и опубликуйте папку `dist/demo/`. Для автоматической публикации из `main` выберите в настройках репозитория **Pages → Source → GitHub Actions**. Локальный просмотр демо: `npm run preview:demo`, адрес **http://localhost:3212**.
