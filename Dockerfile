ARG NODE_BUILD_IMAGE=node:22-alpine
ARG NODE_RUNTIME_IMAGE=node:22-alpine

FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_RUNTIME_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
EXPOSE 4200
CMD ["node", "dist/main.js"]
