# rebuild trigger: LocalBus 1780305317
# ── 빌드 스테이지 ────────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

RUN apk add --no-cache git gcc musl-dev linux-headers curl unzip

# protoc 설치
RUN curl -sLO https://github.com/protocolbuffers/protobuf/releases/download/v27.0/protoc-27.0-linux-x86_64.zip \
    && unzip protoc-27.0-linux-x86_64.zip -d /usr/local \
    && rm protoc-27.0-linux-x86_64.zip

WORKDIR /app

# 의존성 캐시
COPY go.mod go.sum ./
RUN go mod download

# protoc-gen-go 설치
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.6 \
    && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

# 소스 복사
COPY . .

# proto 컴파일
RUN protoc --go_out=. --go_opt=paths=source_relative \
           --go-grpc_out=. --go-grpc_opt=paths=source_relative \
           proto/smartcity.proto

# 빌드
RUN go build -o /app/smartcity-node ./cmd/main.go

# ── 실행 스테이지 ────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/smartcity-node .

EXPOSE ${GRPC_PORT:-50051}

ENTRYPOINT ["/app/smartcity-node"]
