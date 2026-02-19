FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY maps.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# dossier tuiles monté via volume
RUN mkdir -p /app/tiles

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
