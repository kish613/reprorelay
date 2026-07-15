FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent-adapters/package.json packages/agent-adapters/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run build -w @reprorelay/shared \
  && npm run build -w @reprorelay/agent-adapters \
  && npm run build -w @reprorelay/github \
  && npm run build -w @reprorelay/worker

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/apps/worker/package.json apps/worker/package.json
COPY --from=build /app/packages/agent-adapters/package.json packages/agent-adapters/package.json
COPY --from=build /app/packages/github/package.json packages/github/package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/agent-adapters/dist packages/agent-adapters/dist
COPY --from=build /app/packages/github/dist packages/github/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
CMD ["node", "apps/worker/dist/worker.js"]
