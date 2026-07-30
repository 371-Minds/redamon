FROM python:3.11-slim

WORKDIR /app

# Install Docker CLI for container management and curl for healthcheck
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    docker.io \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY *.py ./
# Shipped memory profile (per-scan-type envelopes). Compose bind-mounts the source
# dir over /app anyway, but baking it in keeps the image correct on its own; the
# host-specific resource_profile.json is gitignored and layers on top at runtime.
COPY resource_profile.default.json ./

# Run the FastAPI application
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8010"]
