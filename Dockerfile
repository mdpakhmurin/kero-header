FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/migrate.mjs scripts/stop.mjs ./scripts/
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/auth/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
