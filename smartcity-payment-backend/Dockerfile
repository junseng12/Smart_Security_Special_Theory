FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

RUN echo "cache bust: 1781587706"
COPY . .

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/index.js"]
