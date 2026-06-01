# ── 빌드 스테이지 ────────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

RUN apk add --no-cache git gcc musl-dev linux-headers curl unzip

RUN curl -sLO https://github.com/protocolbuffers/protobuf/releases/download/v27.0/protoc-27.0-linux-x86_64.zip \
    && unzip protoc-27.0-linux-x86_64.zip -d /usr/local \
    && rm protoc-27.0-linux-x86_64.zip

RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.6 \
    && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# ★ 캐시 무효화 — bgclient.go SubscribeNewHead fix
RUN echo "bust-1780310348"

RUN protoc --go_out=. --go_opt=paths=source_relative \
           --go-grpc_out=. --go-grpc_opt=paths=source_relative \
           proto/smartcity.proto

RUN go build -o /app/smartcity-node ./cmd/main.go

# ── 런타임 스테이지 ──────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/smartcity-node .

EXPOSE 50051

CMD ["./smartcity-node"]
