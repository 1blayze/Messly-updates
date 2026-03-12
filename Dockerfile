FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

EXPOSE 8080

CMD ["npm", "run", "start:gateway"]
