FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npx", "hubot", "--name", "donbot", "--adapter", "@hubot-friends/hubot-discord"]
