FROM node:25-bookworm-slim

# ripgrep/poppler/git: what agents reach for when reading PDFs and searching the library.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep poppler-utils tini \
 && rm -rf /var/lib/apt/lists/*

# The `claude` CLI, for logging in once inside the container (`claude`, then /login).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY ui ./ui

# agents/, skills/, memory/, library/ and data/ are bind-mounted from the host checkout
# (docker-compose.yml) so edits from the UI survive rebuilds.
RUN mkdir -p /claude /app/data && chown -R node:node /claude /app
USER node
ENV HOST=0.0.0.0 PORT=4477 CLAUDE_CONFIG_DIR=/claude NODE_ENV=production
EXPOSE 4477
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.ts"]
