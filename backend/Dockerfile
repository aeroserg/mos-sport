FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY eslint.config.mjs ./
COPY src ./src

RUN npm install && npm run build && npm prune --omit=dev

ENV PORT=4003
ENV SQLITE_PATH=/data/mos-sport.sqlite
EXPOSE 4003

CMD ["npm", "start"]
