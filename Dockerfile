# One image runs three roles: migrate, web (Next.js), worker (background jobs).
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --chown=app:app package.json tsconfig.json next.config.ts drizzle.config.ts ./
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app src ./src
COPY --chown=app:app scripts ./scripts
USER app
EXPOSE 3000
CMD ["npm", "run", "start"]
