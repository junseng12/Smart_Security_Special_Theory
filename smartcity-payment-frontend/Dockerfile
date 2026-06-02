# Stage 1: 빌드
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: nginx로 정적 서빙
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# SPA fallback — 모든 경로를 index.html로
RUN echo 'server { \n  listen 3000; \n  root /usr/share/nginx/html; \n  index index.html; \n  location / { \n    try_files $uri $uri/ /index.html; \n  } \n}' > /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
