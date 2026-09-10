FROM node:22-alpine

WORKDIR /app
COPY package.json index.js ./

ENV NODE_ENV=production
EXPOSE 8932

CMD ["node", "index.js"]
