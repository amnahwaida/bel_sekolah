# Dockerfile (diperbarui)
FROM node:20-alpine

RUN apk add --no-cache alsa-utils ffmpeg

WORKDIR /app

# Salin package.json ke /app (bukan ke ./app/package.json)
COPY package*.json ./

RUN npm install --omit=dev

# Salin SEMUA file (termasuk app/, music/, dll)
COPY . .

# Pastikan direktori data & musik ada
RUN mkdir -p music data

EXPOSE 3000

CMD ["node", "app/server.js"]
