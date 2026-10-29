# One Cloud Run service: the Next.js app, which also runs the PDF → spec pipeline.
FROM node:24-slim AS build
RUN npm install -g bun@1.4.4
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY scripts/package.json scripts/
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN cd apps/web && bun x next build

FROM node:24-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=8080 STORE_DIR=/tmp/store
WORKDIR /app/apps/web
EXPOSE 8080
CMD ["sh", "-c", "exec node_modules/.bin/next start -p ${PORT}"]
