FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# cap heap so gc runs before the container limit
ENV NODE_OPTIONS=--max-old-space-size=128
# fewer malloc arenas for sharp
ENV MALLOC_ARENA_MAX=2

CMD ["node", "node_modules/.bin/hubot", "--name", "donbot", "--adapter", "@hubot-friends/hubot-discord"]
