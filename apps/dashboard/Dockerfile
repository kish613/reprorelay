FROM node:24-alpine AS build
WORKDIR /app
ARG VITE_REPRORELAY_API_URL=http://localhost:4000
ENV VITE_REPRORELAY_API_URL=$VITE_REPRORELAY_API_URL
COPY package.json package-lock.json* ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/browser-sdk/package.json packages/browser-sdk/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run build -w @reprorelay/shared \
  && npm run build -w @reprorelay/browser-sdk \
  && npm run build -w @reprorelay/dashboard

FROM nginx:1.27-alpine
ENV PORT=8080
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
COPY apps/dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
