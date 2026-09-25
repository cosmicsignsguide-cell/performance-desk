# Used only by the Site Watch cron (needs a browser). Daily and hourly syncs run on Render's plain Node runtime.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "src/index.js", "sitewatch"]
