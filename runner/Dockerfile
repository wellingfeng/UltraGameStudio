# FreeUltraCode Remote Runner — self-hosted cloud execution backend.
# The image bundles git + the runner; mount your agent CLIs (claude/codex/gemini)
# or install them in a derived image as needed.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV FUC_RUNNER_HOST=0.0.0.0 \
    FUC_RUNNER_PORT=8787 \
    FUC_RUNNER_WORKDIR=/data/workspaces \
    FUC_RUNNER_DATADIR=/data/state

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "src/server.mjs"]
