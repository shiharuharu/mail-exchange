#!/bin/bash
set -e

IMAGE_NAME="mail-exchange"
TAG="${1:-latest}"

echo "Building ${IMAGE_NAME}:${TAG}..."
docker build -t ${IMAGE_NAME}:${TAG} .

echo "Done! Run with:"
echo "  docker compose up -d"
