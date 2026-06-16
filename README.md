# Mos Sport Registration Helper

Проект разделён на две части:

- frontend в корне репозитория: `React + Vite`
- `backend/`: отдельный `Express` proxy для `api.outdoor.sport.mos.ru`

## Структура

- `src/` — frontend
- `backend/server.js` — backend API proxy
- `backend/Dockerfile` — контейнер backend
- `backend/docker-compose.yml` — compose для сервера
- `Makefile` — общий деплой frontend и backend

## Локальная разработка

Требуется `Node.js 18.18+`.

Установка:

```bash
make install
```

Запуск frontend:

```bash
npm run dev
```

Запуск backend:

```bash
cd backend
npm start
```

По умолчанию frontend ожидает backend на:

```bash
https://mos-sport.explaingpt.ru/api
```

Для локальной разработки можно переопределить:

```bash
VITE_API_BASE_URL=http://localhost:4003/api npm run dev
```

## Backend

Backend слушает порт `4003` и проксирует:

- `GET /api/venues`
- `GET /api/courts`
- `GET /api/availability`
- `POST /api/session`
- `PUT /api/hold`
- `POST /api/sms-send`
- `POST /api/sms-verify`
- `POST /api/confirm`

Healthcheck:

```bash
GET /health
```

## Деплой

### Frontend

Frontend по-прежнему собирается под `gh-pages`.

```bash
make deploy-frontend
```

По умолчанию в сборку будет подставлен backend:

```bash
https://mos-sport.explaingpt.ru/api
```

При необходимости можно переопределить:

```bash
make deploy-frontend FRONTEND_API_URL=https://your-host/api
```

### Backend

Backend деплоится на:

- host: `root@51.250.100.128`
- key: `~/.ssh/id_ed25519`
- remote dir: `/home/admin/mos-sport-backend`
- port: `4003`

Команда:

```bash
make deploy-backend
```

Что делает:

- создаёт `/home/admin/mos-sport-backend`
- копирует `backend/package.json`
- копирует `backend/server.js`
- копирует `backend/Dockerfile`
- копирует `backend/docker-compose.yml`
- выполняет `docker compose up -d --build`

### Полный деплой

```bash
make deploy
```

Это запускает:

- `make deploy-frontend`
- `make deploy-backend`

## Важное ограничение

Если frontend размещён на `GitHub Pages`, он открывается по `HTTPS`.  
Backend-контейнер слушает `4003`, но наружу лучше отдавать его через `HTTPS` reverse proxy на `mos-sport.explaingpt.ru`.

Браузер обычно блокирует такие запросы как mixed content.

Практически это значит:

- нужен `HTTPS` reverse proxy перед backend
