FROM golang:1.23-alpine AS mammoth-builder

WORKDIR /src
COPY vendor/mammoth/go.mod vendor/mammoth/go.sum ./
RUN go mod download
COPY vendor/mammoth ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/mammoth ./cmd/mammoth

FROM node:20-alpine AS app-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime

RUN apk add --no-cache tini netcat-openbsd
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=app-builder /app/node_modules ./node_modules
COPY --from=app-builder /app/dist ./dist
COPY --from=mammoth-builder /out/mammoth /usr/local/bin/mammoth
COPY docker/start-container.sh /usr/local/bin/start-container.sh

RUN chmod +x /usr/local/bin/start-container.sh \
  && mkdir -p /data/mammoth /app/data /app/logs

ENV NODE_ENV=production
ENV PANEL_HOST=0.0.0.0
ENV MAMMOTH_ENABLED=true
ENV MAMMOTH_URI=mongodb://127.0.0.1:27017
ENV MAMMOTH_DATABASE=feedledger

EXPOSE 8897 27017 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/start-container.sh"]
