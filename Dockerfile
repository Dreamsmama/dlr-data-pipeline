FROM python:3.12.13-slim-bookworm AS python-runtime

ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
RUN python -m pip install --no-cache-dir --index-url "$PYPI_INDEX_URL" uv==0.11.7 \
    && python --version \
    && uv --version

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PNPM_HOME/bin:$PATH
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV PYTHONUNBUFFERED=1
ENV PYTHONUTF8=1
ENV LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1
ENV LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1

COPY --from=python-runtime /usr/local /usr/local

RUN corepack enable \
    && corepack prepare pnpm@11.19.0 --activate \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && pnpm config set registry https://registry.npmmirror.com \
    && pnpm add --global @larksuite/cli@1.0.88 \
    && node --version \
    && pnpm --version \
    && python3 --version \
    && uv --version \
    && lark-cli --version \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY collectors/ecommerce/package.json collectors/ecommerce/package.json
COPY collectors/internal/package.json collectors/internal/package.json
COPY packages/common/package.json packages/common/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN pnpm config set registry https://registry.npmmirror.com \
    && pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .
ENV API_INTERNAL_URL=http://api:3001
RUN pnpm build

FROM build AS api

ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@dlr/api", "start"]

FROM build AS web

ENV NODE_ENV=production
ENV API_INTERNAL_URL=http://api:3001
EXPOSE 3000
CMD ["pnpm", "--filter", "@dlr/web", "start"]
