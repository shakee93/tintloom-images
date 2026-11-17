FROM node:22-alpine
WORKDIR /app
COPY plugins ./plugins
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
USER node
CMD ["node", "plugins/tintloom/server/tintloom-mcp.mjs", "--http"]
