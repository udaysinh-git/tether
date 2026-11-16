# Runs the Tether MCP server over stdio. Without the browser extension paired it
# still starts and lists its tools, which is what MCP directories check.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY host ./host
COPY skills ./skills
ENV TETHER_HOME=/data
ENTRYPOINT ["node", "host/cli.js"]
