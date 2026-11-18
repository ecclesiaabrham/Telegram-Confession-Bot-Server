FROM node:24-slim

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/confessions.sqlite3

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data

COPY --chown=node:node bot.js ./
USER node

CMD ["npm", "start"]
