FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 3000

# Healthcheck robusto con script dedicado
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node /app/healthcheck.js

CMD ["npm", "start"]
