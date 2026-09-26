# Build context: webapp/frontend
# docker buildx build --platform linux/arm64 --build-arg VITE_BACKEND_URL=https://dixvoice.api.gcast.app webapp/frontend

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_BACKEND_URL=https://dixvoice.api.gcast.app
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
