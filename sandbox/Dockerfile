FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3, git, build essentials, and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    build-essential \
    make \
    gcc \
    g++ \
    python3 \
    python3-pip \
    python3-venv \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Global packages for JS and Python testing
RUN npm install -g pnpm && \
    pip3 install --no-cache-dir --break-system-packages pytest pytest-asyncio

# Configure non-root sandbox user (UID 1000, GID 1000)
RUN usermod -l sandbox node && \
    groupmod -n sandbox node && \
    usermod -d /home/sandbox -m sandbox

# Setup workspace directory
RUN mkdir -p /workspace && chown -R sandbox:sandbox /workspace /home/sandbox

WORKDIR /workspace
USER sandbox

ENV HOME=/home/sandbox \
    PATH=/home/sandbox/.local/bin:/usr/local/bin:$PATH \
    NODE_ENV=development

CMD ["/bin/bash"]

